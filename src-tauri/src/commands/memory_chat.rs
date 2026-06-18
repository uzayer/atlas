//! Memory-Chat — a local RAG chat over a project's indexed memory.
//!
//! Retrieval reuses the existing memory embedding index (`memory_graph`):
//! embed the question with MiniLM, cosine-search the per-project vector store,
//! and pull the matching documents' text from `agent_memory::collect_corpus`.
//! Generation is fully local too — a small quantized Qwen2.5-Instruct model
//! (`atlas_embed::chat`) streams the answer token-by-token. No API key, no
//! network: you talk to the codebase's own recorded memory (features, policies,
//! change logs, agent activity) entirely on-device.
//!
//! Two model downloads gate the feature: MiniLM (shared with Memory ▸ Graph) for
//! retrieval, and the Qwen GGUF for generation. Both are user-triggered.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use atlas_embed::chat::{build_qwen_prompt, QuantizedChatModel};
use atlas_embed::{BruteForce, Embedder, VectorStore};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use super::agent_memory::collect_corpus;
use super::memory_graph::{load_doc_vectors, model_dir, MODEL_FILES};

/// Local generative model — Qwen3-0.6B (Q4) runs on the Apple-Silicon GPU via
/// candle's Metal backend, small + modern, ample for summarizing retrieved memory.
const CHAT_MODEL_DIR: &str = "qwen3-0.6b";
const GGUF_FILE: &str = "Qwen3-0.6B-Q4_K_M.gguf";
const TOKENIZER_FILE: &str = "tokenizer.json";
// Q4_K_M (~470 MB) via the unsloth mirror — the official Qwen3-0.6B-GGUF repo
// only ships Q8_0. Tokenizer comes from the official base repo.
const GGUF_URL: &str = "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf";
const TOKENIZER_URL: &str = "https://huggingface.co/Qwen/Qwen3-0.6B/resolve/main/tokenizer.json";

/// How many memory docs to retrieve as context, and how much of each to keep.
const TOP_K: usize = 10;
const PER_DOC_CHARS: usize = 1200;
/// Generation cap. Generous on Apple Silicon (Metal); revisit per-device later.
const MAX_TOKENS: usize = 1200;
const TEMPERATURE: f64 = 0.6;
/// Recent commits to fold into the RAG context for git-aware questions.
const GIT_LOG_LIMIT: usize = 20;
const GIT_CONTEXT_MAX_CHARS: usize = 2600;

// ── State ────────────────────────────────────────────────────────────────────

/// Caches the loaded models (loading a GGUF / BERT each message would add a
/// multi-second stall) and tracks per-stream cancellation flags.
pub struct MemoryChatState {
    chat: Arc<Mutex<Option<QuantizedChatModel>>>,
    embedder: Arc<Mutex<Option<Embedder>>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl MemoryChatState {
    pub fn new() -> Self {
        Self {
            chat: Arc::new(Mutex::new(None)),
            embedder: Arc::new(Mutex::new(None)),
            cancels: Mutex::new(HashMap::new()),
        }
    }

    /// Shared handle to the cached local chat model, so the codebase indexer can
    /// reuse it for Tier-2 file summaries instead of loading its own.
    pub(crate) fn chat_model(&self) -> Arc<Mutex<Option<QuantizedChatModel>>> {
        self.chat.clone()
    }
}

/// Resolve the downloaded local model's gguf + tokenizer paths, erroring if the
/// model isn't present. Shared with the codebase indexer.
pub(crate) fn local_model_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let dir = chat_model_dir(app)?;
    let gguf = dir.join(GGUF_FILE);
    let tok = dir.join(TOKENIZER_FILE);
    if !gguf.exists() || !tok.exists() {
        return Err("Local chat model is not downloaded.".into());
    }
    Ok((gguf, tok))
}

impl Default for MemoryChatState {
    fn default() -> Self {
        Self::new()
    }
}

fn chat_model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("models")
        .join(CHAT_MODEL_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create chat model dir: {e}"))?;
    Ok(dir)
}

