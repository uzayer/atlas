use serde::{Deserialize, Serialize};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub file_path: String,
    pub line: u32,
    pub signature: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProjectStats {
    pub total_files: u32,
    pub total_lines: u32,
    pub languages: Vec<LanguageStat>,
    pub symbols: Vec<Symbol>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LanguageStat {
    pub language: String,
    pub files: u32,
    pub lines: u32,
}

/// Persisted analysis cache. Stored at `<project>/.atlas/analysis.json`.
/// `fingerprint` is a u64 hash of every code-file `(relative-path, mtime-ns)`
/// pair in the tree; on a fresh call we walk the tree, recompute the
/// fingerprint, and only do the expensive file-content + symbol-extraction
/// pass if it differs. The fingerprint walk only `stat()`s each file —
/// roughly 5-10× faster than the full analysis.
#[derive(Debug, Serialize, Deserialize)]
struct AnalysisCache {
    fingerprint: u64,
    stats: ProjectStats,
}

const CACHE_DIR: &str = ".atlas";
const CACHE_FILE: &str = "analysis.json";

#[tauri::command]
pub async fn analyze_project(path: String) -> Result<ProjectStats, String> {
    tokio::task::spawn_blocking(move || analyze_project_sync(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn analyze_project_sync(path: &str) -> Result<ProjectStats, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err("Not a directory".to_string());
    }

    let cache_path = root.join(CACHE_DIR).join(CACHE_FILE);
    let fingerprint = compute_fingerprint(root);

    // Cache hit: read + parse + return the stored stats. No file-content
    // reads, no symbol extraction. Typical warm-start cost: <2 ms.
    if let Ok(raw) = fs::read_to_string(&cache_path) {
        if let Ok(cache) = serde_json::from_str::<AnalysisCache>(&raw) {
            if cache.fingerprint == fingerprint {
                return Ok(cache.stats);
            }
        }
    }

    // Cache miss / stale → full analysis.
    let stats = full_analysis(root)?;

    // Persist for next launch. Best-effort — never fail the request on a
    // write error (read-only mount, permission denied, etc.). Atomic write
    // via tmp + rename so a crash mid-write can't leave a torn file.
    let payload = AnalysisCache {
        fingerprint,
        stats: stats.clone(),
    };
    if let Ok(serialized) = serde_json::to_string(&payload) {
        if let Some(parent) = cache_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = cache_path.with_extension("json.tmp");
        if fs::write(&tmp, serialized).is_ok() {
            let _ = fs::rename(&tmp, &cache_path);
        }
    }

    Ok(stats)
}

fn full_analysis(root: &Path) -> Result<ProjectStats, String> {
    let mut total_files = 0u32;
    let mut total_lines = 0u32;
    let mut lang_map: std::collections::HashMap<String, (u32, u32)> =
        std::collections::HashMap::new();
    let mut symbols: Vec<Symbol> = Vec::new();

    walk_dir(
        root,
        root,
        &mut total_files,
        &mut total_lines,
        &mut lang_map,
        &mut symbols,
    );

    let mut languages: Vec<LanguageStat> = lang_map
        .into_iter()
        .map(|(lang, (files, lines))| LanguageStat {
            language: lang,
            files,
            lines,
        })
        .collect();
    languages.sort_by(|a, b| b.lines.cmp(&a.lines));

    Ok(ProjectStats {
        total_files,
        total_lines,
        languages,
        symbols,
    })
}

/// Walks the tree the same way `walk_dir` does (same ignore rules) but only
/// hashes `(relative-path, mtime-ns)` pairs. No content reads.
fn compute_fingerprint(root: &Path) -> u64 {
    let mut hasher = DefaultHasher::new();
    walk_for_fingerprint(root, root, &mut hasher);
    hasher.finish()
}

fn walk_for_fingerprint(dir: &Path, root: &Path, hasher: &mut DefaultHasher) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    // Collect + sort entries so the hash is stable regardless of filesystem
    // iteration order.
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();

    for path in paths {
        let name = match path.file_name() {
            Some(n) => n.to_string_lossy().to_string(),
            None => continue,
        };
        if is_skipped_dir(&name) {
            continue;
        }

        if path.is_dir() {
            walk_for_fingerprint(&path, root, hasher);
        } else if path.extension().and_then(|e| e.to_str()).is_some_and(is_code_ext) {
            // Hash the rel path + mtime nanoseconds. We deliberately skip the
            // size — mtime invalidation is enough since any content edit
            // bumps mtime, and using size alone would miss in-place edits.
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy();
            rel.hash(hasher);
            let mtime_ns = path
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_nanos() as u64)
                .unwrap_or(0);
            mtime_ns.hash(hasher);
        }
    }
}

