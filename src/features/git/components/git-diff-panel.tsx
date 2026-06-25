import { useEffect, useRef, useState } from "react";
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

const ROW_H = 18;
const RADIUS = 5;

interface GitDiffPanelProps {
  repoPath: string;
  file: string;
  staged: boolean;
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
  const text = side?.segments.map((s) => s.text).join("") ?? "";
  return (
    <div className="flex min-w-0">
      <span className="w-10 shrink-0 select-none pr-2 text-right font-mono text-[10px] leading-[18px] text-[var(--text-tertiary)]">
        {side?.lineNo ?? ""}
      </span>
      <code
        className="diff-syntax block flex-1 overflow-hidden whitespace-pre pl-2 pr-2 font-mono text-[11px] leading-[18px] text-[var(--text-secondary)]"
        title={text}
        style={{
          background: bg,
          borderTopLeftRadius: roundTop ? RADIUS : 0,
          borderTopRightRadius: roundTop ? RADIUS : 0,
          borderBottomLeftRadius: roundBot ? RADIUS : 0,
          borderBottomRightRadius: roundBot ? RADIUS : 0,
        }}
      >
        {side ? <CellContent side={side} lang={lang} isLeft={isLeft} /> : null}
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
  let color = "transparent";
  if (lc && rc) {
    char = "›";
    color = "var(--text-tertiary)";
  } else if (rc) {
    char = "»";
    color = "var(--status-success, #22c55e)";
  } else if (lc) {
    char = "«";
    color = "var(--status-error, #ef4444)";
  }
  return (
    <div
      className="flex items-center justify-center font-mono text-[9px] leading-[18px] select-none"
      style={{ color }}
    >
      {char}
    </div>
  );
}

export function GitDiffPanel({ repoPath, file, staged }: GitDiffPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [blockCursor, setBlockCursor] = useState(0);
  const lang = getLanguage(file);

  const queryKey = ["git-diff", repoPath, file, staged] as const;
  const { data, isLoading, refetch } = useQuery({
    queryKey,
    queryFn: () => gitDiffStructured(repoPath, file, staged),
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
    overscan: 40,
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

  return (
    <div className="flex h-full flex-col bg-[var(--bg-primary)]">
      {/* Toolbar */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--border-default)] px-3">
        <FileCode2 size={12} className="shrink-0 text-[var(--text-tertiary)]" />
        <span className="truncate font-mono text-[11px] text-[var(--text-secondary)]">
          {file}
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
      </div>

      {/* Body */}
      {isLoading ? (
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
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto hide-scrollbar">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {items.map((vr) => {
              const idx = vr.index;
              const row = rows[idx];
              const prev = rows[idx - 1];
              const next = rows[idx + 1];
              const lc = isLeftChange(row);
              const rc = isRightChange(row);
              return (
                <div
                  key={idx}
                  className="absolute left-0 right-0 grid"
                  style={{
                    top: vr.start,
                    height: ROW_H,
                    gridTemplateColumns: "1fr 14px 1fr",
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
            })}
          </div>
        </div>
      )}
    </div>
  );
}