// ── Model download / status ──────────────────────────────────────────────────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatModelStatus {
    pub downloaded: bool,
    pub model: String,
}

#[tauri::command]
pub async fn memory_chat_model_status(app: AppHandle) -> Result<ChatModelStatus, String> {
    let dir = chat_model_dir(&app)?;
    let downloaded = dir.join(GGUF_FILE).exists() && dir.join(TOKENIZER_FILE).exists();
    Ok(ChatModelStatus {
        downloaded,
        model: CHAT_MODEL_DIR.to_string(),
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    file: String,
    file_index: usize,
    file_count: usize,
    received: u64,
    total: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadDone {
    success: bool,
    error: Option<String>,
}

/// Kick off the GGUF + tokenizer download in the background. The frontend listens
/// on `atlas:memory-chat-model:progress` / `:done`. Mirrors `memory_embed_download`.
#[tauri::command]
pub async fn memory_chat_model_download(app: AppHandle) -> Result<(), String> {
    let dir = chat_model_dir(&app)?;
    tokio::spawn(async move {
        let result = download_chat_model(&app, &dir).await;
        let _ = app.emit(
            "atlas:memory-chat-model:done",
            DownloadDone {
                success: result.is_ok(),
                error: result.err(),
            },
        );
    });
    Ok(())
}

async fn download_chat_model(app: &AppHandle, dir: &std::path::Path) -> Result<(), String> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    let client = reqwest::Client::builder()
        .user_agent("Atlas-IDE")
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let files = [(GGUF_URL, GGUF_FILE), (TOKENIZER_URL, TOKENIZER_FILE)];
    for (idx, (url, fname)) in files.iter().enumerate() {
        if dir.join(fname).exists() {
            continue;
        }
        let resp = client
            .get(*url)
            .send()
            .await
            .map_err(|e| format!("GET {fname}: {e}"))?
            .error_for_status()
            .map_err(|e| format!("GET {fname}: {e}"))?;
        let total = resp.content_length().unwrap_or(0);

        let tmp = dir.join(format!("{fname}.part"));
        let mut file = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| format!("create {fname}: {e}"))?;

        let mut received: u64 = 0;
        let mut last_emit: u64 = 0;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("download {fname}: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write {fname}: {e}"))?;
            received += chunk.len() as u64;
            if received - last_emit >= 2_097_152 {
                last_emit = received;
                let _ = app.emit(
                    "atlas:memory-chat-model:progress",
                    DownloadProgress {
                        file: fname.to_string(),
                        file_index: idx,
                        file_count: files.len(),
                        received,
                        total,
                    },
                );
            }
        }
        file.flush().await.map_err(|e| format!("flush {fname}: {e}"))?;
        drop(file);
        tokio::fs::rename(&tmp, dir.join(fname))
            .await
            .map_err(|e| format!("finalize {fname}: {e}"))?;
        let _ = app.emit(
            "atlas:memory-chat-model:progress",
            DownloadProgress {
                file: fname.to_string(),
                file_index: idx,
                file_count: files.len(),
                received,
                total: total.max(received),
            },
        );
    }
    Ok(())
}

/// Warm-load the downloaded chat model into the cached state. Used by the
/// "Install model" flow to surface a "Loading Model" step (and to make the first
/// message instant). No-op if already loaded; errors if not downloaded.
#[tauri::command]
pub async fn memory_chat_model_load(
    app: AppHandle,
    state: State<'_, MemoryChatState>,
) -> Result<(), String> {
    let cm_dir = chat_model_dir(&app)?;
    let gguf_path = cm_dir.join(GGUF_FILE);
    let tok_path = cm_dir.join(TOKENIZER_FILE);
    if !gguf_path.exists() || !tok_path.exists() {
        return Err("Local chat model is not downloaded.".into());
    }
    let chat_arc = state.chat.clone();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut guard = chat_arc.lock();
        if guard.is_none() {
            let m = QuantizedChatModel::load(&gguf_path, &tok_path)
                .map_err(|e| format!("load chat model: {e}"))?;
            *guard = Some(m);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("model load join: {e}"))?
}

