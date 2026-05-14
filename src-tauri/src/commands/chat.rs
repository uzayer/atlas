use atlas_agents::{ChatRequest, ChatResponse, Message, Provider};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ChatSendRequest {
    pub provider: String,
    pub model: String,
    pub api_key: String,
    pub messages: Vec<MessagePayload>,
    pub system: Option<String>,
}

#[derive(Deserialize)]
pub struct MessagePayload {
    pub role: String,
    pub content: String,
}

#[tauri::command]
pub async fn chat_send(req: ChatSendRequest) -> Result<ChatResponse, String> {
    let provider = match req.provider.as_str() {
        "anthropic" => Provider::Anthropic,
        "openai" => Provider::OpenAI,
        "google" => Provider::Google,
        other => return Err(format!("Unknown provider: {}", other)),
    };

    let messages: Vec<Message> = req
        .messages
        .into_iter()
        .map(|m| Message {
            role: m.role,
            content: m.content,
        })
        .collect();

    let chat_req = ChatRequest {
        provider,
        model: req.model,
        api_key: req.api_key,
        messages,
        max_tokens: Some(4096),
        temperature: None,
        system: req.system,
    };

    atlas_agents::chat(&chat_req)
        .await
        .map_err(|e| e.to_string())
}
