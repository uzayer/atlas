//! Guard for the Phase 0 UTF-8 patch (plans/atlas-agent-stack-zed-parity.md).
//!
//! `cersei-provider` MUST resolve to the vendored, patched crate
//! (vendor/cersei-provider via `[patch.crates-io]`), never the crates.io
//! release: the published SSE decoders lossy-decode raw HTTP chunks and
//! corrupt multi-byte characters split across chunk boundaries — including
//! tool-call JSON arguments (the historical file-corruption bug).
//!
//! If the patch stops applying, `cersei_provider::utf8` does not exist and
//! this test FAILS TO COMPILE — the regression cannot slip through green.

#[test]
fn vendored_utf8_patched_provider_is_resolved() {
    assert_eq!(cersei_provider::utf8::ATLAS_UTF8_PATCH, "incremental-utf8-v1");

    // Belt-and-braces: exercise the decoder across a split multi-byte char.
    let mut dec = cersei_provider::utf8::Utf8ChunkDecoder::new();
    let mut out = String::new();
    let bytes = "汉🚀".as_bytes(); // 3-byte + 4-byte chars
    dec.push(&bytes[..2], &mut out); // split mid-汉
    dec.push(&bytes[2..5], &mut out); // split mid-🚀
    dec.push(&bytes[5..], &mut out);
    assert_eq!(out, "汉🚀");
}
