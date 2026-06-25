// Bridge to the native `atlas-gitdiff` engine (Rust) — structured side-by-side
// diffs with word-level change spans, plus editor-gutter line classification.

import { invoke } from "@tauri-apps/api/core";
import { useLayoutStore } from "@/features/layout/stores/layout-store";

export type DiffLineKind = "context" | "added" | "removed" | "changed";

export interface DiffSegment {
  text: string;
  /** A word-level changed span within a modified line. */
  emph: boolean;
}

export interface DiffSide {
  lineNo: number;
  kind: DiffLineKind;
  segments: DiffSegment[];
}

export interface DiffRow {
  left: DiffSide | null;
  right: DiffSide | null;
}

export interface FileDiff {
  path: string;
  language: string;
  isBinary: boolean;
  rows: DiffRow[];
  stats: { additions: number; deletions: number };
  /** Row indices that start a contiguous change — for "N differences" + nav. */
  changeBlocks: number[];
}

export interface DiffLineStatus {
  added: number[];
  changed: number[];
  deletedBefore: number[];
}

export function gitDiffStructured(
  repoPath: string,
  file: string,
  staged: boolean,
): Promise<FileDiff> {
  return invoke<FileDiff>("git_diff_structured", { path: repoPath, file, staged });
}

export function gitDiffLineStatus(
  repoPath: string,
  file: string,
  staged: boolean,
): Promise<DiffLineStatus> {
  return invoke<DiffLineStatus>("git_diff_line_status", { path: repoPath, file, staged });
}

/**
 * Open (or focus) the dedicated side-by-side diff tab for a file. Tabs are keyed
 * by file + staged-ness so the staged and worktree diffs of the same file are
 * distinct tabs and re-opening focuses the existing one.
 */
export function openGitDiff(repoPath: string, file: string, staged: boolean): void {
  const base = file.split("/").pop() ?? file;
  const id = `diff:${file}:${staged ? "s" : "w"}`;
  const { addTab, setActiveTab } = useLayoutStore.getState().actions;
  addTab({
    id,
    type: "diff",
    title: base,
    closable: true,
    dirty: false,
    data: { repoPath, file, staged },
  });
  setActiveTab(id);
}
