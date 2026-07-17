//! Projections of the (`#[non_exhaustive]`, unstable-gated) ACP schema response
//! types into the flat JSON-friendly shapes the Atlas host + UI consume.

use agent_client_protocol::schema::v1::{NewSessionResponse, SessionId};
use serde::Serialize;

/// Public view of a newly created session — what gets returned to the UI.
/// `NewSessionResponse` from the schema is `#[non_exhaustive]`, so we project
/// the bits we actually want to expose.
#[derive(Debug, Clone, Serialize)]
pub struct NewSessionInfo {
    pub session_id: SessionId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modes: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<serde_json::Value>,
}

impl From<NewSessionResponse> for NewSessionInfo {
    fn from(resp: NewSessionResponse) -> Self {
        // Round-trip via serde_json so we don't have to hand-port every nested
        // schema type (modes / models / config_options are all `non_exhaustive`
        // and gated on unstable features). The TS side already speaks JSON.
        let modes = resp.modes.as_ref().and_then(|m| serde_json::to_value(m).ok());
        // ACP 1.x: model selection lives entirely in `config_options` (a
        // `SessionConfigOption` with id/category "model") — the dedicated
        // `models` blob was removed. Normalise it into the
        // `{ currentModelId, availableModels }` shape the rest of the pipeline +
        // the UI expect; selection is pushed via `session/set_config_option`.
        let models = serde_json::to_value(&resp.config_options)
            .ok()
            .and_then(|co| model_blob_from_config_options(&co));
        Self {
            session_id: resp.session_id,
            modes,
            models,
        }
    }
}

/// Normalise a `config_options` array into a `SessionModelState`-shaped JSON
/// blob (`{ currentModelId, availableModels: [{modelId,name,description}] }`) by
/// finding the `select` option with id/category "model". Returns `None` if
/// there's no model option (so the caller falls through to "no models"). Handles
/// both ungrouped and grouped option lists.
fn model_blob_from_config_options(config_options: &serde_json::Value) -> Option<serde_json::Value> {
    let arr = config_options.as_array()?;
    let opt = arr.iter().find(|o| {
        o.get("id").and_then(|v| v.as_str()) == Some("model")
            || o.get("category").and_then(|v| v.as_str()) == Some("model")
    })?;
    let current = opt.get("currentValue").and_then(|v| v.as_str())?.to_string();
    // `options` is either an array of `{value,name,description}` (ungrouped) or
    // an array of `{group,name,options:[...]}` (grouped) — flatten both.
    let raw = opt.get("options").and_then(|v| v.as_array())?;
    let mut available: Vec<serde_json::Value> = Vec::new();
    for item in raw {
        let leaves = if item.get("value").is_some() {
            std::slice::from_ref(item).to_vec()
        } else if let Some(group) = item.get("options").and_then(|v| v.as_array()) {
            group.clone()
        } else {
            Vec::new()
        };
        for o in leaves {
            let Some(value) = o.get("value").and_then(|v| v.as_str()) else {
                continue;
            };
            let name = o.get("name").and_then(|v| v.as_str()).unwrap_or(value);
            let description = o.get("description").and_then(|v| v.as_str());
            available.push(serde_json::json!({
                "modelId": value,
                "name": name,
                "description": description,
            }));
        }
    }
    if available.is_empty() {
        return None;
    }
    Some(serde_json::json!({
        "currentModelId": current,
        "availableModels": available,
    }))
}
