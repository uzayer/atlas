use crate::types::*;
use anyhow::Result;
use reqwest::Client;
use serde_json::{json, Value};

pub async fn chat(req: &ChatRequest) -> Result<ChatResponse> {
    match req.provider {
        Provider::Anthropic => anthropic_chat(req).await,
        Provider::OpenAI => openai_chat(req).await,
        Provider::Google => google_chat(req).await,
    }
}

async fn anthropic_chat(req: &ChatRequest) -> Result<ChatResponse> {
    let client = Client::new();
    let messages: Vec<Value> = req
        .messages
        .iter()
        .map(|m| json!({"role": m.role, "content": m.content}))
        .collect();

    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "max_tokens": req.max_tokens.unwrap_or(4096),
    });

    if let Some(ref system) = req.system {
        body["system"] = json!(system);
    }
    if let Some(temp) = req.temperature {
        body["temperature"] = json!(temp);
    }

    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &req.api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    let status = resp.status();
    let text = resp.text().await?;

    if !status.is_success() {
        anyhow::bail!("Anthropic API error ({}): {}", status, text);
    }

    let v: Value = serde_json::from_str(&text)?;
    let content = v["content"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|block| block["text"].as_str())
        .unwrap_or("")
        .to_string();

    let usage = if let (Some(input), Some(output)) = (
        v["usage"]["input_tokens"].as_u64(),
        v["usage"]["output_tokens"].as_u64(),
    ) {
        Some(Usage {
            input_tokens: input as u32,
            output_tokens: output as u32,
        })
    } else {
        None
    };

    Ok(ChatResponse {
        content,
        model: v["model"].as_str().unwrap_or(&req.model).to_string(),
        usage,
        stop_reason: v["stop_reason"].as_str().map(|s| s.to_string()),
    })
}

async fn openai_chat(req: &ChatRequest) -> Result<ChatResponse> {
    let client = Client::new();
    let mut messages: Vec<Value> = Vec::new();

    if let Some(ref system) = req.system {
        messages.push(json!({"role": "system", "content": system}));
    }
    for m in &req.messages {
        messages.push(json!({"role": m.role, "content": m.content}));
    }

    let mut body = json!({
        "model": req.model,
        "messages": messages,
    });

    if let Some(max) = req.max_tokens {
        body["max_tokens"] = json!(max);
    }
    if let Some(temp) = req.temperature {
        body["temperature"] = json!(temp);
    }

    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", req.api_key))
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    let status = resp.status();
    let text = resp.text().await?;

    if !status.is_success() {
        anyhow::bail!("OpenAI API error ({}): {}", status, text);
    }

    let v: Value = serde_json::from_str(&text)?;
    let content = v["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let usage = if let (Some(input), Some(output)) = (
        v["usage"]["prompt_tokens"].as_u64(),
        v["usage"]["completion_tokens"].as_u64(),
    ) {
        Some(Usage {
            input_tokens: input as u32,
            output_tokens: output as u32,
        })
    } else {
        None
    };

    Ok(ChatResponse {
        content,
        model: v["model"].as_str().unwrap_or(&req.model).to_string(),
        usage,
        stop_reason: v["choices"][0]["finish_reason"]
            .as_str()
            .map(|s| s.to_string()),
    })
}

async fn google_chat(req: &ChatRequest) -> Result<ChatResponse> {
    let client = Client::new();
    let contents: Vec<Value> = req
        .messages
        .iter()
        .map(|m| {
            let role = if m.role == "assistant" { "model" } else { "user" };
            json!({
                "role": role,
                "parts": [{"text": m.content}]
            })
        })
        .collect();

    let mut body = json!({ "contents": contents });

    if let Some(ref system) = req.system {
        body["systemInstruction"] = json!({
            "parts": [{"text": system}]
        });
    }

    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{}:generateContent?key={}",
        req.model, req.api_key
    );

    let resp = client
        .post(&url)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    let status = resp.status();
    let text = resp.text().await?;

    if !status.is_success() {
        anyhow::bail!("Google API error ({}): {}", status, text);
    }

    let v: Value = serde_json::from_str(&text)?;
    let content = v["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .unwrap_or("")
        .to_string();

    let usage = if let (Some(input), Some(output)) = (
        v["usageMetadata"]["promptTokenCount"].as_u64(),
        v["usageMetadata"]["candidatesTokenCount"].as_u64(),
    ) {
        Some(Usage {
            input_tokens: input as u32,
            output_tokens: output as u32,
        })
    } else {
        None
    };

    Ok(ChatResponse {
        content,
        model: req.model.clone(),
        usage,
        stop_reason: v["candidates"][0]["finishReason"]
            .as_str()
            .map(|s| s.to_string()),
    })
}
