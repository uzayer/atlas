// @-mention data layer for the chat input.
//
// One `MentionData` discriminated union per kind. Each kind has:
// - a `provider` that takes a query string + AbortSignal and returns matches
// - a short-form serializer (inline reference, what the agent sees in prose)
// - an optional context-block serializer (heavy body appended before send)
//
// The picker UI is data-driven over `MENTION_KINDS` so adding a new category
// later is a single entry here, no UI churn.

import { invoke } from "@tauri-apps/api/core";

import { fileIndex } from "@/features/file-picker/lib/file-picker-api";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
import { useAnalysisStore } from "@/features/analysis/stores/analysis-store";
import { useRecentFilesStore } from "@/features/chat/stores/recent-files-store";
import { listClaudeSessions, readClaudeSession } from "./claude-api";
import type { RawRefs } from "@/features/git/lib/git-graph";

// ── Types ────────────────────────────────────────────────────────────────────

export type MentionKind =
  | "file"
  | "symbol"
  | "knowledge"
  | "paper"
  | "branch"
  | "past_message";

export interface MentionFile {
  kind: "file";
  id: string;            // absolute path; also the de-dupe key
  displayName: string;   // relative path
  absPath: string;
}

export interface MentionSymbol {
  kind: "symbol";
  id: string;            // `${name}@${file_path}:${line}`
  displayName: string;   // name
  signature: string;
  filePath: string;
  line: number;
  symbolKind: string;
}

export interface MentionKnowledge {
  kind: "knowledge";
  id: string;            // entry id (== file_path basename in current impl)
  displayName: string;   // title
  filePath: string;
  source: string;        // "note" | "paper" | "chat" | ...
}

export interface MentionPaper {
  kind: "paper";
  id: string;
  displayName: string;   // title
  authors: string[];
  metadataPath: string;
}

export interface MentionBranch {
  kind: "branch";
  id: string;            // ref name
  displayName: string;   // short name
  sha: string;
  refKind: "branch" | "remote" | "tag";
  isCurrent: boolean;
}

export interface MentionPastMessage {
  kind: "past_message";
  id: string;            // `${sessionId}#${msgIdx}`
  displayName: string;   // truncated content
  sessionId: string;
  sessionTitle: string;
  timestamp: string | null;
  content: string;       // the message body — small, fine to keep inline
}

export type MentionData =
  | MentionFile
  | MentionSymbol
  | MentionKnowledge
  | MentionPaper
  | MentionBranch
  | MentionPastMessage;

// ── Catalog ──────────────────────────────────────────────────────────────────

export interface MentionCategory {
  kind: MentionKind;
  label: string;
  /** Substrings the typed query may start with to mean "bias toward this kind". */
  aliases: readonly string[];
  /** Score multiplier — Files dominate; the rest fall in below. */
  weight: number;
}

export const MENTION_CATEGORIES: readonly MentionCategory[] = [
  { kind: "file",         label: "Files & Folders", aliases: ["file", "f/"],          weight: 1.0  },
  { kind: "symbol",       label: "Symbols",         aliases: ["symbol", "sym", "s/"], weight: 0.85 },
  { kind: "knowledge",    label: "Knowledge",       aliases: ["note", "knowledge", "k/"], weight: 0.85 },
  { kind: "paper",        label: "Papers",          aliases: ["paper", "p/"],         weight: 0.7  },
  { kind: "branch",       label: "Branches",        aliases: ["branch", "b/"],        weight: 0.6  },
  { kind: "past_message", label: "Past Messages",   aliases: ["msg", "message", "m/"], weight: 0.55 },
];

export function categoryForKind(kind: MentionKind): MentionCategory {
  const c = MENTION_CATEGORIES.find((x) => x.kind === kind);
  if (!c) throw new Error(`unknown mention kind: ${kind}`);
  return c;
}

// ── Provider context ─────────────────────────────────────────────────────────

