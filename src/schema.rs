use anyhow::{Context, Result, bail};
use serde_json::{Map, Value, json};

pub enum Method {
    Query,
    Mutation,
}

/// One tRPC procedure as described by the trpc-to-openapi export.
pub struct Route {
    pub name: String,
    pub method: Method,
    /// JSON Schema of the procedure input, None for mutations without input
    pub input: Option<Value>,
}

impl Route {
    pub fn load(openapi: &Value, name: &str) -> Result<Self> {
        let path = format!("/api/{}", name.replace('.', "/"));
        let ops = openapi["paths"]
            .get(&path)
            .with_context(|| format!("route {path} is not in the schema"))?;

        if let Some(get) = ops.get("get") {
            // Queries arrive as query params, one per input field, so put
            // them back together into the object the procedure takes.
            let mut properties = Map::new();
            let mut required = vec![];
            for param in get["parameters"].as_array().into_iter().flatten() {
                let field = param["name"].as_str().context("parameter without a name")?;
                properties.insert(field.into(), param["schema"].clone());
                if param["required"] == true {
                    required.push(field);
                }
            }
            Ok(Route {
                name: name.into(),
                method: Method::Query,
                input: Some(
                    json!({ "type": "object", "properties": properties, "required": required }),
                ),
            })
        } else if let Some(post) = ops.get("post") {
            Ok(Route {
                name: name.into(),
                method: Method::Mutation,
                input: post
                    .pointer("/requestBody/content/application~1json/schema")
                    .cloned(),
            })
        } else {
            bail!("{path} has neither a get nor a post operation")
        }
    }
}