fn is_skipped_dir(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules" | "target" | "dist" | "build" | "__pycache__" | "vendor"
        )
}

fn is_code_ext(ext: &str) -> bool {
    matches!(
        ext,
        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "rb" | "java"
        | "c" | "h" | "cpp" | "hpp" | "cc" | "swift" | "kt" | "css" | "scss"
        | "html" | "json" | "toml" | "yaml" | "yml" | "md" | "mdx"
        | "sh" | "bash" | "zsh" | "sql" | "dockerfile" | "Dockerfile"
        | "mjs" | "cjs" | "graphql" | "gql" | "proto" | "tf" | "hcl"
        | "xml" | "svg"
    )
}

fn walk_dir(
    dir: &Path,
    root: &Path,
    total_files: &mut u32,
    total_lines: &mut u32,
    lang_map: &mut std::collections::HashMap<String, (u32, u32)>,
    symbols: &mut Vec<Symbol>,
) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        // Skip hidden dirs and common non-source dirs
        if is_skipped_dir(&name) {
            continue;
        }

        if path.is_dir() {
            walk_dir(&path, root, total_files, total_lines, lang_map, symbols);
        } else if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
            let lang = match ext {
                "rs" => "Rust",
                "ts" | "tsx" => "TypeScript",
                "js" | "jsx" => "JavaScript",
                "py" => "Python",
                "go" => "Go",
                "rb" => "Ruby",
                "java" => "Java",
                "c" | "h" => "C",
                "cpp" | "hpp" | "cc" => "C++",
                "swift" => "Swift",
                "kt" => "Kotlin",
                "css" | "scss" => "CSS",
                "html" => "HTML",
                "json" => "JSON",
                "toml" => "TOML",
                "yaml" | "yml" => "YAML",
                "md" | "mdx" => "Markdown",
                "sh" | "bash" | "zsh" => "Shell",
                "sql" => "SQL",
                "dockerfile" | "Dockerfile" => "Docker",
                "mjs" | "cjs" => "JavaScript",
                "graphql" | "gql" => "GraphQL",
                "proto" => "Protobuf",
                "tf" | "hcl" => "HCL",
                "xml" | "svg" => "XML",
                _ => continue,
            };

            if let Ok(content) = fs::read_to_string(&path) {
                let line_count = content.lines().count() as u32;
                *total_files += 1;
                *total_lines += line_count;

                let entry = lang_map.entry(lang.to_string()).or_insert((0, 0));
                entry.0 += 1;
                entry.1 += line_count;

                // Extract symbols via regex-like pattern matching
                let rel_path = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();

                extract_symbols(&content, &rel_path, lang, symbols);
            }
        }
    }
}

