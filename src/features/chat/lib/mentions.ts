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

import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
import { useKnowledgeMetaStore } from "@/features/knowledge/stores/knowledge-meta-store";
import { useAnalysisStore } from "@/features/analysis/stores/analysis-store";
import { listClaudeSessions, readClaudeSession } from "./claude-api";
import { ensureFileIndex } from "@/features/file-picker/lib/file-picker-api";
import { activeWorkspaceId } from "@/features/workspaces/lib/active-workspace";
import { skills } from "@/features/skills/lib/skills-api";
import type { PackComponentKind } from "@/features/skills/lib/types";

// ── Types ────────────────────────────────────────────────────────────────────

export type MentionKind =
  | "file"
  | "folder"
  | "symbol"
  | "knowledge"
  | "skill"
  | "component"
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
  /** Per-note emoji/glyph from `_meta.json` (same source the knowledge
   *  tree uses). Null when the note has no custom icon. */
  icon: string | null;
  filePath: string;
  source: string;        // "note" | "paper" | "chat" | ...
  /** Parent folder portion of `id` (e.g. "Adib" for "Adib/weekly-notes").
   *  Surfaces the user's "spaces" — nested subfolders under
   *  `.atlas/knowledge/`. Null for top-level entries. */
  folder: string | null;
}

export interface MentionSkill {
  kind: "skill";
  /** `${scope}:${name}` — dedupe key across scopes. */
  id: string;
  displayName: string;   // skill name (the `#skill:<name>` token)
  description: string;
  scope: "global" | "project";
  /** Sanitized on-disk name, passed to `skills_read` at compose time. */
  skillName: string;
  /** Project root for project-scope reads; null for global. */
  projectPath: string | null;
  /** Absolute path to the canonical `SKILL.md` (Rust read fallback). */
  filePath: string;
}

