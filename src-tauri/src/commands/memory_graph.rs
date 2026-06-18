//! `memory_graph` — on-device semantic index + graph map over agent memory.
//!
//! Pipeline: `agent_memory::collect_corpus` → embed each doc with a local
//! BERT sentence-transformer (`atlas-embed`, candle) → cache vectors on disk →
//! build a similarity graph (kNN edges) augmented with explicit `[[wikilink]]`
//! edges → answer natural-language queries by embedding the query and ranking.
//!
//! The model (`all-MiniLM-L6-v2`, ~90 MB) is downloaded on demand into the
//! global app-data dir; the per-project vector index lives in `.atlas/`.

use std::path::PathBuf;

use atlas_embed::{BruteForce, Embedder, VectorStore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

use super::agent_memory::{collect_corpus, MemoryDoc};

const MODEL_NAME: &str = "all-MiniLM-L6-v2";
const HF_BASE: &str =
    "https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2/resolve/main";
pub(crate) const MODEL_FILES: [&str; 3] = ["config.json", "tokenizer.json", "model.safetensors"];

/// kNN fan-out per node when building similarity edges.
const TOPK: usize = 4;
/// Minimum cosine for a similarity edge to be drawn.
const SIM_THRESHOLD: f32 = 0.35;

// ── Model location + status ─────────────────────────────────────────────────

pub(crate) fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?
        .join("models")
        .join(MODEL_NAME);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create model dir: {e}"))?;
    Ok(dir)
}

#[derive(Debug, Serialize)]
pub struct EmbedStatus {
    downloaded: bool,
    model: String,
    model_dir: String,
}

#[tauri::command]
pub async fn memory_embed_status(app: AppHandle) -> Result<EmbedStatus, String> {
    let dir = model_dir(&app)?;
    let downloaded = MODEL_FILES.iter().all(|f| dir.join(f).exists());
    Ok(EmbedStatus {
        downloaded,
        model: MODEL_NAME.to_string(),
        model_dir: dir.to_string_lossy().to_string(),
    })
}

// ── Download (streamed, with throttled progress events) ─────────────────────

#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    file: String,
    file_index: usize,
    file_count: usize,
    received: u64,
    total: u64,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadDone {
    success: bool,
    error: Option<String>,
}

/// Kicks off the model download in the background and returns immediately. The
/// frontend listens for `atlas:memory-embed:progress` and `:done`.
#[tauri::command]
pub async fn memory_embed_download(app: AppHandle) -> Result<(), String> {
    let dir = model_dir(&app)?;
    tokio::spawn(async move {
        let result = download_model(&app, &dir).await;
        let _ = app.emit(
            "atlas:memory-embed:done",
            DownloadDone {
                success: result.is_ok(),
                error: result.err(),
            },
        );
    });
    Ok(())
}

