//! Incremental UTF-8 decoding for network stream chunks.
//!
//! ATLAS PATCH (vendor/cersei-provider, applied via `[patch.crates-io]`).
//!
//! The published crate decoded each raw HTTP chunk with
//! `String::from_utf8_lossy(&bytes)`. A multi-byte character (CJK, emoji,
//! box-drawing, …) that straddles a chunk boundary then decodes as U+FFFD on
//! both sides — corrupting streamed assistant text AND tool-call JSON
//! arguments. This decoder carries the incomplete trailing sequence across
//! chunks so output is byte-identical to decoding the concatenated stream.

/// Marker consumed by Atlas guard code: referencing this constant fails to
/// compile if a build resolves the unpatched crates.io release instead of the
/// vendored crate, so the patch cannot silently regress out of the build.
pub const ATLAS_UTF8_PATCH: &str = "incremental-utf8-v1";

/// Streaming UTF-8 decoder. Feed raw chunks with [`push`](Self::push); an
/// incomplete trailing character is buffered until the next chunk. Truly
/// invalid bytes become U+FFFD, matching `from_utf8_lossy` semantics on the
/// whole stream.
#[derive(Default)]
pub struct Utf8ChunkDecoder {
    pending: Vec<u8>,
}

impl Utf8ChunkDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Decode `bytes`, appending all complete characters to `out`.
    pub fn push(&mut self, bytes: &[u8], out: &mut String) {
        // Fast path: nothing pending and the chunk is valid on its own.
        if self.pending.is_empty() {
            if let Ok(s) = std::str::from_utf8(bytes) {
                out.push_str(s);
                return;
            }
        }
        let mut data = std::mem::take(&mut self.pending);
        data.extend_from_slice(bytes);
        let mut input: &[u8] = &data;
        loop {
            match std::str::from_utf8(input) {
                Ok(s) => {
                    out.push_str(s);
                    input = &[];
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    // Safe: from_utf8 just validated this prefix.
                    out.push_str(std::str::from_utf8(&input[..valid]).unwrap());
                    match e.error_len() {
                        // Invalid sequence: substitute and continue after it.
                        Some(n) => {
                            out.push('\u{FFFD}');
                            input = &input[valid + n..];
                        }
                        // Incomplete trailing sequence: wait for more bytes.
                        None => {
                            input = &input[valid..];
                            break;
                        }
                    }
                }
            }
        }
        self.pending = input.to_vec();
    }

    /// End-of-stream: substitute any buffered incomplete sequence (the stream
    /// was truncated mid-character). Idempotent.
    pub fn finish(&mut self, out: &mut String) {
        if !self.pending.is_empty() {
            self.pending.clear();
            out.push('\u{FFFD}');
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Decode `bytes` split at every possible boundary pair and assert the
    /// result always equals lossy-decoding the whole input at once.
    fn assert_split_invariant(bytes: &[u8]) {
        let want = String::from_utf8_lossy(bytes).into_owned();
        for i in 0..=bytes.len() {
            for j in i..=bytes.len() {
                let mut dec = Utf8ChunkDecoder::new();
                let mut got = String::new();
                dec.push(&bytes[..i], &mut got);
                dec.push(&bytes[i..j], &mut got);
                dec.push(&bytes[j..], &mut got);
                dec.finish(&mut got);
                assert_eq!(got, want, "split at {i}/{j} of {bytes:?}");
            }
        }
    }

    #[test]
    fn cjk_split_across_chunks_is_lossless() {
        // 3-byte chars: 你好世界
        assert_split_invariant("你好世界".as_bytes());
    }

    #[test]
    fn emoji_split_across_chunks_is_lossless() {
        // 4-byte chars incl. ZWJ sequence: 🚀👨‍👩‍👧
        assert_split_invariant("a🚀b👨‍👩‍👧c".as_bytes());
    }

    #[test]
    fn two_byte_and_box_drawing_split_is_lossless() {
        assert_split_invariant("é─│┌ñ".as_bytes());
    }

    #[test]
    fn tool_call_json_with_multibyte_content_survives_any_split() {
        // The real-world failure: tool-call arguments carrying file content.
        assert_split_invariant(r#"{"path":"src/日本語.rs","content":"// 中文注释 ✅"}"#.as_bytes());
    }

    #[test]
    fn invalid_bytes_still_become_replacement_chars() {
        assert_split_invariant(&[0x61, 0xFF, 0xFE, 0x62]);
        // Overlong / stray continuation bytes
        assert_split_invariant(&[0x80, 0x61, 0xC3]);
    }

    #[test]
    fn ascii_fast_path() {
        let mut dec = Utf8ChunkDecoder::new();
        let mut out = String::new();
        dec.push(b"hello ", &mut out);
        dec.push(b"world", &mut out);
        assert_eq!(out, "hello world");
    }

    #[test]
    fn truncated_stream_finishes_with_replacement() {
        let mut dec = Utf8ChunkDecoder::new();
        let mut out = String::new();
        dec.push(&"你".as_bytes()[..2], &mut out); // incomplete 3-byte char
        dec.finish(&mut out);
        assert_eq!(out, "\u{FFFD}");
        dec.finish(&mut out); // idempotent
        assert_eq!(out, "\u{FFFD}");
    }

    /// Regression guard within the vendored crate: the three stream decoders
    /// must never go back to lossy-decoding raw chunks.
    #[test]
    fn stream_decoders_do_not_use_from_utf8_lossy() {
        for (name, src) in [
            ("anthropic.rs", include_str!("anthropic.rs")),
            ("openai.rs", include_str!("openai.rs")),
            ("gemini.rs", include_str!("gemini.rs")),
        ] {
            assert!(
                !src.contains("from_utf8_lossy"),
                "{name} reintroduced from_utf8_lossy on stream chunks"
            );
        }
    }
}
