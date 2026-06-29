//! `Read` — line-numbered file reads with 1-indexed offset/limit, pagination,
//! binary detection, and "Did you mean?" suggestions (after opencode, MIT).

use async_trait::async_trait;
use cersei::tools::{PermissionLevel, Tool, ToolCategory, ToolContext, ToolResult};
use serde::Deserialize;
use serde_json::Value;

use super::{coerce, cwd, errors};

const DEFAULT_LIMIT: usize = 2000;
const MAX_BYTES: usize = 50 * 1024;
const MAX_LINE_LEN: usize = 2000;
const SAMPLE_BYTES: usize = 4096;

const DESCRIPTION: &str = "Reads a file from the filesystem. Prefer this over shell tools \
(cat/head/tail) — it returns line-numbered, paginated, grounded output.\n\n\
Usage:\n\
- file_path is absolute or relative to the project root.\n\
- Returns up to 2000 lines; each line is prefixed with `N: `. The `N: ` is NOT part of the \
file — never copy it into an Edit's old_string.\n\
- Use offset (1-indexed line to start from) and limit to page through large files.\n\
- Call in parallel when reading several files. Use Grep to search within large files.";

const ALIASES: &[(&str, &str)] = &[
    ("filePath", "file_path"),
    ("path", "file_path"),
    ("filename", "file_path"),
    ("file", "file_path"),
];

#[derive(Deserialize)]
struct Input {
    file_path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

fn is_binary(path: &std::path::Path, sample: &[u8]) -> bool {
    const BINARY_EXT: &[&str] = &[
        "zip", "tar", "gz", "exe", "dll", "so", "class", "jar", "war", "7z", "doc", "docx", "xls",
        "xlsx", "ppt", "pptx", "bin", "dat", "obj", "o", "a", "lib", "wasm", "pyc", "pyo", "png",
        "jpg", "jpeg", "gif", "webp", "pdf", "ico", "mp3", "mp4", "mov", "woff", "woff2", "ttf",
    ];
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        if BINARY_EXT.contains(&ext.to_ascii_lowercase().as_str()) {
            return true;
        }
    }
    if sample.is_empty() {
        return false;
    }
    let mut non_printable = 0usize;
    for &b in sample {
        if b == 0 {
            return true;
        }
        if b < 9 || (b > 13 && b < 32) {
            non_printable += 1;
        }
    }
    non_printable as f64 / sample.len() as f64 > 0.3
}

async fn siblings(path: &std::path::Path) -> Vec<String> {
    let (Some(dir), Some(base)) = (path.parent(), path.file_name().and_then(|s| s.to_str())) else {
        return Vec::new();
    };
    let base_lower = base.to_ascii_lowercase();
    let mut out = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            let nl = name.to_ascii_lowercase();
            if nl.contains(&base_lower) || base_lower.contains(&nl) {
                out.push(dir.join(&name).to_string_lossy().into_owned());
                if out.len() >= 3 {
                    break;
                }
            }
        }
    }
    out
}

pub struct ReadTool;

#[async_trait]
impl Tool for ReadTool {
    fn name(&self) -> &str {
        "Read"
    }
    fn description(&self) -> &str {
        DESCRIPTION
    }
    fn permission_level(&self) -> PermissionLevel {
        PermissionLevel::ReadOnly
    }
    fn category(&self) -> ToolCategory {
        ToolCategory::FileSystem
    }
    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "file_path": { "type": "string", "description": "Path to the file (absolute, or relative to the project root)" },
                "offset": { "type": "integer", "description": "1-indexed line to start from" },
                "limit": { "type": "integer", "description": "Max lines to read (default 2000)" }
            },
            "required": ["file_path"]
        })
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult {
        let input = coerce::dealias(coerce::unwrap_stringified(input), ALIASES);
        let input: Input = match serde_json::from_value(input) {
            Ok(i) => i,
            Err(e) => return ToolResult::error(errors::decode_failure("Read", &e.to_string())),
        };

        let path = cwd::resolve_path(&ctx.working_dir, &input.file_path);
        let display = path.to_string_lossy().into_owned();

        let meta = match tokio::fs::metadata(&path).await {
            Ok(m) => m,
            Err(_) => {
                let sibs = siblings(&path).await;
                return ToolResult::error(errors::read_did_you_mean(&display, &sibs));
            }
        };

        if meta.is_dir() {
            return read_dir(&path, &display, input.offset, input.limit).await;
        }

        let bytes = match tokio::fs::read(&path).await {
            Ok(b) => b,
            Err(e) => return ToolResult::error(format!("Failed to read {display}: {e}")),
        };
        let sample = &bytes[..bytes.len().min(SAMPLE_BYTES)];
        if is_binary(&path, sample) {
            return ToolResult::success(format!(
                "[Binary file {display} ({} bytes) — not shown as text.]",
                bytes.len()
            ));
        }

        let text = String::from_utf8_lossy(&bytes);
        let offset = input.offset.unwrap_or(1).max(1);
        let limit = input.limit.unwrap_or(DEFAULT_LIMIT);
        let all_lines: Vec<&str> = text.split('\n').collect();
        // A trailing newline yields a final empty element; drop it for counting.
        let total = if text.ends_with('\n') && !all_lines.is_empty() {
            all_lines.len() - 1
        } else {
            all_lines.len()
        };

        if offset > total && !(total == 0 && offset == 1) {
            return ToolResult::error(format!(
                "Offset {offset} is out of range for {display} ({total} lines)."
            ));
        }

        let start = offset - 1;
        let mut body = String::new();
        let mut bytes_used = 0usize;
        let mut last = start;
        let mut capped = false;
        for (i, line) in all_lines.iter().enumerate().skip(start) {
            if i >= start + limit {
                break;
            }
            if i == total && line.is_empty() {
                break; // trailing-newline phantom line
            }
            let shown: String = if line.chars().count() > MAX_LINE_LEN {
                let cut: String = line.chars().take(MAX_LINE_LEN).collect();
                format!("{cut}... (line truncated)")
            } else {
                (*line).to_string()
            };
            let entry = format!("{}: {}\n", i + 1, shown);
            if bytes_used + entry.len() > MAX_BYTES && !body.is_empty() {
                capped = true;
                break;
            }
            bytes_used += entry.len();
            body.push_str(&entry);
            last = i + 1;
        }

        let next = last + 1;
        let footer = if capped {
            format!("\n(Output capped at {} KB. Showing lines {offset}-{last}. Use offset={next} to continue.)", MAX_BYTES / 1024)
        } else if last < total {
            format!("\n(Showing lines {offset}-{last} of {total}. Use offset={next} to continue.)")
        } else {
            format!("\n(End of file — {total} lines.)")
        };

        ToolResult::success(format!("{display}\n{body}{footer}"))
    }
}