export interface MentionContext {
  /** Project root (cwd for the chat). Required by per-project sources. */
  projectPath: string | null;
}

export interface MentionProvider {
  kind: MentionKind;
  /**
   * Resolve matches for the given query. Empty query is valid — the provider
   * may return its "top" entries (recents, current items, etc).
   */
  search: (
    query: string,
    ctx: MentionContext,
    signal: AbortSignal
  ) => Promise<MentionData[]>;
}

// ── Providers ────────────────────────────────────────────────────────────────

const fileProvider: MentionProvider = {
  kind: "file",
  async search(query, _ctx, signal) {
    if (signal.aborted) return [];
    // Empty-query: prefer the recent-files list (in-memory). The picker also
    // shows recents explicitly above the divider, but include them here too
    // so blended results don't have a "Files" gap when the query is empty.
    if (!query) {
      const recents = useRecentFilesStore.getState().items;
      return recents.map<MentionFile>((r) => ({
        kind: "file",
        id: r.absPath,
        displayName: r.rel,
        absPath: r.absPath,
      }));
    }
    const matches = await fileIndex.search(query, 30);
    if (signal.aborted) return [];
    return matches.map<MentionFile>((m) => ({
      kind: "file",
      id: m.path,
      displayName: m.rel,
      absPath: m.path,
    }));
  },
};

const symbolProvider: MentionProvider = {
  kind: "symbol",
  async search(query, _ctx, _signal) {
    const all = useAnalysisStore.getState().symbols;
    const q = query.toLowerCase();
    const out: MentionSymbol[] = [];
    for (const s of all) {
      if (q && !s.name.toLowerCase().includes(q)) continue;
      out.push({
        kind: "symbol",
        id: `${s.name}@${s.file_path}:${s.line}`,
        displayName: s.name,
        signature: s.signature,
        filePath: s.file_path,
        line: s.line,
        symbolKind: s.kind,
      });
      if (out.length >= 30) break;
    }
    return out;
  },
};

const knowledgeProvider: MentionProvider = {
  kind: "knowledge",
  async search(query, _ctx, _signal) {
    const entries = useKnowledgeStore.getState().entries;
    const q = query.toLowerCase();
    const out: MentionKnowledge[] = [];
    for (const e of entries) {
      if (q && !e.title.toLowerCase().includes(q)) continue;
      out.push({
        kind: "knowledge",
        id: e.id,
        displayName: e.title,
        filePath: e.file_path,
        source: e.source,
      });
      if (out.length >= 30) break;
    }
    return out;
  },
};

interface SavedPaper {
  id: string;
  title: string;
  authors: string[];
  metadata_path: string;
}
const paperProvider: MentionProvider = {
  kind: "paper",
  async search(query, ctx, signal) {
    if (!ctx.projectPath) return [];
    let papers: SavedPaper[] = [];
    try {
      papers = await invoke<SavedPaper[]>("list_saved_papers", {
        projectPath: ctx.projectPath,
      });
    } catch {
      // Command not registered yet (v1 lands later in the migration order)
      return [];
    }
    if (signal.aborted) return [];
    const q = query.toLowerCase();
    return papers
      .filter((p) => !q || p.title.toLowerCase().includes(q))
      .slice(0, 30)
      .map<MentionPaper>((p) => ({
        kind: "paper",
        id: p.id,
        displayName: p.title,
        authors: p.authors,
        metadataPath: p.metadata_path,
      }));
  },
};

const branchProvider: MentionProvider = {
  kind: "branch",
  async search(query, ctx, signal) {
    if (!ctx.projectPath) return [];
    let refs: RawRefs;
    try {
      refs = await invoke<RawRefs>("git_refs", { path: ctx.projectPath });
    } catch {
      return [];
    }
    if (signal.aborted) return [];
    const q = query.toLowerCase();
    return refs.refs
      .filter((r) => r.kind === "branch" || r.kind === "remote")
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .slice(0, 30)
      .map<MentionBranch>((r) => ({
        kind: "branch",
        id: r.name,
        displayName: r.name,
        sha: r.sha,
        refKind: r.kind as "branch" | "remote",
        isCurrent: r.is_current,
      }));
  },
};

