// Floating mention picker. Anchored to a fixed coordinate (the caret of the
// `@` in the CodeMirror composer), driven by an imperative keyboard API so
// the editor never loses focus.
//
// Two views:
//   • Empty query, no scope locked: "Recent files" (up to 5) → divider →
//     category headers. Headers act as scope-locks.
//   • Anything else: a single blended ranked list. Files dominate by
//     weight, but category-aliased queries (e.g. `@note auth`) boost the
//     matching kind so users can steer the result set.
//
// Keyboard contract: the parent component forwards Up/Down/Enter/Esc via
// the imperative handle so CM's focus stays put — the picker never has
// DOM focus.

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  BookOpen,
  FileText,
  Folder,
  FolderGit2,
  GitBranch,
  Hash,
  MessageSquare,
  Newspaper,
} from "lucide-react";
import { cn } from "@/lib/utils";

import {
  MENTION_CATEGORIES,
  categoryForKind,
  listMessagesInPastSession,
  listPastSessions,
  searchMentions,
  type MentionCategory,
  type MentionContext,
  type MentionData,
  type MentionKind,
  type PastSessionRef,
} from "@/features/chat/lib/mentions";
import {
  useRecentFilesStore,
  type RecentFile,
} from "@/features/chat/stores/recent-files-store";

// ── Public API ───────────────────────────────────────────────────────────────

export interface MentionPickerHandle {
  /** Move the active row down by 1. Wraps. */
  moveDown(): void;
  /** Move the active row up by 1. Wraps. */
  moveUp(): void;
  /** Commit the active row. Returns true if a real selection happened
   *  (mention inserted, or scope locked). False if there were no results
   *  so the parent can decide what Enter does in that case. */
  commit(): boolean;
  /** Pop one level back. Returns true if we actually went back (picker
   *  was at a sub-level), false if there's nothing above the current
   *  level (so the parent can close / delete a char). */
  goBack(): boolean;
}

export interface MentionPickerProps {
  /** When false, the popover unmounts and providers stop firing. */
  open: boolean;
  /** Query text typed after the `@` (excluding the `@` itself). */
  query: string;
  /** Caret position in viewport coords, used to anchor the popover. */
  anchor: { x: number; y: number } | null;
  /** Active project root — required for project-scoped sources. */
  projectPath: string | null;
  /** A mention was picked. Parent inserts the chip. */
  onSelect: (mention: MentionData) => void;
  /** Picker closed itself (Esc, no anchor, etc). */
  onClose: () => void;
  /** Optional `${kind}:${id}` set whose entries are hidden from the
   *  results (e.g. the knowledge editor passes the currently-open note
   *  so users can't @-reference the document they're editing). */
  excludeIds?: Set<string>;
  /** Additional CSS selectors that, if any ancestor matches, should
   *  NOT trigger an outside-click dismiss. Always includes
   *  `.atlas-chat-cm-host` and `.atlas-mention-picker`; callers in
   *  other surfaces (Tiptap, future composers) add their own. */
  hostSelectors?: string[];
  /** Lock the picker to a single kind from the moment it opens —
   *  skips the "Recents + Browse categories" empty view and goes
   *  straight to filtered results. Used by the kb editor's `#`
   *  trigger to scope the picker to knowledge notes only. */
  initialScope?: MentionKind | null;
}

// ── Internal model ───────────────────────────────────────────────────────────

/** One renderable row. Either a real mention or a category header (which
 *  acts as a scope-lock button when activated), or — for the Past Messages
 *  scope only — a "session" row that drills into that session's messages. */
type Row =
  | { type: "header"; label: string }
  | { type: "category"; cat: MentionCategory }
  | { type: "mention"; mention: MentionData; recentLabel?: string }
  | { type: "session"; session: PastSessionRef };

const RECENT_LIMIT = 5;

// ── Picker component ────────────────────────────────────────────────────────

