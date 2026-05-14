use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub file_path: String,
    pub line: u32,
    pub content: String,
    pub match_start: u32,
    pub match_end: u32,
}

#[tauri::command]
pub fn search_in_files(
    path: String,
    query: String,
    max_results: Option<u32>,
) -> Result<Vec<SearchResult>, String> {
    let root = Path::new(&path);
    if !root.is_dir() {
        return Err("Not a directory".to_string());
    }

    let max = max_results.unwrap_or(100) as usize;
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    search_dir(root, root, &query_lower, &mut results, max);

    Ok(results)
}

fn search_dir(
    dir: &Path,
    root: &Path,
    query: &str,
    results: &mut Vec<SearchResult>,
    max: usize,
) {
    if results.len() >= max {
        return;
    }

    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        if results.len() >= max {
            return;
        }

        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();

        if name.starts_with('.')
            || name == "node_modules"
            || name == "target"
            || name == "dist"
            || name == "build"
            || name == "__pycache__"
        {
            continue;
        }

        if path.is_dir() {
            search_dir(&path, root, query, results, max);
        } else if is_searchable(&path) {
            if let Ok(content) = fs::read_to_string(&path) {
                let rel_path = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();

                for (i, line) in content.lines().enumerate() {
                    if results.len() >= max {
                        return;
                    }
                    let line_lower = line.to_lowercase();
                    if let Some(pos) = line_lower.find(query) {
                        results.push(SearchResult {
                            file_path: rel_path.clone(),
                            line: (i + 1) as u32,
                            content: line.to_string(),
                            match_start: pos as u32,
                            match_end: (pos + query.len()) as u32,
                        });
                    }
                }
            }
        }
    }
}

fn is_searchable(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");

    matches!(
        ext,
        "rs" | "ts" | "tsx" | "js" | "jsx" | "py" | "go" | "rb"
            | "java" | "c" | "cpp" | "h" | "hpp"
            | "swift" | "kt" | "css" | "scss" | "html"
            | "json" | "toml" | "yaml" | "yml" | "md"
            | "sh" | "bash" | "zsh" | "sql" | "xml" | "svg"
            | "txt" | "cfg" | "ini" | "env" | "lock"
    )
}
