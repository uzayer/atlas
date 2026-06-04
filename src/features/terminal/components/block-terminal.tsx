import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Loader2, CheckCircle2, XCircle, ChevronRight, Folder, Copy, RotateCw, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { openFile } from "@/lib/open-file";
import { useProjectStore } from "@/features/project/stores/project-store";
import { resolveTerminalFont } from "../utils/resolve-font";
import { ansiToSegments, type AnsiSegment } from "../lib/ansi-to-segments";
import { splitPaths } from "../lib/linkify-paths";
import { createTerminalKeymap } from "../lib/terminal-keymap";
import { createPathLinkProvider } from "../lib/path-link-provider";
import { BlockStreamParser, type TerminalBlock } from "../lib/block-parser";
import { CommandInput, type CommandInputHandle } from "./command-input";

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

/** Wrap case-insensitive matches of `query` in `text` with a <mark>. Matches
 *  carry `data-term-match` so the search bar can scroll between them. */
function renderHL(text: string, query: string): ReactNode {
  if (!query) return text;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  const nodes: ReactNode[] = [];
  let i = 0;
  let k = 0;
  for (;;) {
    const idx = lower.indexOf(q, i);
    if (idx < 0) {
      nodes.push(text.slice(i));
      break;
    }
    if (idx > i) nodes.push(text.slice(i, idx));
    nodes.push(
      <mark key={k++} data-term-match className="rounded-[2px] bg-[var(--status-warning)]/40 text-inherit">
        {text.slice(idx, idx + q.length)}
      </mark>
    );
    i = idx + q.length;
  }
  return nodes;
}

interface BlockTerminalProps {
  isActive: boolean;
  onFocus: () => void;
}

// ANSI palette for the interactive xterm surface — matches ansi-to-segments so
// blocks and the live surface look the same.
const XTERM_THEME = {
  background: "#000000",
  foreground: "#cccccc",
  cursor: "#b3b3b3",
  selectionBackground: "#303030",
  black: "#1a1a1a", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
  blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#cccccc",
  brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
  brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
  brightCyan: "#56b6c2", brightWhite: "#ffffff",
};

/**
 * Block terminal. The PTY (zsh shell integration) streams raw bytes to BOTH:
 *   - an embedded xterm (the interactive surface) — shown only when an app
 *     enters the alt-screen (vim/htop/less); and
 *   - `BlockStreamParser`, which segments normal command output into React
 *     "blocks" rendered with ANSI→styled spans.
 * The React command input sends lines to the shell; when an alt-screen app is
 * running, keystrokes go to xterm instead.
 */
