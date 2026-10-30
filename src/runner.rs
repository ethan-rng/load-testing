use std::{
    collections::BTreeMap,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use reqwest::{Client, redirect::Policy};
use serde_json::{Value, json};
use tokio::task::JoinSet;

use crate::{
    faker::Faker,
    schema::{Method, Route},
    seed::{PASSWORD, TestUser},
};

/// Runs `vus` virtual users against the route until `duration` is up. With
/// `users`, virtual user N logs in as `users[N]` before its first request.
pub async fn run(
    base: &str,
    route: Arc<Route>,
    openapi: Arc<Value>,
    vus: usize,
    duration: Duration,
    users: &[TestUser],
) -> Result<Report> {
    let start = Instant::now();
    let deadline = start + duration;
    let mut set = JoinSet::new();
    for vu in 0..vus {
        set.spawn(virtual_user(
            base.to_string(),
            route.clone(),
            openapi.clone(),
            users.get(vu).cloned(),
            deadline,
        ));
    }

    let mut report = Report::default();
    while let Some(result) = set.join_next().await {
        report.merge(result??);
    }
    report.elapsed = start.elapsed();
    Ok(report)
}

async fn virtual_user(
    base: String,
    route: Arc<Route>,
    openapi: Arc<Value>,
    user: Option<TestUser>,
    deadline: Instant,
) -> Result<Report> {
    let client = Client::builder()
        .cookie_store(true)
        .redirect(Policy::none())
        .timeout(Duration::from_secs(60))
        .build()?;
    if let Some(user) = &user {
        login(&client, &base, user).await?;
    }

    let faker = Faker::new(&openapi);
    let url = format!("{base}/api/trpc/{}", route.name);
    let mut report = Report::default();

    while Instant::now() < deadline {
        // tRPC here uses superjson, which wraps the input as {"json": ...}.
        let body = match &route.input {
            Some(schema) => json!({ "json": faker.fake(schema)? }),
            None => json!({}),
        };
        let request = match route.method {
            Method::Query => client.get(&url).query(&[("input", body.to_string())]),
            Method::Mutation => client.post(&url).json(&body),
        };

        let sent = Instant::now();
        match request.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let _ = response.bytes().await;
                report.latencies.push(sent.elapsed());
                *report.statuses.entry(status).or_default() += 1;
            }
            Err(_) => report.failed += 1,
        }
    }
    Ok(report)
}

/// Logs in through next-auth's credentials provider; the session cookie
/// stays in the client's cookie store.
async fn login(client: &Client, base: &str, user: &TestUser) -> Result<()> {
    let csrf: Value = client
        .get(format!("{base}/api/auth/csrf"))
        .send()
        .await?
        .json()
        .await?;
    let token = csrf["csrfToken"]
        .as_str()
        .context("no next-auth csrf token")?;

    client
        .post(format!("{base}/api/auth/callback/credentials"))
        .form(&[
            ("username", user.email.as_str()),
            ("password", PASSWORD),
            ("csrfToken", token),
            ("json", "true"),
        ])
        .send()
        .await?;

    let session: Value = client
        .get(format!("{base}/api/auth/session"))
        .send()
        .await?
        .json()
        .await?;
    if session.get("user").is_none() {
        bail!("couldn't log in as {}", user.email);
    }
    Ok(())
}

#[derive(Default)]
pub struct Report {
    latencies: Vec<Duration>,
    statuses: BTreeMap<u16, usize>,
    /// Requests that never got a response (connection errors, timeouts)
    failed: usize,
    elapsed: Duration,
}

impl Report {
    fn merge(&mut self, other: Report) {
        self.latencies.extend(other.latencies);
        for (status, count) in other.statuses {
            *self.statuses.entry(status).or_default() += count;
        }
        self.failed += other.failed;
    }

    pub fn print(mut self) {
        let total = self.latencies.len();
        if total == 0 {
            println!("no requests completed ({} failed)", self.failed);
            return;
        }
        self.latencies.sort();
        let ok = self.statuses.get(&200).copied().unwrap_or(0);
        let percentile = |p: f64| self.latencies[((total - 1) as f64 * p).round() as usize];

        println!(
            "requests  {total} ({:.1}/s), {:.1}% status 200, {} failed",
            total as f64 / self.elapsed.as_secs_f64(),
            100.0 * ok as f64 / total as f64,
            self.failed,
        );
        println!(
            "latency   p50 {:?}  p90 {:?}  p95 {:?}  p99 {:?}  max {:?}",
            percentile(0.5),
            percentile(0.9),
            percentile(0.95),
            percentile(0.99),
            self.latencies[total - 1],
        );
        let statuses: Vec<String> = self
            .statuses
            .iter()
            .map(|(s, n)| format!("{s}: {n}"))
            .collect();
        println!("statuses  {}", statuses.join("  "));
    }
}
