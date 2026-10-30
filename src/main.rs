mod faker;
mod runner;
mod schema;
mod seed;

use std::{path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result, anyhow};
use clap::{Parser, ValueEnum};
use serde_json::Value;
use sqlx::PgPool;

/// Load test one Hack Western tRPC route with fake payloads.
#[derive(Parser)]
struct Args {
    /// tRPC route to hit, e.g. application.get
    #[arg(long)]
    route: String,

    /// Who the virtual users log in as. Logging in seeds one test user per
    /// virtual user into DATABASE_URL and deletes them afterwards.
    #[arg(long, value_enum, default_value_t = Auth::None)]
    auth: Auth,

    /// Number of concurrent virtual users
    #[arg(long, default_value_t = 10)]
    vus: usize,

    /// How long to run, e.g. 30s or 2m
    #[arg(long, default_value = "30s", value_parser = humantime::parse_duration)]
    duration: Duration,

    /// Base URL of the deployment under test
    #[arg(long, default_value = "http://localhost:3000")]
    url: String,

    /// OpenAPI export of the tRPC router
    #[arg(long, default_value = "api.json")]
    schema: PathBuf,
}

#[derive(Clone, Copy, ValueEnum)]
enum Auth {
    #[value(alias = "n")]
    None,
    #[value(alias = "y")]
    Hacker,
    #[value(alias = "o")]
    Organizer,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let raw = std::fs::read_to_string(&args.schema)
        .with_context(|| format!("reading {}", args.schema.display()))?;
    let openapi: Value = serde_json::from_str(&raw)?;
    let route = schema::Route::load(&openapi, &args.route)?;
    let base = args.url.trim_end_matches('/');

    let user_type = match args.auth {
        Auth::None => None,
        Auth::Hacker => Some("hacker"),
        Auth::Organizer => Some("organizer"),
    };
    let seeded = match user_type {
        None => None,
        Some(user_type) => {
            let url = std::env::var("DATABASE_URL")
                .context("DATABASE_URL must be set to seed test users")?;
            let pool = PgPool::connect(&url).await?;
            println!("Adding {} test {user_type}s...", args.vus);
            let users = seed::seed(&pool, args.vus, user_type).await?;
            Some((pool, users))
        }
    };
    let users = seeded
        .as_ref()
        .map(|(_, users)| users.as_slice())
        .unwrap_or_default();

    println!(
        "Load testing {} for {:?} with {} virtual users",
        args.route, args.duration, args.vus
    );
    let result = tokio::select! {
        result = runner::run(base, Arc::new(route), Arc::new(openapi), args.vus, args.duration, users) => result,
        _ = tokio::signal::ctrl_c() => Err(anyhow!("interrupted")),
    };

    // Clean up even when the run failed or was interrupted.
    if let Some((pool, users)) = &seeded {
        println!("Removing test users...");
        seed::remove(pool, users).await?;
    }

    result?.print();
    Ok(())
}
