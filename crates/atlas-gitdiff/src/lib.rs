//! Structured side-by-side git-diff engine for Atlas.
//!
//! Parses `git diff` unified output into an aligned left/right row model with
//! word-level intra-line change spans, ready to serialize to the frontend.
//! The word-diff (line pairing + token annotation) is vendored from
//! `dandavison/delta` — see `src/vendor/` and `LICENSE-delta`.

mod parse;
mod vendor;

pub mod engine;

pub use engine::{
    build_file_diff, line_status, FileDiff, LineKind, LineStatus, Row, Segment, Side, Stats,
};