// ── Chat streaming ───────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct WireMsg {
    pub role: String,
    pub content: String,
}

/// Retrieval-time metadata for a corpus document (title/source/path + full text).
struct DocMeta {
    title: String,
    source: String,
    file_path: Option<String>,
    text: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SourceRef {
    id: String,
    title: String,
    source: String,
    score: f32,
    /// Absolute path of the underlying file (memory `.md` or codebase file), so
    /// the UI can open it. `None` for sources with no backing file (e.g. Codex
    /// threads).
    file_path: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum ChatEvent {
    Sources { sources: Vec<SourceRef> },
    TextDelta { delta: String },
    Done,
    Error { message: String },
}

#[derive(Serialize, Clone)]
struct ChatEnvelope {
    stream_id: String,
    #[serde(flatten)]
    event: ChatEvent,
}

fn emit(app: &AppHandle, stream_id: &str, event: ChatEvent) {
    let _ = app.emit(
        "atlas:memory-chat",
        ChatEnvelope {
            stream_id: stream_id.to_string(),
            event,
        },
    );
}

const SYSTEM_PREAMBLE: &str = "You are Atlas's memory assistant. Answer the user's question about THIS codebase using only the project memory context provided below. The context contains the project's recorded knowledge: features, policies, change logs, coding-agent activity, and recent git history. Be concise and specific, cite concrete details, and if the context doesn't cover the question say so plainly rather than inventing an answer.";

/// Recent git history as an extra context block — lets the RAG answer questions
/// about commits and (file-level) authorship that the embedded memory docs miss.
fn git_context(project_path: &str) -> String {
    let log = Command::new("git")
        .args([
            "-C",
            project_path,
            "log",
            &format!("-{GIT_LOG_LIMIT}"),
            "--date=short",
            "--pretty=format:commit %h (%ad) by %an: %s",
            "--name-status",
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if log.is_empty() {
        return String::new();
    }
    let mut log = log;
    if log.len() > GIT_CONTEXT_MAX_CHARS {
        log.truncate(GIT_CONTEXT_MAX_CHARS);
        log.push('…');
    }
    let branch = Command::new("git")
        .args(["-C", project_path, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    format!(
        "## Recent git history (current branch: {branch})\nEach entry is a commit and the files it changed (A=added, M=modified, D=deleted, R=renamed).\n{log}\n\n"
    )
}

/// Run one RAG turn: retrieve from the memory index, then stream a local answer.
#[tauri::command]
pub async fn memory_chat_send(
    app: AppHandle,
    stream_id: String,
    project_path: String,
    messages: Vec<WireMsg>,
    state: State<'_, MemoryChatState>,
) -> Result<(), String> {
    let pp = project_path.trim_end_matches('/').to_string();

    let query = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();
    if query.trim().is_empty() {
        return Ok(());
    }

    // Preconditions: both models present, index built.
    let embed_dir = model_dir(&app)?;
    if !MODEL_FILES.iter().all(|f| embed_dir.join(f).exists()) {
        emit(&app, &stream_id, ChatEvent::Error {
            message: "Download the embedding model first (Memory ▸ Graph).".into(),
        });
        return Ok(());
    }
    let cm_dir = chat_model_dir(&app)?;
    let gguf_path = cm_dir.join(GGUF_FILE);
    let tok_path = cm_dir.join(TOKENIZER_FILE);
    if !gguf_path.exists() || !tok_path.exists() {
        emit(&app, &stream_id, ChatEvent::Error {
            message: "Download the local chat model first.".into(),
        });
        return Ok(());
    }

    let vmap = load_doc_vectors(&pp);
    if vmap.is_empty() {
        emit(&app, &stream_id, ChatEvent::Error {
            message: "No memory index yet — build it in Memory ▸ Graph first.".into(),
        });
        return Ok(());
    }

    // Corpus (async) holds the document texts keyed by id.
    let corpus = collect_corpus(&pp).await;
    let mut texts: HashMap<String, DocMeta> = HashMap::new();
    for d in &corpus {
        texts.insert(
            d.id.clone(),
            DocMeta {
                title: d.title.clone(),
                source: d.source.clone(),
                file_path: d.file_path.clone(),
                text: d.text.clone(),
            },
        );
    }
    let git_ctx = git_context(&pp);

    // Register a cancellation flag for this stream.
    let cancel = Arc::new(AtomicBool::new(false));
    state.cancels.lock().insert(stream_id.clone(), cancel.clone());

    let chat_arc = state.chat.clone();
    let embedder_arc = state.embedder.clone();
    let turns: Vec<(String, String)> = messages
        .into_iter()
        .filter(|m| m.role == "user" || m.role == "assistant")
        .map(|m| (m.role, m.content))
        .collect();

    let app_bg = app.clone();
    let sid = stream_id.clone();
    let _ = tokio::task::spawn_blocking(move || {
        // 1. Embed the query (lazy-load + cache MiniLM).
        let qv = {
            let mut guard = embedder_arc.lock();
            if guard.is_none() {
                match Embedder::load(&embed_dir) {
                    Ok(e) => *guard = Some(e),
                    Err(e) => {
                        emit(&app_bg, &sid, ChatEvent::Error { message: format!("load embedder: {e}") });
                        return;
                    }
                }
            }
            match guard.as_ref().unwrap().embed_one(&query) {
                Ok(v) => v,
                Err(e) => {
                    emit(&app_bg, &sid, ChatEvent::Error { message: format!("embed query: {e}") });
                    return;
                }
            }
        };

        // 2. Cosine-search the index.
        let mut ids: Vec<String> = Vec::with_capacity(vmap.len());
        let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(vmap.len());
        for (id, v) in vmap {
            ids.push(id);
            vectors.push(v);
        }
        let store = BruteForce::new(vectors);
        let hits = store.search(&qv, TOP_K);

        // 3. Assemble retrieved context + source list.
        let mut sources: Vec<SourceRef> = Vec::new();
        let mut context = String::new();
        for (i, score) in &hits {
            let id = &ids[*i];
            if let Some(d) = texts.get(id) {
                let mut snippet = d.text.trim().to_string();
                if snippet.len() > PER_DOC_CHARS {
                    snippet.truncate(PER_DOC_CHARS);
                    snippet.push('…');
                }
                context.push_str(&format!("## {} (source: {})\n{snippet}\n\n", d.title, d.source));
                sources.push(SourceRef {
                    id: id.clone(),
                    title: d.title.clone(),
                    source: d.source.clone(),
                    score: *score,
                    file_path: d.file_path.clone(),
                });
            }
        }
        context.push_str(&git_ctx);
        emit(&app_bg, &sid, ChatEvent::Sources { sources });

        // 4. Build the chat prompt and stream the answer.
        let system = format!("{SYSTEM_PREAMBLE}\n\n--- PROJECT MEMORY CONTEXT ---\n{context}");
        let prompt = build_qwen_prompt(&system, &turns);

        let mut guard = chat_arc.lock();
        if guard.is_none() {
            match QuantizedChatModel::load(&gguf_path, &tok_path) {
                Ok(m) => *guard = Some(m),
                Err(e) => {
                    emit(&app_bg, &sid, ChatEvent::Error { message: format!("load chat model: {e}") });
                    return;
                }
            }
        }
        let model = guard.as_mut().unwrap();
        let cancel_chk = cancel.clone();
        let app_tok = app_bg.clone();
        let sid_tok = sid.clone();
        let result = model.generate(
            &prompt,
            MAX_TOKENS,
            TEMPERATURE,
            |delta| emit(&app_tok, &sid_tok, ChatEvent::TextDelta { delta: delta.to_string() }),
            || cancel_chk.load(Ordering::Relaxed),
        );
        match result {
            Ok(_) => emit(&app_bg, &sid, ChatEvent::Done),
            Err(e) => emit(&app_bg, &sid, ChatEvent::Error { message: format!("generate: {e}") }),
        }
    })
    .await;

    state.cancels.lock().remove(&stream_id);
    Ok(())
}

#[tauri::command]
pub fn memory_chat_cancel(stream_id: String, state: State<'_, MemoryChatState>) {
    if let Some(flag) = state.cancels.lock().get(&stream_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetrieveResult {
    /// The full RAG-augmented user prompt (preamble + retrieved context + question)
    /// to send as the final user turn when generating with a BYOK provider.
    prompt: String,
    sources: Vec<SourceRef>,
}

/// Provider-mode retrieval: embed the query, search the memory index, and return
/// a ready-to-send augmented prompt + the sources. Generation then happens via
/// the existing `modelchat_stream` (BYOK), so no local chat model is required —
/// only the embedding model + a built index.
#[tauri::command]
pub async fn memory_chat_retrieve(
    app: AppHandle,
    project_path: String,
    query: String,
    state: State<'_, MemoryChatState>,
) -> Result<RetrieveResult, String> {
    let pp = project_path.trim_end_matches('/').to_string();
    if query.trim().is_empty() {
        return Err("empty query".into());
    }

    let embed_dir = model_dir(&app)?;
    if !MODEL_FILES.iter().all(|f| embed_dir.join(f).exists()) {
        return Err("Download the embedding model first (Memory ▸ Graph).".into());
    }
    let vmap = load_doc_vectors(&pp);
    if vmap.is_empty() {
        return Err("No memory index yet — build it in Memory ▸ Graph first.".into());
    }

    let corpus = collect_corpus(&pp).await;
    let mut texts: HashMap<String, DocMeta> = HashMap::new();
    for d in &corpus {
        texts.insert(
            d.id.clone(),
            DocMeta {
                title: d.title.clone(),
                source: d.source.clone(),
                file_path: d.file_path.clone(),
                text: d.text.clone(),
            },
        );
    }
    let git_ctx = git_context(&pp);

    let embedder_arc = state.embedder.clone();
    let q = query.clone();
    let (context, sources) = tokio::task::spawn_blocking(
        move || -> Result<(String, Vec<SourceRef>), String> {
            let qv = {
                let mut guard = embedder_arc.lock();
                if guard.is_none() {
                    let e = Embedder::load(&embed_dir).map_err(|e| format!("load embedder: {e}"))?;
                    *guard = Some(e);
                }
                guard
                    .as_ref()
                    .unwrap()
                    .embed_one(&q)
                    .map_err(|e| format!("embed query: {e}"))?
            };
            let mut ids: Vec<String> = Vec::with_capacity(vmap.len());
            let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(vmap.len());
            for (id, v) in vmap {
                ids.push(id);
                vectors.push(v);
            }
            let store = BruteForce::new(vectors);
            let hits = store.search(&qv, TOP_K);
            let mut sources: Vec<SourceRef> = Vec::new();
            let mut context = String::new();
            for (i, score) in &hits {
                let id = &ids[*i];
                if let Some(d) = texts.get(id) {
                    let mut snippet = d.text.trim().to_string();
                    if snippet.len() > PER_DOC_CHARS {
                        snippet.truncate(PER_DOC_CHARS);
                        snippet.push('…');
                    }
                    context.push_str(&format!("## {} (source: {})\n{snippet}\n\n", d.title, d.source));
                    sources.push(SourceRef {
                        id: id.clone(),
                        title: d.title.clone(),
                        source: d.source.clone(),
                        score: *score,
                        file_path: d.file_path.clone(),
                    });
                }
            }
            context.push_str(&git_ctx);
            Ok((context, sources))
        },
    )
    .await
    .map_err(|e| format!("retrieve join: {e}"))??;

    let prompt = format!(
        "{SYSTEM_PREAMBLE}\n\n--- PROJECT MEMORY CONTEXT ---\n{context}\n\n--- QUESTION ---\n{query}"
    );
    Ok(RetrieveResult { prompt, sources })
}
