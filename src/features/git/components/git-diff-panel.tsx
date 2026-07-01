import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import {
  ChevronUp,
  ChevronDown,
  RefreshCw,
  ExternalLink,
  FileCode2,
} from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { openFile } from "@/lib/open-file";
import { getLanguage } from "../lib/diff";
import { highlightDiffLine } from "../lib/diff-highlight";
import { gitDiffStructured, type DiffSide, type DiffRow } from "../lib/git-diff-api";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useGitStore } from "../stores/git-store";
import { ChangedFilesTree } from "./changed-files-tree";
import { DiffMinimap } from "./diff-minimap";

// Match the CodeMirror editor's metrics (editor-panel.tsx: 14px / 18px) so the
// diff reads at the same scale as the code editor.
const ROW_H = 18;
const FONT_PX = 14;
const CENTER_W = 12; // center gutter: change-direction chevron (tight)
const RADIUS = 5;
const LINE_NO_W = 32; // `w-8` line-number gutter inside each SideCell
const CODE_PAD = 16; // `pl-2 pr-2` on the code cell

/** Width of one monospace character at `FONT_PX`, measured once. Nudged +2%
 *  so the computed column always errs slightly WIDE (a hair of trailing scroll)
 *  rather than narrow (which would clip the longest line). */
let cachedCharW = 0;
function monoCharWidth(): number {
  if (cachedCharW) return cachedCharW;
  let w = FONT_PX * 0.6;
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx) {
      // Mirror the diff's `font-mono` stack at FONT_PX.
      ctx.font = `${FONT_PX}px ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Code", monospace`;
      const m = ctx.measureText("MMMMMMMMMMMMMMMMMMMM").width / 20;
      if (m > 0) w = m;
    }
  } catch {
    /* headless / no canvas — fall back to the ratio */
  }
  cachedCharW = w * 1.02;
  return cachedCharW;
}

/** Character length of a diff side's rendered line (sum of its segments). */
function sideLen(side: DiffSide | null): number {
  if (!side) return 0;
  let n = 0;
  for (const s of side.segments) n += s.text.length;
  return n;
}

interface GitDiffPanelProps {
  /** Falls back to the active repo when opened as a standalone module. */
  repoPath?: string;
  /** Empty when opened as a module — the tree is shown and the pane prompts. */
  file?: string;
  staged?: boolean;
  /** When set, the diff for this file at a specific commit (via `git show`). */
  commit?: string | null;
}

function sideBg(side: DiffSide | null, isLeft: boolean): string | undefined {
  if (!side) return "rgba(255,255,255,0.018)"; // filler (no line on this side)
  if (side.kind === "context") return undefined;
  return isLeft ? "rgba(244,63,63,0.13)" : "rgba(34,197,94,0.13)";
}

function emphBg(isLeft: boolean): string {
  return isLeft ? "rgba(244,63,63,0.34)" : "rgba(52,211,153,0.34)";
}

const isLeftChange = (r?: DiffRow) => !!r?.left && r.left.kind !== "context";
const isRightChange = (r?: DiffRow) => !!r?.right && r.right.kind !== "context";

/** Render one line as syntax-highlighted spans, with word-level changed spans
 *  overlaid as a background mark. Merges the (foreground) highlight.js tokens
 *  with the (background) emphasis ranges at the character level. */