export interface MentionComponent {
  kind: "component";
  /** `${scope}:${componentKind}:${pack}:${name}` — dedupe key. */
  id: string;
  displayName: string;   // component name (the `#<kind>:<name>` token)
  description: string;
  /** "command" | "agent" | "rule". */
  componentKind: PackComponentKind;
  /** Originating pack name. */
  pack: string;
  scope: "global" | "project";
  projectPath: string | null;
  /** Absolute path to the component body file (Rust read fallback). */
  filePath: string;
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
  | MentionSkill
  | MentionComponent
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
  { kind: "skill",        label: "Skills",          aliases: ["skill", "sk/"],            weight: 0.9  },
  { kind: "component",    label: "Pack Components", aliases: ["command", "agent", "rule", "cmd", "c/"], weight: 0.88 },
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

// ── Providers (removed) ─────────────────────────────────────────────────────
//
// Per-kind JS providers + the blended `rankMention` scorer used to
// live here. They've been replaced by `searchMentions` (defined
// further down) which delegates the whole search + ranking to one
// Rust command (`commands::mention_search`). The two-level
// past-message picker stays JS-side because it reads JSONL
// transcripts and has its own session-then-message UX.
//
// Past-session helpers below ↓

// (legacy providers removed — see header comment above)

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
    case "skill":
      return `#skill:${m.displayName}`;
    case "component":
      return `#${m.componentKind}:${m.displayName}`;
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

/** Unified mention search — runs in Rust. Replaces the per-provider
 *  JS fan-out + `rankMention` blending in `mention-picker.tsx`.
 *
 *  Rust owns the data for every kind:
 *   - file / folder via `FileIndexState` (live, watcher-updated)
 *   - repo via `list_cloned_repos` (cheap disk walk)
 *   - paper via `SavedPapersIndex` (mtime cache)
 *   - branch via watcher-invalidated `git_refs_cache`
 *   - knowledge / symbol via `MentionCacheState`, populated by the
 *     publishers below (`publishKnowledgeToMentionCache` etc.) when
 *     the JS stores hydrate or mutate. Per keystroke we DON'T ship
 *     these arrays anymore — that was the source of the picker's
 *     typing lag on large projects (100-500 KB JSON encode + IPC
 *     per keystroke).
 *
 *  Past-message is not handled here — it has its own two-level
 *  pick-session-then-search flow. */
export async function searchMentions(
  query: string,
  scope: MentionKind | null,
  ctx: MentionContext,
): Promise<MentionData[]> {
  if (scope === "past_message") return [];
  // Skills take the cheaper path: list the canonical store(s) and
  // substring-filter JS-side (no Rust `mention_search` change needed). Only
  // reachable when scope is locked to "skill" — i.e. the `#` trigger or the
  // Skills category — so the unscoped `@` blend stays unchanged.
  // The `#` rail (scope locked to "skill") invokes skills AND pack-delivered
  // components (command/agent/rule) — both inline their body at send time.
  if (scope === "skill") {
    const q = stripCategoryAlias(query, "skill");
    const [sk, comps] = await Promise.all([
      searchSkills(q, ctx),
      searchPackComponents(q, ctx),
    ]);
    return [...sk, ...comps];
  }
  if (scope === "component") {
    return searchPackComponents(stripCategoryAlias(query, "component"), ctx);
  }
  // File/folder mentions read from the same backend FileIndex as Cmd+P. If it
  // got stuck/unloaded, recover here too (cheap + coalesced once confirmed).
  if (scope === null || scope === "file" || scope === "folder") {
    await ensureFileIndex(ctx.projectPath);
  }
  // Knowledge lives in the Rust mention cache, which only fills when the KB
  // store loads. Self-heal it here so `~`/`@` work in chat even if the
  // Knowledge panel was never opened this session (coalesced + cached).
  if ((scope === null || scope === "knowledge") && ctx.projectPath) {
    await ensureKnowledgeMentionCache(ctx.projectPath);
  }
  try {
    const results = await invoke<MentionData[]>("mention_search", {
      query: stripCategoryAlias(query, scope ?? "file"),
      scope,
      projectPath: ctx.projectPath,
      workspaceId: activeWorkspaceId(),
    });
    return results;
  } catch (e) {
    console.warn("mention_search invoke failed:", e);
    return [];
  }
}

/** Skill search for the `#skill:` rail. Lists the canonical store for global
 *  and (when a project is open) project scope, then substring-filters by name
 *  or description. Project skills sort first (more specific), then alpha.
 *  Reuses the existing `skills_list` IPC — no new backend command. */
async function searchSkills(
  query: string,
  ctx: MentionContext,
): Promise<MentionSkill[]> {
  const q = query.trim().toLowerCase();
  const sources: { scope: "global" | "project"; projectPath: string | null }[] = [
    { scope: "global", projectPath: null },
  ];
  if (ctx.projectPath) {
    sources.push({ scope: "project", projectPath: ctx.projectPath });
  }

  const lists = await Promise.all(
    sources.map(async (s) => {
      try {
        const metas = await skills.list(s.scope, s.projectPath);
        return metas.map((meta) => ({ meta, source: s }));
      } catch (e) {
        console.warn(`skills_list (${s.scope}) failed:`, e);
        return [];
      }
    }),
  );

  const seen = new Set<string>();
  const out: MentionSkill[] = [];
  for (const { meta, source } of lists.flat()) {
    const id = `${source.scope}:${meta.name}`;
    if (seen.has(id)) continue;
    if (
      q &&
      !meta.name.toLowerCase().includes(q) &&
      !meta.description.toLowerCase().includes(q)
    ) {
      continue;
    }
    seen.add(id);
    out.push({
      kind: "skill",
      id,
      displayName: meta.name,
      description: meta.description,
      scope: source.scope,
      skillName: meta.name,
      projectPath: source.projectPath,
      filePath: meta.path,
    });
  }

  out.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "project" ? -1 : 1;
    return a.displayName.localeCompare(b.displayName);
  });
  return out;
}

/** Pack-component search for the `#` rail — lists installed-pack commands,
 *  agents, and rules (via `pack_components_list`) and substring-filters by name,
 *  description, or kind. Grouped by kind, then alpha. Mirrors `searchSkills`. */
async function searchPackComponents(
  query: string,
  ctx: MentionContext,
): Promise<MentionComponent[]> {
  const q = query.trim().toLowerCase();
  const sources: { scope: "global" | "project"; projectPath: string | null }[] = [
    { scope: "global", projectPath: null },
  ];
  if (ctx.projectPath) {
    sources.push({ scope: "project", projectPath: ctx.projectPath });
  }

  const lists = await Promise.all(
    sources.map(async (s) => {
      try {
        const metas = await skills.componentsList(s.scope, s.projectPath);
        return metas.map((meta) => ({ meta, source: s }));
      } catch (e) {
        console.warn(`pack_components_list (${s.scope}) failed:`, e);
        return [];
      }
    }),
  );

  const seen = new Set<string>();
  const out: MentionComponent[] = [];
  for (const { meta, source } of lists.flat()) {
    const id = `${source.scope}:${meta.kind}:${meta.pack}:${meta.name}`;
    if (seen.has(id)) continue;
    if (
      q &&
      !meta.name.toLowerCase().includes(q) &&
      !meta.description.toLowerCase().includes(q) &&
      !meta.kind.includes(q)
    ) {
      continue;
    }
    seen.add(id);
    out.push({
      kind: "component",
      id,
      displayName: meta.name,
      description: meta.description,
      componentKind: meta.kind,
      pack: meta.pack,
      scope: source.scope,
      projectPath: source.projectPath,
      filePath: meta.path,
    });
  }

  out.sort((a, b) =>
    a.componentKind !== b.componentKind
      ? a.componentKind.localeCompare(b.componentKind)
      : a.displayName.localeCompare(b.displayName),
  );
  return out;
}

