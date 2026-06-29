//! L0 input coercion — the cheapest, highest-value weak-model rescue, applied
//! *before* matching. Fixes the classes that make weak BYOK models fail edits:
//! stringified-JSON tool args, aliased field names, and code-fenced strings.
//! See `plans/atlas-cersei-edit-solution.md` §5 (L0).

use serde_json::{Map, Value};

/// Field-name aliases weak models commonly emit for the Edit tool.
pub const EDIT_ALIASES: &[(&str, &str)] = &[
    ("filePath", "file_path"),
    ("path", "file_path"),
    ("filename", "file_path"),
    ("file", "file_path"),
    ("oldString", "old_string"),
    ("old_str", "old_string"),
    ("oldText", "old_string"),
    ("search", "old_string"),
    ("newString", "new_string"),
    ("new_str", "new_string"),
    ("newText", "new_string"),
    ("replace", "new_string"),
    ("replacement", "new_string"),
    ("replaceAll", "replace_all"),
];

/// If the tool args arrived as a JSON *string* (some providers double-encode),
/// parse it back into an object. Otherwise return `input` unchanged.
pub fn unwrap_stringified(input: Value) -> Value {
    if let Value::String(s) = &input {
        let trimmed = s.trim();
        if trimmed.starts_with('{') && trimmed.ends_with('}') {
            if let Ok(parsed @ Value::Object(_)) = serde_json::from_str::<Value>(trimmed) {
                return parsed;
            }
        }
    }
    input
}

/// Rename aliased keys to their canonical names, without clobbering a canonical
/// key the model already set correctly.
pub fn dealias(mut input: Value, aliases: &[(&str, &str)]) -> Value {
    if let Some(obj) = input.as_object_mut() {
        for (alias, canonical) in aliases {
            if obj.contains_key(*canonical) {
                continue;
            }
            if let Some(v) = obj.remove(*alias) {
                obj.insert((*canonical).to_string(), v);
            }
        }
    }
    input
}

/// Strip a *fully enclosing* ``` code fence (optionally ```lang) the model wrapped
/// around a value. Conservative: only when the entire string is fenced, so code
/// that merely contains backticks is left intact.
pub fn strip_code_fences(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.len() < 6 || !trimmed.starts_with("```") || !trimmed.ends_with("```") {
        return s.to_string();
    }
    // Drop the opening fence line (``` or ```lang\n ...).
    let after_open = &trimmed[3..];
    let body_start = match after_open.find('\n') {
        Some(nl) => nl + 1,
        None => return s.to_string(),
    };
    let inner = &after_open[body_start..];
    // Drop the trailing ``` (and an optional preceding newline).
    let inner = inner.strip_suffix("```").unwrap_or(inner);
    let inner = inner.strip_suffix('\n').unwrap_or(inner);
    inner.to_string()
}

/// Full L0 pre-pass for Edit-style args: unwrap stringified JSON, dealias keys,
/// and de-fence the `old_string`/`new_string` fields if a model fenced them.
pub fn coerce_edit_args(input: Value) -> Value {
    let input = unwrap_stringified(input);
    let mut input = dealias(input, EDIT_ALIASES);
    if let Some(obj) = input.as_object_mut() {
        defence_field(obj, "old_string");
        defence_field(obj, "new_string");
    }
    input
}

fn defence_field(obj: &mut Map<String, Value>, key: &str) {
    if let Some(Value::String(s)) = obj.get(key) {
        let stripped = strip_code_fences(s);
        if stripped != *s {
            obj.insert(key.to_string(), Value::String(stripped));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn unwraps_double_encoded_args() {
        let raw = Value::String(r#"{"file_path":"a.rs","old_string":"x"}"#.to_string());
        let got = unwrap_stringified(raw);
        assert_eq!(got["file_path"], "a.rs");
    }

    #[test]
    fn leaves_plain_object() {
        let v = json!({"a": 1});
        assert_eq!(unwrap_stringified(v.clone()), v);
    }

    #[test]
    fn dealiases_without_clobber() {
        let v = json!({"filePath": "a.rs", "oldText": "x", "new_string": "y"});
        let got = dealias(v, EDIT_ALIASES);
        assert_eq!(got["file_path"], "a.rs");
        assert_eq!(got["old_string"], "x");
        assert_eq!(got["new_string"], "y");
    }

    #[test]
    fn canonical_wins_over_alias() {
        let v = json!({"file_path": "real.rs", "path": "junk.rs"});
        let got = dealias(v, EDIT_ALIASES);
        assert_eq!(got["file_path"], "real.rs");
    }

    #[test]
    fn strips_lang_fence() {
        let s = "```rust\nfn a() {}\n```";
        assert_eq!(strip_code_fences(s), "fn a() {}");
    }

    #[test]
    fn strips_bare_fence() {
        let s = "```\nplain\n```";
        assert_eq!(strip_code_fences(s), "plain");
    }

    #[test]
    fn leaves_unfenced() {
        let s = "let x = `tpl`;";
        assert_eq!(strip_code_fences(s), s);
    }

    #[test]
    fn coerce_edit_end_to_end() {
        let raw = Value::String(
            r#"{"filePath":"a.rs","oldString":"```\nold\n```","newString":"new"}"#.to_string(),
        );
        let got = coerce_edit_args(raw);
        assert_eq!(got["file_path"], "a.rs");
        assert_eq!(got["old_string"], "old");
        assert_eq!(got["new_string"], "new");
    }
}
