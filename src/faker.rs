use anyhow::{Context, Result, bail};
use rand::{RngExt, distr::Alphanumeric, seq::IndexedRandom};
use serde_json::{Map, Value, json};

/// Generates fake values matching a JSON Schema, resolving `$ref`s against
/// the OpenAPI document they came from.
pub struct Faker<'a> {
    openapi: &'a Value,
}

impl<'a> Faker<'a> {
    pub fn new(openapi: &'a Value) -> Self {
        Faker { openapi }
    }

    pub fn fake(&self, schema: &Value) -> Result<Value> {
        let mut rng = rand::rng();

        if let Some(reference) = schema["$ref"].as_str() {
            let target = self
                .openapi
                .pointer(reference.trim_start_matches('#'))
                .with_context(|| format!("unresolved $ref {reference}"))?;
            return self.fake(target);
        }
        if let Some(options) = schema["enum"].as_array() {
            return options.choose(&mut rng).cloned().context("empty enum");
        }
        if let Some(variants) = schema["anyOf"].as_array() {
            return self.fake(variants.choose(&mut rng).context("empty anyOf")?);
        }

        match schema["type"].as_str() {
            Some("object") => self.object(schema),
            Some("array") => {
                let min = schema["minItems"].as_u64().unwrap_or(0);
                let max = schema["maxItems"].as_u64().unwrap_or(min + 3);
                (0..rng.random_range(min..=max))
                    .map(|_| self.fake(&schema["items"]))
                    .collect()
            }
            Some("string") => string(schema),
            Some("number" | "integer") => {
                let min = schema["minimum"].as_f64().unwrap_or(0.0) as i64;
                let max = schema["maximum"].as_f64().unwrap_or(100.0) as i64;
                Ok(json!(rng.random_range(min..=max)))
            }
            Some("boolean") => Ok(json!(rng.random::<bool>())),
            Some("null") => Ok(Value::Null),
            other => bail!("can't fake schema type {other:?}"),
        }
    }

    fn object(&self, schema: &Value) -> Result<Value> {
        let required = schema["required"].as_array();
        let mut object = Map::new();
        for (field, field_schema) in schema["properties"].as_object().into_iter().flatten() {
            let is_required = required.is_some_and(|r| r.iter().any(|f| f == field));
            // Optional fields show up about half the time.
            if !is_required && rand::random_bool(0.5) {
                continue;
            }
            // Fields the server validates harder than the schema says get
            // hand-written values instead.
            let value = match field.as_str() {
                "email" => json!(email()),
                "password" => json!(password()),
                _ => self
                    .fake(field_schema)
                    .with_context(|| format!("field {field} could not be faked"))?,
            };
            object.insert(field.clone(), value);
        }
        Ok(Value::Object(object))
    }
}

fn string(schema: &Value) -> Result<Value> {
    if schema["format"] == "email" {
        return Ok(json!(email()));
    }
    if let Some(pattern) = schema["pattern"].as_str() {
        let regex = rand_regex::Regex::compile(pattern, 20)
            .with_context(|| format!("can't generate strings for pattern {pattern}"))?;
        return Ok(json!(rand::rng().sample::<String, _>(&regex)));
    }
    let min = schema["minLength"].as_u64().unwrap_or(1);
    let max = schema["maxLength"].as_u64().unwrap_or(min + 20);
    Ok(json!(alphanumeric(rand::random_range(min..=max) as usize)))
}

fn alphanumeric(len: usize) -> String {
    rand::rng()
        .sample_iter(Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

fn email() -> String {
    format!("{}@example.com", alphanumeric(10).to_lowercase())
}

/// Meets the sign-up rules: 8+ characters with an uppercase letter, a
/// number and a symbol.
fn password() -> String {
    format!("{}Aa1!", alphanumeric(8))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::Route;

    /// Every route in the bundled schema should fake payloads its own input
    /// schema accepts.
    #[test]
    fn fakes_valid_input_for_every_route() {
        let openapi: Value = serde_json::from_str(include_str!("../api.json")).unwrap();
        let faker = Faker::new(&openapi);

        for path in openapi["paths"].as_object().unwrap().keys() {
            let name = path.trim_start_matches("/api/").replace('/', ".");
            let route = Route::load(&openapi, &name).unwrap();
            let Some(input) = route.input else { continue };

            // Carry the components along so the validator can follow $refs.
            let mut schema = input.clone();
            schema["components"] = openapi["components"].clone();
            let validator = jsonschema::validator_for(&schema).unwrap();

            for _ in 0..50 {
                let payload = faker.fake(&input).unwrap();
                assert!(validator.is_valid(&payload), "{name}: {payload}");
            }
        }
    }
}
