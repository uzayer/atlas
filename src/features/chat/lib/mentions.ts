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
  | "folder"
  | "symbol"
  | "knowledge"
  | "repo"
  | "paper"
  | "branch"
  | "past_message";

export interface MentionFile {
  kind: "file";
  id: string;            // absolute path; also the de-dupe key
  displayName: string;   // relative path
  absPath: string;
}

export interface MentionFolder {
  kind: "folder";
  id: string;            // absolute path
  displayName: string;   // relative path (e.g. "src/features/chat")
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
  id: string;            // entry id — path under `.atlas/knowledge/`, may include "/"
  displayName: string;   // title
  filePath: string;
  source: string;        // "note" | "paper" | "chat" | ...
  /** Parent folder portion of `id` (e.g. "Adib" for "Adib/weekly-notes").
   *  Surfaces the user's "spaces" — nested subfolders under
   *  `.atlas/knowledge/`. Null for top-level entries. */
  folder: string | null;
}

export interface MentionRepo {
  kind: "repo";
  id: string;            // absolute path to the cloned repo
  displayName: string;   // repo folder name
  absPath: string;
  hasReadme: boolean;
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
  | MentionFolder
  | MentionSymbol
  | MentionKnowledge
  | MentionRepo
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
  { kind: "file",         label: "Files",           aliases: ["file", "f/"],              weight: 1.0  },
  { kind: "folder",       label: "Folders",         aliases: ["folder", "dir", "d/"],     weight: 0.95 },
  { kind: "symbol",       label: "Symbols",         aliases: ["symbol", "sym", "s/"],     weight: 0.85 },
  { kind: "knowledge",    label: "Knowledge",       aliases: ["note", "knowledge", "k/"], weight: 0.85 },
  { kind: "repo",         label: "Cloned Repos",    aliases: ["repo", "github", "gh/"],   weight: 0.8  },
  { kind: "paper",        label: "Papers",          aliases: ["paper", "p/"],             weight: 0.7  },
  { kind: "branch",       label: "Branches",        aliases: ["branch", "b/"],            weight: 0.6  },
  { kind: "past_message", label: "Past Messages",   aliases: ["msg", "message", "m/"],    weight: 0.55 },
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

const folderProvider: MentionProvider = {
  kind: "folder",
  async search(query, _ctx, signal) {
    if (signal.aborted) return [];
    const matches = await fileIndex.searchDirs(query, 30);
    if (signal.aborted) return [];
    return matches.map<MentionFolder>((m) => ({
      kind: "folder",
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
      // The id may be `Adib/weekly-notes` for nested entries — that's how
      // the user's mental model of "spaces" maps onto disk. Match against
      // the folder prefix too so typing `@adib` finds entries grouped
      // under the "Adib" space.
      const slash = e.id.lastIndexOf("/");
      const folder = slash > 0 ? e.id.slice(0, slash) : null;
      if (
        q &&
        !e.title.toLowerCase().includes(q) &&
        !(folder && folder.toLowerCase().includes(q))
      ) {
        continue;
      }
      out.push({
        kind: "knowledge",
        id: e.id,
        displayName: e.title,
        filePath: e.file_path,
        source: e.source,
        folder,
      });
      if (out.length >= 30) break;
    }
    return out;
  },
};

interface ClonedRepoRow {
  name: string;
  path: string;
  has_readme: boolean;
}
const repoProvider: MentionProvider = {
  kind: "repo",
  async search(query, ctx, signal) {
    if (!ctx.projectPath) return [];
    let repos: ClonedRepoRow[] = [];
    try {
      repos = await invoke<ClonedRepoRow[]>("list_cloned_repos", {
        projectPath: ctx.projectPath,
      });
    } catch {
      return [];
    }
    if (signal.aborted) return [];
    const q = query.toLowerCase();
    return repos
      .filter((r) => !q || r.name.toLowerCase().includes(q))
      .slice(0, 30)
      .map<MentionRepo>((r) => ({
        kind: "repo",
        id: r.path,
        displayName: r.name,
        absPath: r.path,
        hasReadme: r.has_readme,
      }));
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

// Two-level past-message picker support ─────────────────────────────────────
// The blended picker view shows just the top few user messages across the
// most recent sessions (kept narrow for speed). When the user locks scope
// to "Past Messages", we drill into a sessions-list first, then messages
// inside the chosen session. These helpers back that flow.

export interface PastSessionRef {
  id: string;
  title: string;
  filePath: string;
  lastModified: string | null;
  messageCount: number;
}

export async function listPastSessions(
  ctx: MentionContext
): Promise<PastSessionRef[]> {
  if (!ctx.projectPath) return [];
  try {
    const sessions = await listClaudeSessions(ctx.projectPath);
    return sessions.map((s) => ({
      id: s.id,
      title: s.preview && s.preview !== "(no user message)"
        ? s.preview
        : "Untitled session",
      filePath: s.file_path,
      lastModified: s.last_modified,
      messageCount: s.message_count,
    }));
  } catch {
    return [];
  }
}

export async function listMessagesInPastSession(
  session: PastSessionRef,
  query: string,
  signal: AbortSignal
): Promise<MentionPastMessage[]> {
  let dump;
  try {
    dump = await readClaudeSession(session.filePath);
  } catch {
    return [];
  }
  if (signal.aborted) return [];
  const q = query.toLowerCase();
  const out: MentionPastMessage[] = [];
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
      id: `${session.id}#${idx}`,
      displayName: truncate(content.replace(/\s+/g, " "), 60),
      sessionId: session.id,
      sessionTitle: session.title,
      timestamp: m.timestamp,
      content,
    });
    idx += 1;
  }
  return out;
}

export const PROVIDERS: Readonly<Record<MentionKind, MentionProvider>> = {
  file: fileProvider,
  folder: folderProvider,
  symbol: symbolProvider,
  knowledge: knowledgeProvider,
  repo: repoProvider,
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
    case "folder":
      return `@folder:${m.displayName}`;
    case "symbol":
      return `@symbol:${m.displayName}`;
    case "knowledge":
      return `@note:${m.id}`;
    case "repo":
      return `@repo:${m.displayName}`;
    case "paper":
      return `@paper:${m.displayName}`;
    case "branch":
      return `@branch:${m.displayName}`;
    case "past_message":
      return `@msg:${m.timestamp ?? m.id}`;
  }
}

/** Build the final prompt sent to the agent. Pure pass-through to a
 *  Rust command that:
 *   - dedupes mentions by id
 *   - fans out file reads in parallel on the tokio blocking pool
 *   - assembles the wire string with the same shape JS used to produce
 *     (`<prose>\n\n---\n# Atlas context\n\n## @ref\n\n…`)
 *
 *  Before this change every send paid N+1 IPC round-trips (N for the
 *  per-mention file reads + 1 for the final agent send). Now it's
 *  just one `compose_prompt` invoke that returns the composed string;
 *  the caller then ships that to the agent.
 *
 *  Knowledge entries pre-fill `inlineBody` from the in-memory store so
 *  Rust doesn't re-read them from disk. */
export async function composePrompt(
  prosePlainText: string,
  mentions: MentionData[]
): Promise<string> {
  if (mentions.length === 0) return prosePlainText;
  const wireMentions = mentions.map((m) =>
    m.kind === "knowledge"
      ? {
          ...m,
          inlineBody:
            useKnowledgeStore.getState().entries.find((e) => e.id === m.id)?.content ?? null,
        }
      : m
  );
  try {
    return await invoke<string>("compose_prompt", {
      prose: prosePlainText,
      mentions: wireMentions,
    });
  } catch (e) {
    console.warn("compose_prompt invoke failed, sending raw prose:", e);
    return prosePlainText;
  }
}

// ── Small utils ──────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + "…";
}
