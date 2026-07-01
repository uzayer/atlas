//! Word-level diff algorithm vendored from `dandavison/delta`.
//!
//! Delta (<https://github.com/dandavison/delta>) is a binary-only crate (no
//! `lib.rs` / public API), so we vendor the two self-contained modules that
//! implement its intra-line ("word") diff: the Needleman-Wunsch alignment
//! table (`align`) and the line-pairing + token-annotation pass (`edits`).
//!
//! These files are copied with only minimal edits (dropped `make_lines_have_homolog`,
//! which pulled in delta's `MinusPlus` type and which we don't use; tests removed;
//! imports rewired to `super::align`). The algorithm is otherwise unchanged.
//!
//! Delta is MIT licensed — Copyright 2020 Dan Davison. See `LICENSE-delta` at the
//! crate root for the full license text.

pub mod align;
pub mod edits;
