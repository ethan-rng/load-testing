use anyhow::Result;
use sqlx::PgPool;
use uuid::Uuid;

/// Every test user logs in with this.
pub const PASSWORD: &str = "ThisIsAStrongPassword1!";

#[derive(Clone)]
pub struct TestUser {
    pub id: String,
    pub email: String,
}

/// Inserts `count` users of `user_type` (hacker or organizer).
pub async fn seed(pool: &PgPool, count: usize, user_type: &str) -> Result<Vec<TestUser>> {
    // They all share one password, so one hash covers everyone.
    let hash = bcrypt::hash(PASSWORD, 10)?;
    let users: Vec<TestUser> = (0..count)
        .map(|_| {
            let id = Uuid::new_v4().to_string();
            TestUser {
                email: format!("load-test-{id}@example.com"),
                id,
            }
        })
        .collect();

    let mut tx = pool.begin().await?;
    for user in &users {
        sqlx::query(
            r#"INSERT INTO "user" (id, name, email, password, type) VALUES ($1, 'Load Test', $2, $3, $4::user_type)"#,
        )
        .bind(&user.id)
        .bind(&user.email)
        .bind(&hash)
        .bind(user_type)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(users)
}

pub async fn remove(pool: &PgPool, users: &[TestUser]) -> Result<()> {
    let ids: Vec<String> = users.iter().map(|u| u.id.clone()).collect();
    sqlx::query(r#"DELETE FROM "user" WHERE id = ANY($1)"#)
        .bind(&ids)
        .execute(pool)
        .await?;
    Ok(())
}