const pastMessageProvider: MentionProvider = {
  kind: "past_message",
  async search(query, ctx, signal) {
    if (!ctx.projectPath) return [];
    // v1: only the most recent ~3 sessions to keep blended-view fast.
    // The two-level picker (sessions → messages) drives deeper search.
    let sessions;
    try {
      sessions = await listClaudeSessions(ctx.projectPath);
    } catch {
      return [];
    }
    if (signal.aborted) return [];
    const top = sessions.slice(0, 3);
    const out: MentionPastMessage[] = [];
    const q = query.toLowerCase();
    for (const s of top) {
      if (signal.aborted) return [];
      let dump;
      try {
        dump = await readClaudeSession(s.file_path);
      } catch {
        continue;
      }
      let idx = 0;
      for (const m of dump) {
        if (m.role !== "user") {
          idx += 1;
          continue;
        }
        const content = m.content.trim();
        if (!content) {
          idx += 1;
          continue;
        }
        if (q && !content.toLowerCase().includes(q)) {
          idx += 1;
          continue;
        }
        out.push({
          kind: "past_message",
          id: `${s.id}#${idx}`,
          displayName: truncate(content.replace(/\s+/g, " "), 60),
          sessionId: s.id,
          sessionTitle: s.preview || "Untitled session",
          timestamp: m.timestamp,
          content,
        });
        idx += 1;
        if (out.length >= 15) break;
      }
      if (out.length >= 15) break;
    }
    return out;
  },
};

export const PROVIDERS: Readonly<Record<MentionKind, MentionProvider>> = {
  file: fileProvider,
  symbol: symbolProvider,
  knowledge: knowledgeProvider,
  paper: paperProvider,
  branch: branchProvider,
  past_message: pastMessageProvider,
};

// ── Ranking (blended view) ───────────────────────────────────────────────────

/** Substring score: 1.0 prefix, 0.8 word-boundary, 0.5 anywhere, 0 otherwise. */
function fuzzyMatchScore(query: string, displayName: string): number {
  if (!query) return 0.5;
  const q = query.toLowerCase();
  const name = displayName.toLowerCase();
  if (name === q) return 1.5;
  if (name.startsWith(q)) return 1.0;
  // word-boundary
  if (new RegExp(`(^|[/_\\-\\s.])${escapeRegExp(q)}`).test(name)) return 0.8;
  if (name.includes(q)) return 0.5;
  return 0;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Categories whose alias prefixes the query get a large boost. */
export function categoryHintBoost(query: string, kind: MentionKind): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  for (const cat of MENTION_CATEGORIES) {
    if (cat.kind !== kind) continue;
    for (const a of cat.aliases) {
      if (q.startsWith(a)) return 0.6;
    }
  }
  return 0;
}

export function rankMention(
  query: string,
  item: MentionData,
  isRecent: boolean
): number {
  const base = fuzzyMatchScore(query, item.displayName);
  const w = categoryForKind(item.kind).weight;
  const recency = isRecent ? 0.25 : 0;
  const hint = categoryHintBoost(query, item.kind);
  return base * w + recency + hint;
}

/** Strip the category alias from the query so per-provider matching doesn't
 *  re-match the literal prefix (e.g. with `@note auth`, send `auth` to the
 *  knowledge provider, not `note auth`). */
export function stripCategoryAlias(query: string, kind: MentionKind): string {
  const q = query;
  for (const a of categoryForKind(kind).aliases) {
    if (q.toLowerCase().startsWith(a)) {
      return q.slice(a.length).trimStart();
    }
  }
  return q;
}

// ── Serialization ────────────────────────────────────────────────────────────