async fn download_model(app: &AppHandle, dir: &std::path::Path) -> Result<(), String> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    let client = reqwest::Client::builder()
        .user_agent("Atlas-IDE")
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    for (idx, fname) in MODEL_FILES.iter().enumerate() {
        let url = format!("{HF_BASE}/{fname}");
        let resp = client
            .get(&url)
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
            let chunk = chunk.map_err(|e| format!("stream {fname}: {e}"))?;
            file.write_all(&chunk)
                .await
                .map_err(|e| format!("write {fname}: {e}"))?;
            received += chunk.len() as u64;
            // Throttle: emit at most ~every 1 MB (and always at the end below).
            if received - last_emit >= 1_048_576 {
                last_emit = received;
                let _ = app.emit(
                    "atlas:memory-embed:progress",
                    DownloadProgress {
                        file: fname.to_string(),
                        file_index: idx,
                        file_count: MODEL_FILES.len(),
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

        // Final per-file progress tick (received == total).
        let _ = app.emit(
            "atlas:memory-embed:progress",
            DownloadProgress {
                file: fname.to_string(),
                file_index: idx,
                file_count: MODEL_FILES.len(),
                received,
                total: total.max(received),
            },
        );
    }
    Ok(())
}

// ── On-disk vector index (per project) ──────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredDoc {
    id: String,
    hash: String,
    vector: Vec<f32>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredIndex {
    model: String,
    dim: usize,
    docs: Vec<StoredDoc>,
}

fn index_dir(project_path: &str) -> PathBuf {
    std::path::Path::new(project_path)
        .join(".atlas")
        .join("memory-index")
}

fn index_path(project_path: &str) -> PathBuf {
    index_dir(project_path).join("index.json")
}

fn load_index(project_path: &str) -> StoredIndex {
    std::fs::read_to_string(index_path(project_path))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The graph's per-doc embeddings as `doc id → vector`, so other features (the
/// policy table) can reuse the already-built index instead of re-embedding.
/// Empty if the graph index hasn't been built yet.
pub(crate) fn load_doc_vectors(project_path: &str) -> std::collections::HashMap<String, Vec<f32>> {
    load_index(project_path)
        .docs
        .into_iter()
        .map(|d| (d.id, d.vector))
        .collect()
}

fn save_index(project_path: &str, index: &StoredIndex) -> Result<(), String> {
    let dir = index_dir(project_path);
    std::fs::create_dir_all(&dir).map_err(|e| format!("create index dir: {e}"))?;
    let json = serde_json::to_string(index).map_err(|e| e.to_string())?;
    std::fs::write(index_path(project_path), json).map_err(|e| format!("write index: {e}"))
}

fn hash_text(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

/// Text actually fed to the embedder — title gives short docs useful signal.
fn embed_text(doc: &MemoryDoc) -> String {
    if doc.text.trim().is_empty() {
        doc.title.clone()
    } else {
        format!("{}\n\n{}", doc.title, doc.text)
    }
}

// ── Graph build ─────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct GraphNode {
    id: String,
    title: String,
    /// Natural-language one-liner for display (falls back to title).
    summary: String,
    kind: String,
    source: String,
    snippet: String,
    degree: usize,
    /// Unix ms this memory was created (0 if unknown). Drives the temporal view.
    #[serde(rename = "timestampMs")]
    timestamp_ms: i64,
}

#[derive(Debug, Serialize)]
pub struct GraphEdge {
    /// Oriented older → newer: `from` is the earlier memory that plausibly
    /// influenced the later `to`. Lets the UI trace impact forward in time.
    from: String,
    to: String,
    weight: f32,
    kind: String, // "similarity" | "link"
}

#[derive(Debug, Serialize)]
pub struct MemoryGraph {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    dim: usize,
    doc_count: usize,
}

/// Build (or incrementally refresh) the vector index for the project's memory
/// and return the similarity graph. Errors with `"model-not-downloaded"` if the
/// embedding model isn't present yet (the frontend gates on that).
#[tauri::command]
pub async fn memory_index_build(app: AppHandle, project_path: String) -> Result<MemoryGraph, String> {
    let dir = model_dir(&app)?;
    let model_ready = MODEL_FILES.iter().all(|f| dir.join(f).exists());
    if !model_ready {
        return Err("model-not-downloaded".into());
    }

    let docs = collect_corpus(&project_path).await;
    if docs.is_empty() {
        return Ok(MemoryGraph {
            nodes: vec![],
            edges: vec![],
            dim: 0,
            doc_count: 0,
        });
    }

    let cache = load_index(&project_path);
    let pp = project_path.clone();

    tokio::task::spawn_blocking(move || build_graph_blocking(dir, pp, docs, cache))
        .await
        .map_err(|e| format!("index task: {e}"))?
}

fn build_graph_blocking(
    model_dir: PathBuf,
    project_path: String,
    docs: Vec<MemoryDoc>,
    cache: StoredIndex,
) -> Result<MemoryGraph, String> {
    use std::collections::HashMap;

    // Reuse cached vectors for unchanged docs (keyed by content hash).
    let cached: HashMap<String, Vec<f32>> =
        cache.docs.into_iter().map(|d| (d.hash, d.vector)).collect();

    let hashes: Vec<String> = docs.iter().map(|d| hash_text(&embed_text(d))).collect();
    let need_embed = hashes.iter().any(|h| !cached.contains_key(h));

    let embedder = if need_embed {
        Some(Embedder::load(&model_dir).map_err(|e| format!("load model: {e}"))?)
    } else {
        None
    };

    let mut vectors: Vec<Vec<f32>> = Vec::with_capacity(docs.len());
    let mut dim = cache.dim;
    for (doc, hash) in docs.iter().zip(hashes.iter()) {
        if let Some(v) = cached.get(hash) {
            dim = v.len();
            vectors.push(v.clone());
        } else {
            let v = embedder
                .as_ref()
                .unwrap()
                .embed_one(&embed_text(doc))
                .map_err(|e| format!("embed: {e}"))?;
            dim = v.len();
            vectors.push(v);
        }
    }

    // Persist the refreshed index.
    let stored = StoredIndex {
        model: MODEL_NAME.to_string(),
        dim,
        docs: docs
            .iter()
            .zip(hashes.iter())
            .zip(vectors.iter())
            .map(|((d, h), v)| StoredDoc {
                id: d.id.clone(),
                hash: h.clone(),
                vector: v.clone(),
            })
            .collect(),
    };
    let _ = save_index(&project_path, &stored);

    // ── Edges ──────────────────────────────────────────────────────────────
    let id_of: Vec<&str> = docs.iter().map(|d| d.id.as_str()).collect();
    // alias → node index, for resolving [[wikilinks]].
    let mut alias_to_idx: HashMap<String, usize> = HashMap::new();
    for (i, d) in docs.iter().enumerate() {
        for a in &d.aliases {
            if !a.is_empty() {
                alias_to_idx.insert(a.to_lowercase(), i);
            }
        }
    }

    // Dedup undirected edges by ordered (min,max) pair; explicit links win.
    let mut edge_map: HashMap<(usize, usize), (f32, &'static str)> = HashMap::new();
    let key = |a: usize, b: usize| if a < b { (a, b) } else { (b, a) };

    // Similarity (kNN) edges.
    let store = BruteForce::new(vectors.clone());
    for (i, neighbors) in store.all_pairs_topk(TOPK).into_iter().enumerate() {
        for (j, score) in neighbors {
            if score < SIM_THRESHOLD {
                continue;
            }
            edge_map
                .entry(key(i, j))
                .or_insert((score, "similarity"));
        }
    }
    // Explicit wikilink edges (override similarity for that pair).
    for (i, d) in docs.iter().enumerate() {
        for link in &d.links {
            if let Some(&j) = alias_to_idx.get(&link.to_lowercase()) {
                if i != j {
                    edge_map.insert(key(i, j), (1.0, "link"));
                }
            }
        }
    }

    // Degree per node from the final edge set.
    let mut degree = vec![0usize; docs.len()];
    for &(a, b) in edge_map.keys() {
        degree[a] += 1;
        degree[b] += 1;
    }

    let nodes: Vec<GraphNode> = docs
        .iter()
        .enumerate()
        .map(|(i, d)| GraphNode {
            id: d.id.clone(),
            title: d.title.clone(),
            summary: if d.summary.trim().is_empty() {
                d.title.clone()
            } else {
                d.summary.clone()
            },
            kind: d.kind.clone(),
            source: d.source.clone(),
            snippet: snippet(&d.text),
            degree: degree[i],
            timestamp_ms: d.timestamp_ms,
        })
        .collect();

    // Orient each edge older → newer so the UI can trace influence forward in
    // time. Unknown timestamps (0) sort oldest; ties break by index for stability.
    let ts: Vec<i64> = docs.iter().map(|d| d.timestamp_ms).collect();
    let edges: Vec<GraphEdge> = edge_map
        .into_iter()
        .map(|((a, b), (w, k))| {
            let (older, newer) = if (ts[a], a) <= (ts[b], b) { (a, b) } else { (b, a) };
            GraphEdge {
                from: id_of[older].to_string(),
                to: id_of[newer].to_string(),
                weight: w,
                kind: k.to_string(),
            }
        })
        .collect();

    Ok(MemoryGraph {
        doc_count: nodes.len(),
        dim,
        nodes,
        edges,
    })
}

fn snippet(s: &str) -> String {
    let collapsed: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() > 240 {
        let head: String = collapsed.chars().take(240).collect();
        format!("{head}…")
    } else {
        collapsed
    }
}

// ── Query ───────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct QueryHit {
    id: String,
    score: f32,
}

/// Embed `query` and rank the project's indexed memory docs against it.
#[tauri::command]
pub async fn memory_index_query(
    app: AppHandle,
    project_path: String,
    query: String,
    top_k: Option<usize>,
) -> Result<Vec<QueryHit>, String> {
    let dir = model_dir(&app)?;
    if !MODEL_FILES.iter().all(|f| dir.join(f).exists()) {
        return Err("model-not-downloaded".into());
    }
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    let index = load_index(&project_path);
    if index.docs.is_empty() {
        return Ok(vec![]);
    }
    let k = top_k.unwrap_or(10);

    tokio::task::spawn_blocking(move || -> Result<Vec<QueryHit>, String> {
        let embedder = Embedder::load(&dir).map_err(|e| format!("load model: {e}"))?;
        let qv = embedder.embed_one(&q).map_err(|e| format!("embed query: {e}"))?;
        let ids: Vec<String> = index.docs.iter().map(|d| d.id.clone()).collect();
        let vectors: Vec<Vec<f32>> = index.docs.into_iter().map(|d| d.vector).collect();
        let store = BruteForce::new(vectors);
        Ok(store
            .search(&qv, k)
            .into_iter()
            .map(|(i, score)| QueryHit {
                id: ids[i].clone(),
                score,
            })
            .collect())
    })
    .await
    .map_err(|e| format!("query task: {e}"))?
}

// ── Graph layout persistence (mirrors knowledge_graph_layout.rs) ────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pos {
    x: f64,
    y: f64,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct GraphLayout {
    positions: std::collections::HashMap<String, Pos>,
}

fn layout_path(project_path: &str) -> PathBuf {
    std::path::Path::new(project_path)
        .join(".atlas")
        .join("memory-graph-layout.json")
}

#[tauri::command]
pub async fn memory_graph_layout_load(project_path: String) -> Result<GraphLayout, String> {
    Ok(std::fs::read_to_string(layout_path(&project_path))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default())
}

#[tauri::command]
pub async fn memory_graph_layout_save(
    project_path: String,
    layout: GraphLayout,
) -> Result<(), String> {
    let path = layout_path(&project_path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create .atlas: {e}"))?;
    }
    let json = serde_json::to_string(&layout).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("write layout: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("finalize layout: {e}"))
}