export const MentionPicker = forwardRef<MentionPickerHandle, MentionPickerProps>(
  function MentionPicker(
    {
      open,
      query,
      anchor,
      projectPath,
      onSelect,
      onClose,
      excludeIds,
      hostSelectors,
      initialScope,
    },
    ref
  ) {
    const recentFiles = useRecentFilesStore.use.items();
    const [scope, setScope] = useState<MentionKind | null>(initialScope ?? null);
    /** When scope === "past_message" and no `pastSession` is locked, the
     *  picker shows a sessions list (level 1). Once `pastSession` is set,
     *  it shows messages inside that session (level 2). */
    const [pastSession, setPastSession] = useState<PastSessionRef | null>(null);
    const [pastSessions, setPastSessions] = useState<PastSessionRef[]>([]);
    const [results, setResults] = useState<MentionData[]>([]);
    const [active, setActive] = useState(0);

    // Reset transient state when the popover (re-)opens.
    // When `initialScope` is set, lock to that scope — the picker
    // then renders as if the user had drilled into that category.
    useEffect(() => {
      if (open) {
        setScope(initialScope ?? null);
        setPastSession(null);
        setActive(0);
      } else {
        setResults([]);
        setPastSessions([]);
      }
    }, [open, initialScope]);

    // Run providers on every (query, scope, pastSession, projectPath)
    // change. Each provider gets its own AbortSignal so stale results
    // from a prior query get dropped before they hit setState. The
    // past-message scope has its own two-level path:
    //   - no pastSession: load the session list once per scope-entry
    //   - pastSession set: search messages inside that session
    useEffect(() => {
      if (!open) return;
      const controller = new AbortController();
      const ctx: MentionContext = { projectPath };

      // Empty query + no scope renders "Recent files + Browse
      // categories" — the picker ignores `results` entirely in that
      // state. Short-circuit so we don't pay any IPC.
      if (!query.trim() && !scope) {
        setResults([]);
        setPastSessions([]);
        setActive(0);
        return () => controller.abort();
      }

      // No debounce — the Rust side reads everything from cached
      // state now (file index, folder list, git refs, knowledge,
      // symbols are all in `MentionCacheState` / `FileIndexState`),
      // so each invoke is sub-millisecond. Firing on every keystroke
      // keeps the picker truly live; the AbortController drops the
      // result of any in-flight invoke if a newer keystroke beat it
      // back, so stale results never paint.
      const applyExcludes = (items: MentionData[]) => {
        if (!excludeIds || excludeIds.size === 0) return items;
        return items.filter((m) => !excludeIds.has(`${m.kind}:${m.id}`));
      };
      if (scope === "past_message" && !pastSession) {
        void listPastSessions(ctx).then((sessions) => {
          if (controller.signal.aborted) return;
          const q = query.trim().toLowerCase();
          const filtered = q
            ? sessions.filter((s) => s.title.toLowerCase().includes(q))
            : sessions;
          setPastSessions(filtered.slice(0, 30));
          setResults([]);
          setActive(0);
        });
      } else if (scope === "past_message" && pastSession) {
        void listMessagesInPastSession(pastSession, query, controller.signal).then(
          (msgs) => {
            if (controller.signal.aborted) return;
            setResults(applyExcludes(msgs));
            setPastSessions([]);
            setActive(0);
          }
        );
      } else {
        void searchMentions(query, scope, ctx).then((r) => {
          if (controller.signal.aborted) return;
          setResults(applyExcludes(r));
          setPastSessions([]);
          setActive(0);
        });
      }

      return () => controller.abort();
    }, [open, query, scope, pastSession, projectPath, excludeIds]);

    // Build the renderable row list. Order:
    //   no scope + empty query → Recents (header) → files → Categories header → categories
    //   no scope + query       → blended results sorted by rank
    //   scope locked           → header showing scope → results in that scope
    const rows = useMemo<Row[]>(() => {
      const out: Row[] = [];
      if (scope === "past_message" && !pastSession) {
        out.push({ type: "header", label: "Past Messages · pick a session" });
        if (pastSessions.length === 0) {
          // No matches; header alone — the empty-state block below handles
          // copy when there's nothing else to show.
          return out;
        }
        for (const s of pastSessions) {
          out.push({ type: "session", session: s });
        }
        return out;
      }
      if (scope === "past_message" && pastSession) {
        out.push({
          type: "header",
          label: `↶ ${pastSession.title}`,
        });
        for (const m of results) {
          out.push({ type: "mention", mention: m });
        }
        return out;
      }
      if (scope) {
        out.push({ type: "header", label: categoryForKind(scope).label });
        for (const m of results) {
          out.push({ type: "mention", mention: m });
        }
        return out;
      }
      if (!query.trim()) {
        const recents = recentFiles.slice(0, RECENT_LIMIT);
        if (recents.length > 0) {
          out.push({ type: "header", label: "Recent files" });
          for (const r of recents) {
            out.push({
              type: "mention",
              mention: recentToMention(r),
              recentLabel: dirOf(r.rel),
            });
          }
        }
        out.push({ type: "header", label: "Browse" });
        for (const cat of MENTION_CATEGORIES) {
          out.push({ type: "category", cat });
        }
        return out;
      }
      // Blended: results are already ranked by Rust (nucleo), capped
      // top-N. JS just renders in the order Rust returned them — no
      // second scoring pass.
      for (const m of results) {
        out.push({ type: "mention", mention: m });
      }
      return out;
    }, [scope, query, results, recentFiles]);

    // Compute the navigable rows (skip headers). `active` is an index into
    // *navigable* rows, not the full list; the renderer maps it back.
    const navIndices = useMemo(() => {
      const idxs: number[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (rows[i].type !== "header") idxs.push(i);
      }
      return idxs;
    }, [rows]);

    useEffect(() => {
      if (active >= navIndices.length) setActive(0);
    }, [active, navIndices.length]);

    const activeRowIdx = navIndices[active];
    const activeRow: Row | undefined = activeRowIdx === undefined ? undefined : rows[activeRowIdx];

    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useImperativeHandle(
      ref,
      (): MentionPickerHandle => ({
        moveDown: () => {
          if (navIndices.length === 0) return;
          setActive((a) => (a + 1) % navIndices.length);
        },
        moveUp: () => {
          if (navIndices.length === 0) return;
          setActive((a) => (a - 1 + navIndices.length) % navIndices.length);
        },
        commit: () => {
          if (!activeRow) return false;
          if (activeRow.type === "category") {
            setScope(activeRow.cat.kind);
            setActive(0);
            return true;
          }
          if (activeRow.type === "session") {
            setPastSession(activeRow.session);
            setActive(0);
            return true;
          }
          if (activeRow.type === "mention") {
            onSelectRef.current(activeRow.mention);
            return true;
          }
          return false;
        },
        goBack: () => {
          if (pastSession) {
            setPastSession(null);
            setActive(0);
            return true;
          }
          // When a scope was locked from the outside (initialScope),
          // there's no "above" level to drop to — let the parent close.
          if (scope && !initialScope) {
            setScope(null);
            setActive(0);
            return true;
          }
          return false;
        },
      }),
      [activeRow, navIndices.length, pastSession, scope, initialScope]
    );

    // Dismiss on click outside the picker AND outside the host editor.
    // Defaults cover the chat composer (.atlas-chat-cm-host); other
    // surfaces (Tiptap, future composers) pass their own selectors via
    // `hostSelectors` so a click inside their editable doesn't dismiss.
    const hostSelectorsRef = useRef(hostSelectors);
    hostSelectorsRef.current = hostSelectors;
    useEffect(() => {
      if (!open) return;
      const handler = (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (target.closest(".atlas-chat-cm-host")) return;
        if (target.closest(".atlas-mention-picker")) return;
        const extras = hostSelectorsRef.current;
        if (extras) {
          for (const sel of extras) {
            if (target.closest(sel)) return;
          }
        }
        onCloseRef.current();
      };
      // Mousedown so we beat click handlers inside the editor.
      window.addEventListener("mousedown", handler);
      return () => window.removeEventListener("mousedown", handler);
    }, [open]);

    if (!open || !anchor) return null;

    // Position: prefer below the caret so it doesn't cover lines above
    // the cursor (the common case for mid-page editors like the
    // knowledge note editor). Fall back to above when there isn't
    // enough room below — that's the chat composer's case since it
    // sits flush at the bottom of the viewport.
    //
    // Coords come from `view.coordsAtPos` which is viewport-relative,
    // so `position: fixed` lines up cleanly regardless of sidebars or
    // resizable panels in between.
    const PICKER_WIDTH = 420;
    const PICKER_MAX_HEIGHT = 360;
    const GAP = 6;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(anchor.x, vw - PICKER_WIDTH - 8));
    // anchor.y is the caret's TOP. We need the line's height so the
    // popup sits just under the active line — we don't have it here,
    // so use a sensible default (matches the chat composer's caret).
    const LINE_HEIGHT = 20;
    const caretBottom = anchor.y + LINE_HEIGHT;
    const roomBelow = vh - caretBottom - 8;
    const placeBelow = roomBelow >= PICKER_MAX_HEIGHT;
    const positionStyle: React.CSSProperties = placeBelow
      ? { top: Math.max(8, caretBottom + GAP) }
      : { bottom: Math.max(8, vh - anchor.y + GAP) };

    return createPortal(
      <div
        className={cn(
          "atlas-mention-picker",
          "rounded-lg overflow-hidden",
          "bg-[var(--bg-secondary)] border border-[var(--border-default)]",
          "shadow-[0_8px_24px_rgba(0,0,0,0.5)]",
          "flex flex-col"
        )}
        // Keep mouse interactions from blurring CM:
        onMouseDown={(e) => e.preventDefault()}
        style={{
          position: "fixed",
          left,
          ...positionStyle,
          width: PICKER_WIDTH,
          maxHeight: PICKER_MAX_HEIGHT,
          zIndex: 9999,
        }}
      >
            {rows.length === 0 ||
            (rows.length === 1 && rows[0].type === "header") ? (
              <div className="flex-1 px-3 py-6 text-center text-[11px] text-[var(--text-tertiary)] leading-snug">
                {emptyStateCopy({
                  scope,
                  pastSession: pastSession !== null,
                  query: query.trim(),
                  hasProject: projectPath !== null,
                })}
              </div>
            ) : (
              <VirtualizedRows
                rows={rows}
                activeRowIdx={activeRowIdx}
                navIndices={navIndices}
                setActive={setActive}
                setScope={setScope}
                setPastSession={setPastSession}
                onSelect={onSelectRef}
              />
            )}
            <div className="border-t border-[var(--border-default)] px-3 h-[24px] flex items-center justify-between text-[9px] text-[var(--text-tertiary)] uppercase tracking-wider shrink-0">
              <span>
                {scope
                  ? `Scope: ${categoryForKind(scope).label}`
                  : query
                    ? "Filtered"
                    : "Top: recents · then categories"}
              </span>
              <span>↑↓ · ↵ select · ⎋ close</span>
            </div>
      </div>,
      document.body
    );
  }
);