function CellContent({
  side,
  lang,
  isLeft,
}: {
  side: DiffSide;
  lang: string;
  isLeft: boolean;
}) {
  const text = side.segments.map((s) => s.text).join("");
  // Per-char emphasis flags from the engine's word-diff segments.
  const emph = new Uint8Array(text.length);
  let o = 0;
  for (const s of side.segments) {
    if (s.emph) for (let i = 0; i < s.text.length; i++) emph[o + i] = 1;
    o += s.text.length;
  }
  const tokens = highlightDiffLine(lang, text) ?? [{ text, cls: null }];

  const spans: React.ReactNode[] = [];
  let pos = 0;
  let key = 0;
  for (const t of tokens) {
    let i = 0;
    while (i < t.text.length) {
      const e = emph[pos + i];
      let j = i + 1;
      while (j < t.text.length && emph[pos + j] === e) j++;
      const slice = t.text.slice(i, j);
      spans.push(
        <span
          key={key++}
          className={t.cls ?? undefined}
          style={e ? { background: emphBg(isLeft), borderRadius: 2 } : undefined}
        >
          {slice}
        </span>,
      );
      i = j;
    }
    pos += t.text.length;
  }
  return <>{spans}</>;
}

function SideCell({
  side,
  lang,
  isLeft,
  roundTop,
  roundBot,
}: {
  side: DiffSide | null;
  lang: string;
  isLeft: boolean;
  roundTop: boolean;
  roundBot: boolean;
}) {
  const bg = sideBg(side, isLeft);
  return (
    <div className="flex min-w-0">
      <span className="w-8 shrink-0 select-none border-r border-[var(--border-subtle)] pr-[3px] pl-[3px] text-right font-mono text-[10px] leading-[18px] text-[var(--text-tertiary)]">
        {side?.lineNo ?? ""}
      </span>
      <code
        className="diff-syntax block flex-1 overflow-hidden whitespace-pre pl-2 pr-2 font-mono leading-[18px] text-[var(--text-secondary)]"
        style={{
          fontSize: FONT_PX,
          background: bg,
          borderTopLeftRadius: roundTop ? RADIUS : 0,
          borderTopRightRadius: roundTop ? RADIUS : 0,
          borderBottomLeftRadius: roundBot ? RADIUS : 0,
          borderBottomRightRadius: roundBot ? RADIUS : 0,
        }}
      >
        {side ? (
          // Panned horizontally by the shared `--diff-sx` (set on the scroll
          // container). `inline-block` sizes to the line so long content can
          // slide left/right inside the fixed, clipped cell.
          <span
            className="inline-block"
            style={{
              transform: "translateX(calc(var(--diff-sx, 0px) * -1))",
              willChange: "transform",
            }}
          >
            <CellContent side={side} lang={lang} isLeft={isLeft} />
          </span>
        ) : null}
      </code>
    </div>
  );
}

/** Center connector: chevron + tint linking a change across the two panes,
 *  evoking JetBrains' diff gutter. */
function CenterMarker({ row }: { row: DiffRow }) {
  const lc = isLeftChange(row);
  const rc = isRightChange(row);
  let char = "";
  let color = "var(--text-tertiary)";
  if (lc && rc) {
    char = "›";
  } else if (rc) {
    char = "»";
    color = "var(--status-success, #22c55e)";
  } else if (lc) {
    char = "«";
    color = "var(--status-error, #ef4444)";
  }
  return (
    <div
      className="flex items-center justify-center border-x border-[var(--border-subtle)] font-mono text-[11px] leading-[18px] select-none"
      style={{ color }}
    >
      {char}
    </div>
  );
}

/**
 * One side-by-side diff row, wrapped in `memo`. This is THE scroll-performance
 * lever: the virtualizer re-renders the whole list on every scroll frame, but
 * its props here (`row`/`prev`/`next` are stable refs from the query data,
 * `top`/`lang` are stable per index) don't change for a row that stays mounted,
 * so memo skips re-running the (span-heavy) cell render. Only the handful of
 * rows entering the window each frame do work — not all ~window rows.
 */