export function BlockTerminal({ isActive, onFocus }: BlockTerminalProps) {
  const [blocks, setBlocks] = useState<TerminalBlock[]>([]);
  const [altScreen, setAltScreen] = useState(false);
  const [search, setSearch] = useState({ open: false, query: "" });
  const [matchCount, setMatchCount] = useState(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const matchIdxRef = useRef(-1);

  const parserRef = useRef<BlockStreamParser | null>(null);
  const decoderRef = useRef(new TextDecoder());
  const ptyRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const commandInputRef = useRef<CommandInputHandle>(null);

  const xtermRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const xtermHostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let unOut: (() => void) | null = null;
    let unExit: (() => void) | null = null;
    const cwd = useProjectStore.getState().currentProject?.path ?? "~";

    const parser = new BlockStreamParser(cwd, () => {
      if (disposed) return;
      setBlocks([...parser.blocks]);
      setAltScreen(parser.altScreen);
    });
    parserRef.current = parser;

    void (async () => {
      // Interactive surface (xterm) — processes the full stream so it's ready
      // the instant an app enters the alt-screen.
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      await import("@xterm/xterm/css/xterm.css");
      if (disposed || !xtermHostRef.current) return;
      const fontFamily = await resolveTerminalFont(13);
      if (disposed || !xtermHostRef.current) return;

      const term = new Terminal({
        fontFamily,
        fontSize: 13,
        lineHeight: 1.4,
        scrollback: 5000,
        cursorBlink: true,
        allowProposedApi: true,
        theme: XTERM_THEME,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      try {
        const { Unicode11Addon } = await import("@xterm/addon-unicode11");
        term.loadAddon(new Unicode11Addon());
        term.unicode.activeVersion = "11";
      } catch {
        /* non-fatal */
      }
      term.open(xtermHostRef.current);
      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const w = new WebglAddon();
        w.onContextLoss(() => w.dispose());
        term.loadAddon(w);
      } catch {
        /* DOM renderer */
      }
      xtermRef.current = term;
      fitRef.current = fit;

      let cols = 80;
      let rows = 24;
      try {
        fit.fit();
        cols = term.cols;
        rows = term.rows;
      } catch {
        /* keep defaults */
      }

      const id = await invoke<string>("terminal_create", { cols, rows, cwd });
      if (disposed) {
        void invoke("terminal_close", { id }).catch(() => {});
        return;
      }
      ptyRef.current = id;

      // Interactive-surface parity with the classic terminal: word/line
      // navigation + ⌘C/⌘V/⌘A copy-paste, and ⌘-click file paths.
      const keymap = createTerminalKeymap(term);
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;
        const nav = keymap(e);
        if (nav === "handled") return false;
        if (typeof nav === "string") {
          void invoke("terminal_write", {
            id,
            data: Array.from(new TextEncoder().encode(nav)),
          }).catch(() => {});
          return false;
        }
        const mod = e.metaKey || (e.ctrlKey && e.shiftKey);
        const key = e.key.toLowerCase();
        if (mod && key === "c") {
          if (term.hasSelection()) {
            e.preventDefault();
            void navigator.clipboard.writeText(term.getSelection()).catch(() => {});
          }
          return false;
        }
        if (mod && key === "v") {
          e.preventDefault();
          void navigator.clipboard.readText().then((t) => t && term.paste(t)).catch(() => {});
          return false;
        }
        if (e.metaKey && key === "a") {
          e.preventDefault();
          term.selectAll();
          return false;
        }
        return true;
      });
      term.registerLinkProvider(createPathLinkProvider(term, id));

      // Keystrokes from the interactive surface → PTY.
      term.onData((d) => {
        const tid = ptyRef.current;
        if (tid && !disposed) {
          void invoke("terminal_write", {
            id: tid,
            data: Array.from(new TextEncoder().encode(d)),
          }).catch(() => {});
        }
      });

      unOut = await listen<{ id: string; data: number[] }>("terminal-output", (e) => {
        if (e.payload.id !== id || disposed) return;
        const bytes = new Uint8Array(e.payload.data);
        term.write(bytes); // interactive surface
        parser.push(decoderRef.current.decode(bytes, { stream: true })); // blocks
      });
      unExit = await listen<{ id: string }>("terminal-exit", () => {});
    })();

    return () => {
      disposed = true;
      unOut?.();
      unExit?.();
      xtermRef.current?.dispose();
      if (ptyRef.current) void invoke("terminal_close", { id: ptyRef.current }).catch(() => {});
    };
  }, []);

  // Keep the PTY sized to the surface (drives wrapping for both views).
  useEffect(() => {
    const host = xtermHostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const t = xtermRef.current;
      const f = fitRef.current;
      const id = ptyRef.current;
      if (!t || !f) return;
      try {
        f.fit();
      } catch {
        return;
      }
      if (id) void invoke("terminal_resize", { id, cols: t.cols, rows: t.rows }).catch(() => {});
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  // Pin to the bottom as output streams.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && !altScreen) el.scrollTop = el.scrollHeight;
  }, [blocks, altScreen]);

  // Focus the right surface: xterm while an alt-screen app runs, else the input.
  useEffect(() => {
    if (!isActive) return;
    if (altScreen) xtermRef.current?.focus();
    else commandInputRef.current?.focus();
  }, [isActive, altScreen]);

  // External focus request (⌘J / focus-terminal shortcut).
  useEffect(() => {
    const handler = () => {
      if (!isActive) return;
      if (parserRef.current?.altScreen) xtermRef.current?.focus();
      else commandInputRef.current?.focus();
    };
    window.addEventListener("atlas:focus-terminal", handler);
    return () => window.removeEventListener("atlas:focus-terminal", handler);
  }, [isActive]);

  const runCommand = useCallback((cmd: string) => {
    const id = ptyRef.current;
    if (!id) return;
    void invoke("terminal_write", {
      id,
      data: Array.from(new TextEncoder().encode(cmd + "\n")),
    }).catch(() => {});
  }, []);

  const interrupt = useCallback(() => {
    const id = ptyRef.current;
    if (id) void invoke("terminal_write", { id, data: [0x03] }).catch(() => {});
  }, []);

  // ⌘F / Ctrl+F opens search over the block history.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isActive || altScreen) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearch((s) => ({ ...s, open: true }));
        requestAnimationFrame(() => searchInputRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isActive, altScreen]);

  // Recount matches whenever the query or content changes.
  useEffect(() => {
    matchIdxRef.current = -1;
    const els = scrollRef.current?.querySelectorAll("[data-term-match]");
    setMatchCount(els ? els.length : 0);
  }, [search.query, blocks]);

  const navMatch = useCallback((dir: 1 | -1) => {
    const els = scrollRef.current?.querySelectorAll<HTMLElement>("[data-term-match]");
    if (!els || !els.length) return;
    matchIdxRef.current = (matchIdxRef.current + dir + els.length) % els.length;
    els.forEach((el) => el.classList.remove("term-match-active"));
    const el = els[matchIdxRef.current];
    el.classList.add("term-match-active");
    el.scrollIntoView({ block: "center" });
  }, []);

  const closeSearch = useCallback(() => {
    setSearch({ open: false, query: "" });
    commandInputRef.current?.focus();
  }, []);

  return (
    <div className="relative flex h-full w-full flex-col bg-[var(--bg-base)]" onClick={onFocus}>
      {/* Interactive surface — overlays the block list while an alt-screen app runs. */}
      <div
        ref={xtermHostRef}
        className="absolute inset-0 z-10 bg-[#000] px-1 py-1"
        style={{
          visibility: altScreen ? "visible" : "hidden",
          pointerEvents: altScreen ? "auto" : "none",
        }}
      />

      {/* Search bar over the block history */}
      {search.open && !altScreen && (
        <div className="absolute right-2 top-2 z-20 flex items-center gap-1 rounded-md border border-[var(--border-default)] bg-[var(--bg-overlay)] px-2 py-1 shadow-[var(--shadow-overlay)]">
          <Search size={12} className="shrink-0 text-[var(--text-tertiary)]" />
          <input
            ref={searchInputRef}
            value={search.query}
            onChange={(e) => setSearch((s) => ({ ...s, query: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === "Escape") closeSearch();
              else if (e.key === "Enter") navMatch(e.shiftKey ? -1 : 1);
            }}
            placeholder="Search output…"
            className="w-44 bg-transparent text-[12px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
          />
          <span className="w-10 shrink-0 text-right text-[10px] tabular-nums text-[var(--text-tertiary)]">
            {matchCount}
          </span>
          <button type="button" onClick={() => navMatch(-1)} className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <ChevronUp size={13} />
          </button>
          <button type="button" onClick={() => navMatch(1)} className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <ChevronDown size={13} />
          </button>
          <button type="button" onClick={closeSearch} className="rounded p-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]">
            <X size={13} />
          </button>
        </div>
      )}

      {/* Block list */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto hide-scrollbar px-3 py-2"
        style={{ visibility: altScreen ? "hidden" : "visible" }}
      >
        {blocks.map((b) => (
          <BlockCard key={b.id} block={b} onRerun={runCommand} query={search.query} />
        ))}
      </div>

      {/* Command input (hidden while an interactive app owns the screen).
          min-h-[28px] + items-center matches the neighbouring panel footers /
          the terminal pane header so the top borders line up. */}
      {!altScreen && (
        <div className="flex min-h-[28px] items-center gap-2 border-t border-[var(--border-default)] bg-[var(--bg-base)] px-3 py-[5px]">
          <ChevronRight size={13} className="shrink-0 text-[var(--accent-primary)]" />
          <CommandInput
            ref={commandInputRef}
            onSubmit={runCommand}
            onInterrupt={interrupt}
          />
        </div>
      )}
    </div>
  );
}

function BlockCard({
  block,
  onRerun,
  query,
}: {
  block: TerminalBlock;
  onRerun: (cmd: string) => void;
  query: string;
}) {
  const segments = useMemo(() => ansiToSegments(block.output), [block.output]);
  const cwdName = block.cwd ? block.cwd.split("/").filter(Boolean).pop() : "";
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const hasHeader = block.command !== "";

  const duration =
    !block.running && block.endedAt ? formatDuration(block.endedAt - block.startedAt) : null;

  const copyOutput = (e: React.MouseEvent) => {
    e.stopPropagation();
    const plain = segments.map((s) => s.text).join("");
    void navigator.clipboard.writeText(plain).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="group mb-2 overflow-hidden rounded-md border border-[var(--border-default)] bg-[var(--bg-raised)]">
      {hasHeader && (
        <div className="flex items-center gap-2 border-b border-[var(--border-subtle)] px-2.5 h-[28px] text-[12px]">
          {block.running ? (
            <Loader2 size={12} className="shrink-0 animate-spin text-[var(--accent-primary)]" />
          ) : block.exitCode && block.exitCode !== 0 ? (
            <XCircle size={12} className="shrink-0 text-[var(--status-error)]" />
          ) : (
            <CheckCircle2 size={12} className="shrink-0 text-[var(--status-success)]" />
          )}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="truncate text-left font-mono text-[var(--text-primary)] hover:opacity-80"
            title={collapsed ? "Expand" : "Collapse"}
          >
            {renderHL(block.command, query)}
          </button>

          <div className="ml-auto flex items-center gap-2 text-[10px] text-[var(--text-tertiary)]">
            {/* Hover actions */}
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <BlockAction title={copied ? "Copied" : "Copy output"} onClick={copyOutput} icon={Copy} />
              <BlockAction title="Rerun" onClick={(e) => { e.stopPropagation(); onRerun(block.command); }} icon={RotateCw} />
              <BlockAction
                title={collapsed ? "Expand" : "Collapse"}
                onClick={(e) => { e.stopPropagation(); setCollapsed((c) => !c); }}
                icon={ChevronDown}
                rotated={collapsed}
              />
            </div>
            {cwdName && (
              <span className="flex items-center gap-1">
                <Folder size={9} />
                {cwdName}
              </span>
            )}
            {duration && <span>{duration}</span>}
            {!block.running && block.exitCode != null && block.exitCode !== 0 && (
              <span className="text-[var(--status-error)]">exit {block.exitCode}</span>
            )}
          </div>
        </div>
      )}
      {!collapsed && segments.length > 0 && (
        <BlockOutput segments={segments} cwd={block.cwd} query={query} />
      )}
    </div>
  );
}

function BlockAction({
  title,
  onClick,
  icon: Icon,
  rotated,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  icon: typeof Copy;
  rotated?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
    >
      <Icon size={11} className={cn("transition-transform", rotated && "-rotate-90")} />
    </button>
  );
}

function BlockOutput({ segments, cwd, query }: { segments: AnsiSegment[]; cwd: string; query: string }) {
  const openPath = useCallback(
    (raw: string) => {
      void invoke<string | null>("resolve_path", { base: cwd, raw })
        .then((abs) => {
          if (abs) openFile(abs);
        })
        .catch(() => {});
    },
    [cwd]
  );

  return (
    <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-[1.45] text-[var(--text-secondary)]">
      {segments.flatMap((s, i) =>
        splitPaths(s.text).map((p, j) =>
          p.isPath ? (
            <span
              key={`${i}-${j}`}
              style={s.style}
              title="⌘-click to open"
              className="cursor-pointer hover:text-[var(--accent-primary)] hover:underline"
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) openPath(p.text);
              }}
            >
              {renderHL(p.text, query)}
            </span>
          ) : (
            <span key={`${i}-${j}`} style={s.style}>
              {renderHL(p.text, query)}
            </span>
          )
        )
      )}
    </pre>
  );
}
