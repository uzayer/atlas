// Wire types + render constants for the git-graph panel.
//
// The graph LAYOUT algorithm lives in Rust:
// `src-tauri/src/commands/git_graph.rs::git_graph_build` runs `git log`
// + `git for-each-ref` in parallel, lays out lanes/segments, and ships
// a `BuiltGraph` ready to render. The frontend used to do all of this
// in `buildGraph(...)` (~300 LOC walking commits + allocating lanes
// per-row) on every git signature change — that's pure business logic
// per the "Rust owns logic" rule.
//
// These interfaces are the wire-shape projection of the Rust types
// (see git_graph.rs). Keep them in sync field-for-field.

/** Wire type returned by the `git_refs` Tauri command. Kept here
 *  (rather than in a dedicated git-types module) because the branch
 *  mention provider consumes it and it sits next to its sibling
 *  graph types. */
export interface RawRef {
  name: string;
  sha: string;
  kind: "branch" | "remote" | "tag" | string;
  is_current: boolean;
}

export interface RawRefs {
  head: string | null;
  head_ref: string | null;
  refs: RawRef[];
}

export interface RefBadge {
  name: string;
  kind: "branch" | "remote" | "tag" | string;
  isCurrent: boolean;
}

export interface LaneSegment {
  fromLane: number;
  toLane: number;
  /** 0.0 = top, 0.5 = middle, 1.0 = bottom. Wire type is f32 in Rust;
   *  the renderer only compares for equality at 0/0.5/1. */
  fromY: number;
  toY: number;
  color: string;
}

export interface CommitRow {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  email: string;
  date: string;
  refs: RefBadge[];
  isHead: boolean;
  commitLane: number;
  commitColor: string;
  segments: LaneSegment[];
}

export interface BuiltGraph {
  rows: CommitRow[];
  laneCount: number;
}

// Render-only constants — used by the panel + commit-node components.
// Lane colors are duplicated on the Rust side (single source of truth
// for the algorithm); these are only here so any pure-render code that
// needs to reference a palette color (e.g. fallback styling) doesn't
// have to invent its own.
export const LANE_WIDTH = 14;
export const ROW_HEIGHT = 28;
export const GRAPH_LEFT_PAD = 14;

export const LANE_COLORS = [
  "#60a5fa", // blue
  "#34d399", // emerald
  "#f59e0b", // amber
  "#a78bfa", // violet
  "#f472b6", // pink
  "#22d3ee", // cyan
  "#fb7185", // rose
  "#84cc16", // lime
  "#eab308", // yellow
  "#94a3b8", // slate
];