const DiffRow = memo(function DiffRow({
  row,
  prev,
  next,
  lang,
  top,
}: {
  row: DiffRow;
  prev?: DiffRow;
  next?: DiffRow;
  lang: string;
  top: number;
}) {
  const lc = isLeftChange(row);
  const rc = isRightChange(row);
  return (
    <div
      className="absolute left-0 right-0 grid"
      style={{
        top,
        height: ROW_H,
        // Panes are FIXED 50/50 with the marker between. Long lines don't widen
        // the panes; instead each cell clips (`overflow-hidden`) and its content
        // is panned by the shared `--diff-sx` offset (set on the scroll
        // container), so both panes scroll horizontally together.
        gridTemplateColumns: `1fr ${CENTER_W}px 1fr`,
      }}
    >
      <SideCell
        side={row.left}
        lang={lang}
        isLeft
        roundTop={lc && !isLeftChange(prev)}
        roundBot={lc && !isLeftChange(next)}
      />
      <CenterMarker row={row} />
      <SideCell
        side={row.right}
        lang={lang}
        isLeft={false}
        roundTop={rc && !isRightChange(prev)}
        roundBot={rc && !isRightChange(next)}
      />
    </div>
  );
});

export function GitDiffPanel({
  repoPath: repoPathProp,
  file = "",
  staged = false,
  commit = null,
}: GitDiffPanelProps) {
  const storeRepo = useGitStore.use.repoPath();
  const repoPath = repoPathProp || storeRepo || "";
  const scrollRef = useRef<HTMLDivElement>(null);
  const [blockCursor, setBlockCursor] = useState(0);
  const lang = getLanguage(file);

  const queryKey = ["git-diff", repoPath, file, staged, commit] as const;
  const { data, isLoading, refetch } = useQuery({
    queryKey,
    queryFn: () => gitDiffStructured(repoPath, file, staged, commit),
    enabled: !!repoPath && !!file,
    staleTime: 10_000,
  });

  useEffect(() => {
    const un = listen("atlas:git-changed", () => void refetch());
    return () => {
      un.then((u) => u());
    };
  }, [refetch]);

  const rows = data?.rows ?? [];
  const changeBlocks = data?.changeBlocks ?? [];

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 12,
  });

  const jump = (dir: 1 | -1) => {
    if (changeBlocks.length === 0) return;
    const next = (blockCursor + dir + changeBlocks.length) % changeBlocks.length;
    setBlockCursor(next);
    virtualizer.scrollToIndex(changeBlocks[next], { align: "center" });
  };

  const stats = data?.stats;
  const diffCount = changeBlocks.length;
  const items = virtualizer.getVirtualItems();

  // Longest line (in chars) across each pane — used to clamp the shared
  // horizontal pan (`--diff-sx`). Monospace, so no DOM measurement needed.
  const maxLineLen = useMemo(() => {
    let n = 0;
    for (const r of rows) {
      n = Math.max(n, sideLen(r.left), sideLen(r.right));
    }
    return n;
  }, [rows]);

  // Shared horizontal pan offset (px). Applied via the `--diff-sx` CSS var on
  // the scroll container so every row's content slides together without a
  // React re-render. Horizontal wheel / trackpad (or shift+wheel) drives it;
  // vertical passes through to the native scroller.
  const scrollXRef = useRef(0);
  useEffect(() => {
    // Reset the pan when the file / its content changes.
    scrollXRef.current = 0;
    scrollRef.current?.style.setProperty("--diff-sx", "0px");
  }, [file, staged, rows]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      let dx = 0;
      if (e.shiftKey) dx = e.deltaY || e.deltaX;
      else if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) dx = e.deltaX;
      else return; // vertical intent → let the native scroller handle it
      const paneInner = (el.clientWidth - CENTER_W) / 2 - LINE_NO_W - CODE_PAD;
      const maxSx = Math.max(0, Math.ceil(maxLineLen * monoCharWidth() - paneInner));
      if (maxSx <= 0) return;
      e.preventDefault();
      const next = Math.min(maxSx, Math.max(0, scrollXRef.current + dx));
      if (next !== scrollXRef.current) {
        scrollXRef.current = next;
        el.style.setProperty("--diff-sx", `${next}px`);
      }
    };
    // Non-passive so `preventDefault` actually suppresses the browser's
    // horizontal overscroll / back-nav gesture.
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [maxLineLen]);

  return (
    <PanelGroup
      direction="horizontal"
      autoSaveId="git-diff-tree"
      className="h-full bg-[var(--bg-primary)]"
    >
      {/* Left: resizable tree of changed files (+ commit picker) */}
      <Panel defaultSize={22} minSize={12} maxSize={45} className="min-w-0">
        <ChangedFilesTree repoPath={repoPath} staged={staged} currentFile={file} commit={commit} />
      </Panel>
      <PanelResizeHandle className="w-px bg-border-default hover:bg-accent data-[resize-handle-active]:bg-accent transition-colors cursor-col-resize" />

      {/* Main column: toolbar + diff body */}
      <Panel className="min-w-0">
      <div className="flex h-full min-w-0 flex-col">
      {/* Toolbar */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-3">
        <FileCode2 size={12} className="shrink-0 text-[var(--text-tertiary)]" />
        <span className="truncate font-mono text-[11px] text-[var(--text-secondary)]">
          {file || "Git Diff"}
        </span>
        {staged && (
          <span className="shrink-0 rounded bg-[var(--bg-elevated)] px-1.5 py-px text-[9px] uppercase tracking-wide text-[var(--text-tertiary)]">
            staged
          </span>
        )}
        {stats && (
          <span className="shrink-0 font-mono text-[10px]">
            <span className="text-[var(--status-success)]">+{stats.additions}</span>{" "}
            <span className="text-[var(--status-error)]">-{stats.deletions}</span>
          </span>
        )}
        {!!file && (
        <div className="ml-auto flex items-center gap-0.5">
          <span className="mr-1 font-mono text-[10px] text-[var(--text-tertiary)] tabular-nums">
            {diffCount} diff{diffCount !== 1 ? "s" : ""}
          </span>
          <button
            onClick={() => jump(-1)}
            disabled={diffCount === 0}
            className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-30 cursor-pointer"
            title="Previous change"
          >
            <ChevronUp size={12} />
          </button>
          <button
            onClick={() => jump(1)}
            disabled={diffCount === 0}
            className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-30 cursor-pointer"
            title="Next change"
          >
            <ChevronDown size={12} />
          </button>
          <button
            onClick={() => void refetch()}
            className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
            title="Refresh"
          >
            <RefreshCw size={11} />
          </button>
          <button
            onClick={() => void openFile(`${repoPath}/${file}`)}
            className="rounded p-1 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] cursor-pointer"
            title="Open in editor"
          >
            <ExternalLink size={11} />
          </button>
        </div>
        )}
      </div>

      {/* Body */}
      {!file ? (
        <div className="flex flex-1 items-center justify-center px-3 text-center text-[11px] text-[var(--text-tertiary)]">
          Pick a file from the left to view its diff — or choose a commit to browse.
        </div>
      ) : isLoading ? (
        <div className="px-3 py-8 text-center text-[11px] text-[var(--text-tertiary)]">
          Loading diff…
        </div>
      ) : data?.isBinary ? (
        <div className="px-3 py-8 text-center text-[11px] text-[var(--text-tertiary)]">
          Binary file — no text diff to show.
        </div>
      ) : rows.length === 0 ? (
        <div className="px-3 py-8 text-center text-[11px] text-[var(--text-tertiary)]">
          No changes.
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto hide-scrollbar">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((vr) => (
              <DiffRow
                key={vr.index}
                row={rows[vr.index]}
                prev={rows[vr.index - 1]}
                next={rows[vr.index + 1]}
                lang={lang}
                top={vr.start}
              />
            ))}
          </div>
        </div>
        {/* Right: change minimap synced to the diff scroll position */}
        <DiffMinimap rows={rows} scrollRef={scrollRef} />
        </div>
      )}
      </div>
      </Panel>
    </PanelGroup>
  );
}