/** Push knowledge entries into the Rust mention cache. Call from
 *  the JS knowledge store whenever `entries` is replaced or mutated,
 *  and from the meta store whenever a page-header title changes. */
export function publishKnowledgeToMentionCache(): Promise<void> {
  const pages = useKnowledgeMetaStore.getState().pages;
  const items = useKnowledgeStore.getState().entries.map((e) => {
    const override = pages[e.id]?.title?.trim();
    return {
      id: e.id,
      // Prefer the page-header title set via `_meta.json`; falls back
      // to the wire title (now just the filename) for untitled notes.
      title: override || e.title,
      // Same emoji the knowledge tree renders (meta.icon).
      icon: pages[e.id]?.icon ?? null,
      source: e.source,
      filePath: e.file_path,
    };
  });
  return invoke<void>("mention_cache_set_knowledge", {
    items,
    workspaceId: activeWorkspaceId(),
  }).catch((err) => console.warn("mention_cache_set_knowledge failed:", err));
}

// Coalesce the knowledge self-heal: which project we've already ensured this
// session, plus any in-flight ensure so concurrent keystrokes share one run.
let knowledgeEnsuredFor: string | null = null;
let knowledgeEnsuring: Promise<void> | null = null;

/** Mirror of `ensureFileIndex` for knowledge. The @-/~ picker reads knowledge
 *  from the Rust `MentionCacheState`, which is only populated when the JS
 *  knowledge store loads its entries — and that used to happen lazily, only
 *  when the Knowledge panel first mounted. So `~` in chat showed nothing until
 *  the user opened the KB. This loads the entries (if the panel never mounted)
 *  and (re)publishes them to this window's cache, coalesced + cached per
 *  project so it's a no-op cost after the first picker open. */
export async function ensureKnowledgeMentionCache(projectPath: string): Promise<void> {
  if (knowledgeEnsuredFor === projectPath) return;
  if (!knowledgeEnsuring) {
    knowledgeEnsuring = (async () => {
      const ks = useKnowledgeStore.getState();
      if (ks.entries.length === 0) {
        await ks.actions.loadEntries(projectPath);
      }
      // loadEntries publishes via a fire-and-forget dynamic import, so publish
      // explicitly here and await it to guarantee the cache is warm before the
      // first search reads it.
      await publishKnowledgeToMentionCache();
      knowledgeEnsuredFor = projectPath;
    })().finally(() => {
      knowledgeEnsuring = null;
    });
  }
  return knowledgeEnsuring;
}

/** Push symbols into the Rust mention cache. Call from the analysis
 *  store whenever a fresh `analyze_project` result lands. */
export function publishSymbolsToMentionCache(): void {
  const items = useAnalysisStore.getState().symbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    filePath: s.file_path,
    line: s.line,
    signature: s.signature,
  }));
  void invoke("mention_cache_set_symbols", {
    items,
    workspaceId: activeWorkspaceId(),
  }).catch((err) =>
    console.warn("mention_cache_set_symbols failed:", err),
  );
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
  const wireMentions = await Promise.all(
    mentions.map(async (m) => {
      if (m.kind === "knowledge") {
        return {
          ...m,
          inlineBody:
            useKnowledgeStore.getState().entries.find((e) => e.id === m.id)?.content ?? null,
        };
      }
      // Skills have no in-memory store, so read the frontmatter-stripped body
      // now (one cheap IPC per mentioned skill). Rust falls back to reading
      // `filePath` if this is null.
      if (m.kind === "skill") {
        let inlineBody: string | null = null;
        try {
          inlineBody = (await skills.read(m.scope, m.skillName, m.projectPath)).body;
        } catch (e) {
          console.warn("skills.read for compose failed:", e);
        }
        return { ...m, inlineBody };
      }
      return m;
    })
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
