use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct KnowledgeEntry {
    pub id: String,
    pub title: String,
    pub content: String,
    pub source: String, // "note", "paper", "chat", "interaction"
    pub file_path: String,
    pub updated_at: String,
}

/// List all knowledge entries recursively from .atlas/knowledge/
#[tauri::command]
pub fn list_knowledge(project_path: String) -> Result<Vec<KnowledgeEntry>, String> {
    let kb_dir = Path::new(&project_path).join(".atlas").join("knowledge");
    if !kb_dir.exists() {
        return Ok(vec![]);
    }

    let mut entries = Vec::new();
    walk_knowledge(&kb_dir, &kb_dir, &mut entries);
    entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(entries)
}

fn walk_knowledge(dir: &Path, root: &Path, entries: &mut Vec<KnowledgeEntry>) {
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };

    for entry in read.flatten() {
        let path = entry.path();

        if path.is_dir() {
            walk_knowledge(&path, root, entries);
            continue;
        }

        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }

        let content = match fs::read_to_string(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        // Use relative path (without .md) as the ID so nested notes work
        let rel = path.strip_prefix(root).unwrap_or(&path);
        let id = rel.with_extension("").to_string_lossy().to_string();

        let filename = path.file_stem().unwrap_or_default().to_string_lossy().to_string();

        let title = content.lines()
            .find(|l| l.starts_with('#'))
            .map(|l| l.trim_start_matches('#').trim().to_string())
            .unwrap_or_else(|| filename.clone());

        let source = if filename.starts_with("paper-") { "paper" }
            else if filename.starts_with("chat-") { "chat" }
            else { "note" };

        let updated_at = fs::metadata(&path).ok()
            .and_then(|m| m.modified().ok())
            .map(|t| {
                let d = t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
                chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                    .map(|dt| dt.to_rfc3339()).unwrap_or_default()
            }).unwrap_or_default();

        entries.push(KnowledgeEntry {
            id,
            title,
            content,
            source: source.to_string(),
            file_path: path.to_string_lossy().to_string(),
            updated_at,
        });
    }
}

/// Save a knowledge note (supports nested paths like "Adib/note-123")
#[tauri::command]
pub fn save_knowledge_note(
    project_path: String,
    id: String,
    content: String,
) -> Result<String, String> {
    let kb_dir = Path::new(&project_path).join(".atlas").join("knowledge");
    let filepath = kb_dir.join(format!("{}.md", id));
    // Create parent dirs for nested paths
    if let Some(parent) = filepath.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&filepath, &content).map_err(|e| e.to_string())?;

    Ok(filepath.to_string_lossy().to_string())
}