/** What the agent sees inline in the prose body. Stable, grep-friendly. */
export function toShortForm(m: MentionData): string {
  switch (m.kind) {
    case "file":
      return `@file:${m.displayName}`;
    case "symbol":
      return `@symbol:${m.displayName}`;
    case "knowledge":
      return `@note:${m.displayName}`;
    case "paper":
      return `@paper:${m.displayName}`;
    case "branch":
      return `@branch:${m.displayName}`;
    case "past_message":
      return `@msg:${m.timestamp ?? m.id}`;
  }
}

/** Cap how much body content one mention can dump into the context block.
 *  Tuned for chat agents: ~32 KB is enough to read a medium source file. */
const MENTION_BODY_BUDGET_BYTES = 32 * 1024;

function clipBody(body: string): string {
  if (body.length <= MENTION_BODY_BUDGET_BYTES) return body;
  return (
    body.slice(0, MENTION_BODY_BUDGET_BYTES) +
    `\n\n… (truncated, ${body.length - MENTION_BODY_BUDGET_BYTES} bytes elided)`
  );
}

/** Fenced body block appended to the prompt. Returns null when the mention
 *  has no body to add (e.g. branches — name alone is the content). */
async function toContextBlock(m: MentionData): Promise<string | null> {
  switch (m.kind) {
    case "file": {
      let body: string;
      try {
        body = await invoke<string>("read_file_content", { path: m.absPath });
      } catch (e) {
        body = `(failed to read: ${e instanceof Error ? e.message : String(e)})`;
      }
      return `## ${toShortForm(m)}\n\n\`\`\`\n${clipBody(body)}\n\`\`\``;
    }
    case "knowledge": {
      // Pull the freshest body from the store first (already in memory).
      // Falls back to disk if the entry isn't loaded.
      const entry = useKnowledgeStore
        .getState()
        .entries.find((e) => e.id === m.id);
      let body = entry?.content ?? "";
      if (!body) {
        try {
          body = await invoke<string>("read_file_content", {
            path: m.filePath,
          });
        } catch {
          body = "(unable to read knowledge entry)";
        }
      }
      return `## ${toShortForm(m)}\n\n${clipBody(body)}`;
    }
    case "paper": {
      // The metadata JSON sidecar carries the abstract; the PDF body is too
      // heavy to inline. Read the sidecar and pull whatever long-form text
      // it has.
      let body: string;
      try {
        body = await invoke<string>("read_file_content", {
          path: m.metadataPath,
        });
      } catch {
        body = "(unable to read paper metadata)";
      }
      const authors = m.authors.length ? `Authors: ${m.authors.join(", ")}\n\n` : "";
      return `## ${toShortForm(m)}\n\n${authors}${clipBody(body)}`;
    }
    case "symbol":
      return `## ${toShortForm(m)}\n\n${m.signature}\n\n_(${m.symbolKind} at ${m.filePath}:${m.line})_`;
    case "past_message":
      return `## ${toShortForm(m)} _(from session ${m.sessionTitle})_\n\n${clipBody(m.content)}`;
    case "branch":
      // Branch shortname is the entire payload — no body block needed.
      return null;
  }
}

/** Build the final prompt sent to the agent. Inline references stay where
 *  the user typed them; deduplicated context blocks are appended at the
 *  bottom under a clear separator so JSONL transcripts stay scannable. */
export async function composePrompt(
  prosePlainText: string,
  mentions: MentionData[]
): Promise<string> {
  if (mentions.length === 0) return prosePlainText;

  // Dedupe by id — a user can reference the same file twice in one message
  // but the context block should only carry it once.
  const seen = new Set<string>();
  const uniq: MentionData[] = [];
  for (const m of mentions) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    uniq.push(m);
  }

  const blocks = await Promise.all(uniq.map(toContextBlock));
  const present = blocks.filter((b): b is string => b !== null);
  if (present.length === 0) return prosePlainText;

  return `${prosePlainText}\n\n---\n# Atlas context\n\n${present.join("\n\n")}\n`;
}

// ── Small utils ──────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}