fn extract_symbols(content: &str, file_path: &str, lang: &str, symbols: &mut Vec<Symbol>) {
    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        let line_num = (i + 1) as u32;

        match lang {
            "Rust" => {
                if (trimmed.starts_with("pub fn ") || trimmed.starts_with("fn ") || trimmed.starts_with("pub async fn ") || trimmed.starts_with("async fn ")) && trimmed.contains('(') {
                    let name = extract_fn_name(trimmed);
                    symbols.push(Symbol { name, kind: "function".into(), file_path: file_path.into(), line: line_num, signature: trimmed.to_string() });
                } else if (trimmed.starts_with("pub struct ") || trimmed.starts_with("struct ")) && !trimmed.contains('(') {
                    let name = extract_word_after(trimmed, "struct ");
                    symbols.push(Symbol { name, kind: "struct".into(), file_path: file_path.into(), line: line_num, signature: trimmed.to_string() });
                } else if trimmed.starts_with("pub enum ") || trimmed.starts_with("enum ") {
                    let name = extract_word_after(trimmed, "enum ");
                    symbols.push(Symbol { name, kind: "enum".into(), file_path: file_path.into(), line: line_num, signature: trimmed.to_string() });
                } else if trimmed.starts_with("pub trait ") || trimmed.starts_with("trait ") {
                    let name = extract_word_after(trimmed, "trait ");
                    symbols.push(Symbol { name, kind: "trait".into(), file_path: file_path.into(), line: line_num, signature: trimmed.to_string() });
                }
            }
            "TypeScript" | "JavaScript" => {
                if (trimmed.starts_with("export function ") || trimmed.starts_with("function ") || trimmed.starts_with("export async function ") || trimmed.starts_with("async function ")) && trimmed.contains('(') {
                    let name = extract_fn_name(trimmed);
                    symbols.push(Symbol { name, kind: "function".into(), file_path: file_path.into(), line: line_num, signature: trimmed.to_string() });
                } else if trimmed.starts_with("export class ") || trimmed.starts_with("class ") {
                    let name = extract_word_after(trimmed, "class ");
                    symbols.push(Symbol { name, kind: "class".into(), file_path: file_path.into(), line: line_num, signature: trimmed.to_string() });
                } else if (trimmed.starts_with("export interface ") || trimmed.starts_with("interface ")) && trimmed.contains('{') {
                    let name = extract_word_after(trimmed, "interface ");
                    symbols.push(Symbol { name, kind: "interface".into(), file_path: file_path.into(), line: line_num, signature: trimmed.to_string() });
                } else if (trimmed.starts_with("export type ") || trimmed.starts_with("type ")) && trimmed.contains('=') {
                    let name = extract_word_after(trimmed, "type ");
                    symbols.push(Symbol { name, kind: "type".into(), file_path: file_path.into(), line: line_num, signature: trimmed.to_string() });
                }
            }
            "Python" => {
                if (trimmed.starts_with("def ") || trimmed.starts_with("async def ")) && trimmed.contains('(') {
                    let name = extract_fn_name(trimmed);
                    symbols.push(Symbol { name, kind: "function".into(), file_path: file_path.into(), line: line_num, signature: trimmed.to_string() });
                } else if trimmed.starts_with("class ") && trimmed.contains(':') {
                    let name = extract_word_after(trimmed, "class ");
                    symbols.push(Symbol { name, kind: "class".into(), file_path: file_path.into(), line: line_num, signature: trimmed.to_string() });
                }
            }
            "Go" => {
                if trimmed.starts_with("func ") && trimmed.contains('(') {
                    let name = extract_fn_name(trimmed);
                    symbols.push(Symbol { name, kind: "function".into(), file_path: file_path.into(), line: line_num, signature: trimmed.to_string() });
                } else if trimmed.starts_with("type ") && (trimmed.contains("struct") || trimmed.contains("interface")) {
                    let name = extract_word_after(trimmed, "type ");
                    let kind = if trimmed.contains("struct") { "struct" } else { "interface" };
                    symbols.push(Symbol { name, kind: kind.into(), file_path: file_path.into(), line: line_num, signature: trimmed.to_string() });
                }
            }
            _ => {}
        }
    }
}

fn extract_fn_name(line: &str) -> String {
    // Find the function name between "fn " / "function " / "def " and "("
    let keywords = ["async fn ", "pub async fn ", "pub fn ", "fn ", "export async function ", "async function ", "export function ", "function ", "async def ", "def ", "func "];
    for kw in keywords {
        if let Some(rest) = line.trim().strip_prefix(kw) {
            if let Some(paren) = rest.find('(') {
                return rest[..paren].trim().to_string();
            }
        }
    }
    "unknown".to_string()
}

fn extract_word_after(line: &str, keyword: &str) -> String {
    if let Some(pos) = line.find(keyword) {
        let rest = &line[pos + keyword.len()..];
        let end = rest.find(|c: char| !c.is_alphanumeric() && c != '_').unwrap_or(rest.len());
        return rest[..end].to_string();
    }
    "unknown".to_string()
}