/// Delete a knowledge note
#[tauri::command]
pub fn delete_knowledge_note(
    project_path: String,
    id: String,
) -> Result<(), String> {
    let filepath = Path::new(&project_path)
        .join(".atlas")
        .join("knowledge")
        .join(format!("{}.md", id));

    if filepath.exists() {
        fs::remove_file(&filepath).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Create a directory inside .atlas/knowledge/
#[tauri::command]
pub fn create_knowledge_dir(project_path: String, dir_name: String) -> Result<(), String> {
    let dir = Path::new(&project_path).join(".atlas").join("knowledge").join(&dir_name);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

/// Append an interaction log entry for context building
#[tauri::command]
pub fn log_interaction(
    project_path: String,
    interaction_type: String, // "chat", "search", "edit", "paper_save", "note_edit"
    summary: String,
) -> Result<(), String> {
    let atlas_dir = Path::new(&project_path).join(".atlas");
    fs::create_dir_all(&atlas_dir).map_err(|e| e.to_string())?;

    let log_path = atlas_dir.join("interactions.jsonl");
    let entry = serde_json::json!({
        "type": interaction_type,
        "summary": summary,
        "timestamp": chrono::Utc::now().to_rfc3339(),
    });

    let mut line = serde_json::to_string(&entry).unwrap_or_default();
    line.push('\n');

    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .and_then(|mut f| {
            use std::io::Write;
            f.write_all(line.as_bytes())
        })
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Get recent interactions for context building
#[tauri::command]
pub fn get_recent_interactions(
    project_path: String,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    let log_path = Path::new(&project_path).join(".atlas").join("interactions.jsonl");
    if !log_path.exists() {
        return Ok(vec![]);
    }

    let content = fs::read_to_string(&log_path).map_err(|e| e.to_string())?;
    let lines: Vec<String> = content.lines().map(|l| l.to_string()).collect();
    let n = limit.unwrap_or(20) as usize;
    let start = if lines.len() > n { lines.len() - n } else { 0 };

    Ok(lines[start..].to_vec())
}

/// Save editor state (open tabs, active file) per project
#[tauri::command]
pub fn save_editor_state(
    project_path: String,
    state_json: String,
) -> Result<(), String> {
    let atlas_dir = Path::new(&project_path).join(".atlas");
    fs::create_dir_all(&atlas_dir).map_err(|e| e.to_string())?;

    let state_path = atlas_dir.join("editor-state.json");
    fs::write(&state_path, &state_json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Load editor state for a project
#[tauri::command]
pub fn load_editor_state(project_path: String) -> Result<String, String> {
    let state_path = Path::new(&project_path).join(".atlas").join("editor-state.json");
    if state_path.exists() {
        fs::read_to_string(&state_path).map_err(|e| e.to_string())
    } else {
        Ok("{}".to_string())
    }
}

/// Fetch a URL and return text-only sanitized HTML (no media, no external CSS)
#[tauri::command]
pub async fn fetch_readable(url: String) -> Result<ReadableContent, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .unwrap_or_default();

    let response = client.get(&url).send().await
        .map_err(|e| format!("Fetch failed: {}", e))?;

    let final_url = response.url().to_string();
    let html = response.text().await
        .map_err(|e| format!("Read failed: {}", e))?;

    let title = extract_html_title(&html).unwrap_or_else(|| url.clone());
    let sanitized = sanitize_html(&html, &final_url);

    Ok(ReadableContent {
        title,
        url: final_url,
        html: sanitized,
    })
}

#[derive(Debug, serde::Serialize)]
pub struct ReadableContent {
    pub title: String,
    pub url: String,
    pub html: String,
}

fn extract_html_title(html: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let start = lower.find("<title")?;
    let gt = html[start..].find('>')? + start + 1;
    let end = lower[gt..].find("</title")? + gt;
    Some(html[gt..end].trim().to_string())
}

fn strip_style_attributes(html: &str) -> String {
    // Use regex-like find/replace on the string level (safe for multi-byte UTF-8)
    let mut result = html.to_string();
    loop {
        let lower = result.to_lowercase();
        // Find style=" or style='
        let pos = if let Some(p) = lower.find("style=\"") {
            Some((p, '"', 7))
        } else if let Some(p) = lower.find("style='") {
            Some((p, '\'', 7))
        } else {
            None
        };

        if let Some((start, quote, offset)) = pos {
            if let Some(end) = result[start + offset..].find(quote) {
                // Remove style="..." including trailing space
                let remove_end = start + offset + end + 1;
                let remove_end = if result.as_bytes().get(remove_end) == Some(&b' ') { remove_end + 1 } else { remove_end };
                result = format!("{}{}", &result[..start], &result[remove_end..]);
                continue;
            }
        }
        break;
    }
    result
}

/// Sanitize HTML: remove dangerous tags, media, styles. Resolve link URLs. Text-only content.
fn sanitize_html(html: &str, base_url: &str) -> String {
    let lower = html.to_lowercase();

    let body = find_body(html, &lower).unwrap_or_else(|| html.to_string());

    // Remove: scripts, styles, media, interactive, nav chrome
    let cleaned = remove_tags(&body, &[
        "script", "style", "noscript", "iframe", "object", "embed", "form",
        "img", "video", "audio", "picture", "figure", "canvas", "svg",
        "nav", "footer", "aside", "dialog", "template",
    ]);

    // Resolve relative URLs in href attributes so links work
    let base = base_url.trim_end_matches(|c: char| c != '/').to_string();
    let origin = extract_origin(base_url);
    let resolved = resolve_urls(&cleaned, &base, &origin);

    // Strip all inline style attributes
    strip_style_attributes(&resolved)
}

fn remove_tags(html: &str, tags: &[&str]) -> String {
    let mut result = html.to_string();
    for tag in tags {
        let open = format!("<{}", tag);
        let close = format!("</{}>", tag);
        loop {
            let rl = result.to_lowercase();
            if let Some(start) = rl.find(&open) {
                if let Some(end) = rl[start..].find(&close) {
                    result = format!("{}{}", &result[..start], &result[start + end + close.len()..]);
                    continue;
                } else {
                    // Self-closing or unclosed — remove just the tag
                    if let Some(gt) = rl[start..].find('>') {
                        result = format!("{}{}", &result[..start], &result[start + gt + 1..]);
                        continue;
                    }
                }
            }
            break;
        }
    }
    result
}

fn extract_origin(url: &str) -> String {
    // https://example.com/path -> https://example.com
    if let Some(idx) = url.find("://") {
        let after = &url[idx + 3..];
        if let Some(slash) = after.find('/') {
            return url[..idx + 3 + slash].to_string();
        }
        return url.to_string();
    }
    url.to_string()
}

fn resolve_urls(html: &str, base: &str, origin: &str) -> String {
    let mut result = html.to_string();

    // Resolve href="..." and src="..."
    for attr in &["href=\"", "src=\"", "href='", "src='"] {
        let quote = if attr.ends_with('"') { '"' } else { '\'' };
        let mut offset = 0;
        loop {
            let lower = result[offset..].to_lowercase();
            if let Some(start) = lower.find(attr) {
                let abs_start = offset + start + attr.len();
                if let Some(end) = result[abs_start..].find(quote) {
                    let url_val = &result[abs_start..abs_start + end];
                    let resolved = if url_val.starts_with("http://") || url_val.starts_with("https://") || url_val.starts_with("data:") || url_val.starts_with("mailto:") || url_val.starts_with('#') {
                        url_val.to_string()
                    } else if url_val.starts_with("//") {
                        format!("https:{}", url_val)
                    } else if url_val.starts_with('/') {
                        format!("{}{}", origin, url_val)
                    } else {
                        format!("{}/{}", base, url_val)
                    };
                    if resolved != url_val {
                        result = format!("{}{}{}", &result[..abs_start], resolved, &result[abs_start + end..]);
                    }
                    offset = abs_start + resolved.len() + 1;
                } else {
                    break;
                }
            } else {
                break;
            }
        }
    }

    result
}

fn find_body(html: &str, lower: &str) -> Option<String> {
    let start = lower.find("<body")?.checked_add(5)?;
    let gt = html[start..].find('>')? + start + 1;
    let end = lower[gt..].find("</body")? + gt;
    Some(html[gt..end].to_string())
}
