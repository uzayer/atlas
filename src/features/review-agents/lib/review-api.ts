import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** One flagged issue. Fields are snake_case: this object is produced verbatim
 *  by the model (PR-Agent schema) and passed straight through Rust. */
export interface KeyIssue {
  relevant_file: string;
  issue_header: string;
  issue_content: string;
  start_line?: number | null;
  end_line?: number | null;
}

/** Structured review verdict (snake_case, see {@link KeyIssue}). */
export interface ReviewVerdict {
  summary: string;
  estimated_effort_to_review?: number | null;
  score?: number | null;
  relevant_tests: string;
  key_issues: KeyIssue[];
  security_concerns: string;
}

/** A completed, persisted review (camelCase — Rust `ReviewRecord`). */
export interface ReviewRecord {
  id: string;
  title: string;
  provider: string;
  model: string;
  createdAt: string;
  verdict: ReviewVerdict | null;
  rawText: string;
  omittedFiles: string[];
  inputTokens: number;
  outputTokens: number;
  costUsd?: number | null;
}

/** Which diff to review. Mirrors the Rust `ReviewSource` (tag = "type"). */
export type ReviewSource =
  | { type: "working" }
  | { type: "staged" }
  | { type: "commit"; sha: string }
  | { type: "range"; from: string; to: string };

/** Streamed review events from Rust, tagged by review `id`. */
export type ReviewEvent =
  | { id: string; kind: "delta"; delta: string }
  | { id: string; kind: "thinking"; delta: string }
  | { id: string; kind: "complete"; record: ReviewRecord }
  | { id: string; kind: "error"; message: string };

export const review = {
  /** BYOK providers that have a key AND the reviewer can drive. */
  providers: () => invoke<string[]>("review_providers"),
  start: (
    id: string,
    project: string,
    provider: string,
    model: string,
    source: ReviewSource,
  ) => invoke<void>("review_start", { id, project, provider, model, source }),
  cancel: (id: string) => invoke<void>("review_cancel", { id }),
  list: (project: string) => invoke<ReviewRecord[]>("review_list", { project }),
  get: (project: string, id: string) =>
    invoke<ReviewRecord | null>("review_get", { project, id }),
  /** Model ids for a provider — reuses the Model-Chat listing command. */
  models: (provider: string) =>
    invoke<{ id: string }[]>("modelchat_models", { provider }),
};

export const listenReview = (
  handler: (e: ReviewEvent) => void,
): Promise<UnlistenFn> =>
  listen<ReviewEvent>("atlas:review", (e) => handler(e.payload));
