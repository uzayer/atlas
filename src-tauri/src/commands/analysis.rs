use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize, Clone)]
pub struct Symbol {
    pub name: String,
    pub kind: String,
    pub file_path: String,
    pub line: u32,
    pub signature: String,
}

#[derive(Debug, Serialize)]
pub struct ProjectStats {
    pub total_files: u32,
    pub total_lines: u32,
    pub languages: Vec<LanguageStat>,
    pub symbols: Vec<Symbol>,
}

#[derive(Debug, Serialize)]
pub struct LanguageStat {
    pub language: String,
    pub files: u32,
    pub lines: u32,
}

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

    let mut total_files = 0u32;
    let mut total_lines = 0u32;
    let mut lang_map: std::collections::HashMap<String, (u32, u32)> = std::collections::HashMap::new();
    let mut symbols: Vec<Symbol> = Vec::new();

    walk_dir(root, root, &mut total_files, &mut total_lines, &mut lang_map, &mut symbols);

    let mut languages: Vec<LanguageStat> = lang_map
        .into_iter()
        .map(|(lang, (files, lines))| LanguageStat { language: lang, files, lines })
        .collect();
    languages.sort_by(|a, b| b.lines.cmp(&a.lines));

    Ok(ProjectStats {
        total_files,
        total_lines,
        languages,
        symbols,
    })
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
        if name.starts_with('.') || name == "node_modules" || name == "target"
            || name == "dist" || name == "build" || name == "__pycache__"
            || name == "vendor" || name == ".git"
        {
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
                let rel_path = path.strip_prefix(root)
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