async fn read_dir(
    path: &std::path::Path,
    display: &str,
    offset: Option<usize>,
    limit: Option<usize>,
) -> ToolResult {
    let mut entries: Vec<String> = Vec::new();
    let mut rd = match tokio::fs::read_dir(path).await {
        Ok(r) => r,
        Err(e) => return ToolResult::error(format!("Failed to list {display}: {e}")),
    };
    while let Ok(Some(entry)) = rd.next_entry().await {
        let mut name = entry.file_name().to_string_lossy().into_owned();
        if entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false) {
            name.push('/');
        }
        entries.push(name);
    }
    entries.sort();
    let total = entries.len();
    let start = offset.unwrap_or(1).saturating_sub(1);
    let lim = limit.unwrap_or(DEFAULT_LIMIT);
    let slice: Vec<String> = entries.into_iter().skip(start).take(lim).collect();
    let shown = slice.len();
    let truncated = start + shown < total;
    let footer = if truncated {
        format!("\n(Showing {shown} of {total} entries. Use offset={} to continue.)", start + shown + 1)
    } else {
        format!("\n({total} entries.)")
    };
    ToolResult::success(format!("{display} (directory)\n{}{footer}", slice.join("\n")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::{test_ctx, TmpDir};

    async fn run(dir: &std::path::Path, args: Value) -> ToolResult {
        ReadTool.execute(args, &test_ctx(dir.to_path_buf())).await
    }

    #[tokio::test]
    async fn reads_with_line_numbers() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "a.txt"})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("1: one"));
        assert!(r.content.contains("3: three"));
        assert!(r.content.contains("End of file — 3 lines"));
    }

    #[tokio::test]
    async fn offset_and_limit() {
        let tmp = TmpDir::new();
        let body: String = (1..=10).map(|i| format!("L{i}\n")).collect();
        std::fs::write(tmp.path().join("a.txt"), body).unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "a.txt", "offset": 3, "limit": 2})).await;
        assert!(!r.is_error, "{}", r.content);
        assert!(r.content.contains("3: L3"));
        assert!(r.content.contains("4: L4"));
        assert!(!r.content.contains("5: L5"));
        assert!(r.content.contains("Use offset=5 to continue"));
    }

    #[tokio::test]
    async fn missing_file_suggests_siblings() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("main.rs"), "x").unwrap();
        // Model dropped the extension; "main" is a substring of "main.rs".
        let r = run(tmp.path(), serde_json::json!({"file_path": "main"})).await;
        assert!(r.is_error);
        assert!(r.content.contains("Did you mean"));
        assert!(r.content.contains("main.rs"));
    }

    #[tokio::test]
    async fn binary_notice() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("b.bin"), [0u8, 1, 2, 3, 0, 255]).unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "b.bin"})).await;
        assert!(!r.is_error);
        assert!(r.content.contains("Binary file"));
    }

    #[tokio::test]
    async fn out_of_range_offset() {
        let tmp = TmpDir::new();
        std::fs::write(tmp.path().join("a.txt"), "one\ntwo\n").unwrap();
        let r = run(tmp.path(), serde_json::json!({"file_path": "a.txt", "offset": 50})).await;
        assert!(r.is_error);
        assert!(r.content.contains("out of range"));
    }
}