// ── Virtualized row list ────────────────────────────────────────────────────
//
// All row types render in a uniform 26 px slot so the virtualizer's
// estimateSize is exact and there's no jump on first measurement.
// Header rows visually have slightly different padding but still fit
// inside the slot, so we don't pay measureElement cost.

const ROW_HEIGHT = 26;
const PICKER_INNER_MAX_HEIGHT = 336; // 360 (picker max) − 24 (footer)

function VirtualizedRows({
  rows,
  activeRowIdx,
  navIndices,
  setActive,
  setScope,
  setPastSession,
  onSelect,
}: {
  rows: Row[];
  activeRowIdx: number | undefined;
  navIndices: number[];
  setActive: (n: number) => void;
  setScope: (k: MentionKind) => void;
  setPastSession: (s: PastSessionRef) => void;
  onSelect: React.MutableRefObject<(m: MentionData) => void>;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // Auto-scroll so the active row stays visible as the user navigates
  // with the keyboard. Without this the active highlight can scroll
  // off-screen below the viewport on a long results list.
  useLayoutEffect(() => {
    if (activeRowIdx === undefined) return;
    virtualizer.scrollToIndex(activeRowIdx, { align: "auto" });
  }, [activeRowIdx, virtualizer]);

  return (
    <div
      ref={parentRef}
      className="flex-1 overflow-y-auto py-1"
      style={{ maxHeight: PICKER_INNER_MAX_HEIGHT }}
    >
      <div
        style={{
          height: virtualizer.getTotalSize(),
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((vRow) => {
          const i = vRow.index;
          const row = rows[i];
          const style: React.CSSProperties = {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: ROW_HEIGHT,
            transform: `translateY(${vRow.start}px)`,
          };
          if (row.type === "header") {
            return (
              <div
                key={`h-${i}`}
                style={style}
                className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-wider text-[var(--text-tertiary)] font-semibold"
              >
                {row.label}
              </div>
            );
          }
          const isActive = i === activeRowIdx;
          if (row.type === "category") {
            return (
              <button
                key={`c-${row.cat.kind}`}
                style={style}
                onMouseEnter={() => {
                  const navIdx = navIndices.indexOf(i);
                  if (navIdx >= 0) setActive(navIdx);
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setScope(row.cat.kind);
                  setActive(0);
                }}
                className={cn(
                  "text-left px-3 flex items-center gap-2 text-[11.5px]",
                  isActive
                    ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                )}
              >
                <span className="opacity-75 w-4 flex items-center justify-center">
                  <CategoryIcon kind={row.cat.kind} />
                </span>
                <span>{row.cat.label}</span>
              </button>
            );
          }
          if (row.type === "session") {
            return (
              <button
                key={`s-${row.session.id}`}
                style={style}
                onMouseEnter={() => {
                  const navIdx = navIndices.indexOf(i);
                  if (navIdx >= 0) setActive(navIdx);
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setPastSession(row.session);
                  setActive(0);
                }}
                className={cn(
                  "text-left px-3 flex items-center gap-2 text-[11.5px]",
                  isActive
                    ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
                )}
                title={row.session.filePath}
              >
                <span className="opacity-75 w-4 flex items-center justify-center">
                  <MessageSquare size={11} />
                </span>
                <span className="truncate flex-1 min-w-0">
                  {row.session.title}
                </span>
                <span className="text-[10px] text-[var(--text-tertiary)] shrink-0">
                  {row.session.messageCount} msgs
                </span>
              </button>
            );
          }
          const m = row.mention;
          return (
            <button
              key={`m-${m.kind}-${m.id}`}
              style={style}
              onMouseEnter={() => {
                const navIdx = navIndices.indexOf(i);
                if (navIdx >= 0) setActive(navIdx);
              }}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect.current(m);
              }}
              className={cn(
                "text-left px-3 flex items-center gap-2 text-[11.5px]",
                isActive
                  ? "bg-[var(--bg-selected)] text-[var(--text-primary)]"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
              )}
              title={mentionTitle(m)}
            >
              <span className="opacity-75 w-4 flex items-center justify-center">
                {m.kind === "knowledge" && m.icon ? (
                  <span style={{ fontSize: 12, lineHeight: 1 }}>{m.icon}</span>
                ) : (
                  <CategoryIcon kind={m.kind} />
                )}
              </span>
              <span className="truncate min-w-0 flex-shrink-0">
                {primaryLabel(m)}
              </span>
              <span className="flex-1 min-w-0 text-[10px] text-[var(--text-tertiary)] truncate">
                {row.recentLabel ?? secondaryLabel(m)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function recentToMention(r: RecentFile): MentionData {
  return {
    kind: "file",
    id: r.absPath,
    displayName: r.rel,
    absPath: r.absPath,
  };
}

function dirOf(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx > 0 ? rel.slice(0, idx) : "";
}

function CategoryIcon({ kind }: { kind: MentionKind }) {
  const size = 11;
  switch (kind) {
    case "file":         return <FileText size={size} />;
    case "folder":       return <Folder size={size} />;
    case "symbol":       return <Hash size={size} />;
    case "knowledge":    return <BookOpen size={size} />;
    case "repo":         return <FolderGit2 size={size} />;
    case "paper":        return <Newspaper size={size} />;
    case "branch":       return <GitBranch size={size} />;
    case "past_message": return <MessageSquare size={size} />;
  }
}

/** Primary label shown big in the picker row — last path segment, title,
 *  symbol name, etc. Matches Zed/VS Code's "name first, parent second"
 *  layout (see screenshot reference). */
function primaryLabel(m: MentionData): string {
  switch (m.kind) {
    case "file":
    case "folder":
      return basenameOf(m.displayName);
    default:
      return m.displayName;
  }
}

function secondaryLabel(m: MentionData): string {
  switch (m.kind) {
    case "file":
    case "folder":
      return dirOf(m.displayName);
    case "symbol":       return `${m.symbolKind} · ${shortPath(m.filePath)}`;
    case "knowledge":    return m.folder ? `${m.folder} · ${m.source}` : m.source;
    case "repo":         return m.hasReadme ? "cloned · README" : "cloned";
    case "paper":        return m.authors[0] ?? "";
    case "branch":       return m.refKind + (m.isCurrent ? " · HEAD" : "");
    case "past_message": return m.sessionTitle;
  }
}

function basenameOf(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx >= 0 ? rel.slice(idx + 1) : rel;
}

function shortPath(p: string): string {
  const parts = p.split("/");
  return parts.slice(-2).join("/");
}

function emptyStateCopy(args: {
  scope: MentionKind | null;
  pastSession: boolean;
  query: string;
  hasProject: boolean;
}): string {
  if (!args.hasProject) return "Open a project to browse references.";
  if (args.scope === "past_message" && !args.pastSession) {
    return args.query
      ? `No saved conversations matching "${args.query}".`
      : "No saved conversations in this project yet.";
  }
  if (args.scope === "past_message" && args.pastSession) {
    return args.query
      ? `No user messages matching "${args.query}".`
      : "No user messages in this session.";
  }
  if (args.scope) {
    const label = MENTION_CATEGORIES.find((c) => c.kind === args.scope)?.label ?? args.scope;
    return args.query
      ? `No ${label.toLowerCase()} matching "${args.query}".`
      : `No ${label.toLowerCase()} indexed yet.`;
  }
  return args.query
    ? `No matches for "${args.query}".`
    : "Pick a category, or type to search.";
}

function mentionTitle(m: MentionData): string {
  switch (m.kind) {
    case "file":         return m.absPath;
    case "folder":       return m.absPath;
    case "symbol":       return `${m.filePath}:${m.line}`;
    case "knowledge":    return m.filePath;
    case "repo":         return m.absPath;
    case "paper":        return m.metadataPath;
    case "branch":       return `${m.refKind} ${m.id} (${m.sha.slice(0, 7)})`;
    case "past_message": return m.content;
  }
}
