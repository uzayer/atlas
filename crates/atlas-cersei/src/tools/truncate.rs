//! Output capping with full-output temp-file spill (ported idea from opencode's
//! `truncate.ts`). When a tool's output exceeds the cap, the head is returned
//! with a hint pointing at a temp file holding the complete output.

use std::path::PathBuf;

/// Default cap for tool output bodies (~30 KB) before spilling to a temp file.
pub const MAX_OUTPUT_BYTES: usize = 30_000;

/// Largest byte index `<= max` that lands on a UTF-8 char boundary.
fn floor_boundary(s: &str, max: usize) -> usize {
    if max >= s.len() {
        return s.len();
    }
    let mut i = max;
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Cap `output` at `max` bytes. If it overflows, write the full output to a temp
/// file and return `head + hint`. `label` names the source (e.g. "Bash output").
pub fn truncate_output(output: String, max: usize, label: &str) -> String {
    if output.len() <= max {
        return output;
    }
    let total = output.len();
    let cut = floor_boundary(&output, max);
    let head = &output[..cut];

    let file = PathBuf::from(std::env::temp_dir())
        .join(format!("atlas-cersei-{}.txt", uuid::Uuid::new_v4()));
    let spill = match std::fs::write(&file, output.as_bytes()) {
        Ok(()) => format!("Full output ({total} bytes) written to {}", file.display()),
        Err(e) => format!("Full output ({total} bytes); temp spill failed: {e}"),
    };

    format!("{head}\n\n[{label} truncated at {max} bytes. {spill}]")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn under_cap_unchanged() {
        let s = "hello".to_string();
        assert_eq!(truncate_output(s.clone(), 100, "x"), s);
    }

    #[test]
    fn over_cap_spills_and_hints() {
        let s = "a".repeat(1000);
        let out = truncate_output(s, 100, "Bash output");
        assert!(out.starts_with(&"a".repeat(100)));
        assert!(out.contains("truncated at 100 bytes"));
        assert!(out.contains("written to"));
    }

    #[test]
    fn respects_char_boundaries() {
        let s = "é".repeat(100); // 2 bytes each
        let out = truncate_output(s, 51, "x"); // odd cut would split a char
        // No panic and prefix is valid UTF-8 by construction.
        assert!(out.contains("truncated"));
    }
}
