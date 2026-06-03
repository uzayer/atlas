import { useEffect, useRef, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useProjectStore } from "@/features/project/stores/project-store";
import { resolveTerminalFont } from "../utils/resolve-font";
import { createPathLinkProvider } from "../lib/path-link-provider";
import { createTerminalKeymap } from "../lib/terminal-keymap";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "@/ui/context-menu";
import { KbdCombo } from "@/ui/kbd";

interface TerminalInstanceProps {
  isActive: boolean;
  isVisible: boolean;
  onFocus: () => void;
}

interface TerminalOutput {
  id: string;
  data: number[];
}

export function TerminalInstance({ isActive, isVisible, onFocus }: TerminalInstanceProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const backendPtyIdRef = useRef<string | null>(null);
  const isInitializedRef = useRef(false);
  const isInitializingRef = useRef(false);
  const unlistenOutputRef = useRef<(() => void) | null>(null);
  const unlistenExitRef = useRef<(() => void) | null>(null);
  const outputBufferRef = useRef<Uint8Array[]>([]);
  const outputFlushRafRef = useRef<number | null>(null);
  const linkDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);

  // Clipboard / selection actions — shared by the keyboard handler and the
  // right-click context menu. They operate on the live xterm instance.
  const copySelection = useCallback(() => {
    const t = xtermRef.current;
    if (t?.hasSelection()) {
      void navigator.clipboard.writeText(t.getSelection()).catch(() => {});
    }
    t?.focus();
  }, []);
  const pasteClipboard = useCallback(() => {
    const t = xtermRef.current;
    if (!t) return;
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) t.paste(text);
      })
      .catch(() => {})
      .finally(() => t.focus());
  }, []);
  const selectAllTerm = useCallback(() => {
    xtermRef.current?.selectAll();
  }, []);
  const clearTerm = useCallback(() => {
    xtermRef.current?.clear();
    xtermRef.current?.focus();
  }, []);

  // RAF-batched output flush — merge all buffered chunks into single write
  const flushOutput = useCallback(() => {
    outputFlushRafRef.current = null;
    const chunks = outputBufferRef.current;
    if (chunks.length === 0 || !xtermRef.current) return;
    outputBufferRef.current = [];
    if (chunks.length === 1) {
      xtermRef.current.write(chunks[0]);
    } else {
      const total = chunks.reduce((sum, c) => sum + c.length, 0);
      const merged = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
      xtermRef.current.write(merged);
    }
  }, []);

  const scheduleOutputFlush = useCallback(() => {
    if (outputFlushRafRef.current !== null) return;
    outputFlushRafRef.current = requestAnimationFrame(flushOutput);
  }, [flushOutput]);

  // Multi-attempt fit with RAF retry
  const fitTerminal = useCallback((attempts: number) => {
    let attempt = 0;
    let rafId: number | null = null;

    const runFit = () => {
      rafId = null;
      const container = containerRef.current;
      const fitAddon = fitAddonRef.current;
      const term = xtermRef.current;
      if (!container || !fitAddon || !term) return;

      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) {
        if (attempt < attempts - 1) {
          attempt++;
          rafId = requestAnimationFrame(runFit);
        }
        return;
      }

      try { fitAddon.fit(); } catch {}

      if (backendPtyIdRef.current) {
        invoke("terminal_resize", {
          id: backendPtyIdRef.current,
          cols: term.cols,
          rows: term.rows,
        }).catch(() => {});
      }

      if (attempt < attempts - 1) {
        attempt++;
        rafId = requestAnimationFrame(runFit);
      }
    };

    rafId = requestAnimationFrame(runFit);
    return () => { if (rafId !== null) cancelAnimationFrame(rafId); };
  }, []);

  // Verified focus with RAF retry
  const verifyFocus = useCallback((maxAttempts: number) => {
    let cancelled = false;

    const tryFocus = (attempt: number) => {
      if (cancelled || !xtermRef.current || attempt >= maxAttempts) return;
      xtermRef.current.focus();

      requestAnimationFrame(() => {
        if (cancelled || !xtermRef.current) return;
        const textarea = xtermRef.current.textarea;
        if (textarea && document.activeElement !== textarea) {
          tryFocus(attempt + 1);
        }
      });
    };

    // Wait 2 frames for layout to settle after display change
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) tryFocus(0);
      });
    });

    return () => { cancelled = true; };
  }, []);

  // Lazy initialization — only when first becomes visible
  useEffect(() => {
    if (!isVisible || isInitializedRef.current || isInitializingRef.current || !containerRef.current) return;
    isInitializingRef.current = true;

    let disposed = false;

    (async () => {
      const { Terminal } = await import("@xterm/xterm");
      const { FitAddon } = await import("@xterm/addon-fit");
      await import("@xterm/xterm/css/xterm.css");

      // Resolve the font BEFORE constructing the terminal. xterm measures the
      // character cell once at init from the first resolvable font; if that
      // happens before fonts are ready (common in a cold-loaded production
      // build, less so in dev where the cache is warm) the whole grid is
      // mis-sized. `resolveTerminalFont` awaits `document.fonts.ready` and
      // guarantees a native + generic fallback so rendering is identical
      // across dev and the shipped app.
      const fontFamily = await resolveTerminalFont(13);

      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        fontFamily,
        fontSize: 13,
        lineHeight: 1.4,
        scrollback: 5000,
        theme: {
          background: "#000000",
          foreground: "#999999",
          cursor: "#b3b3b3",
          cursorAccent: "#000000",
          selectionBackground: "#303030",
          selectionForeground: "#ffffff",
          black: "#000000",
          red: "#999999",
          green: "#4d4d4d",
          yellow: "#b3b3b3",
          blue: "#333333",
          magenta: "#999999",
          cyan: "#666666",
          white: "#cccccc",
          brightBlack: "#1a1a1a",
          brightRed: "#999999",
          brightGreen: "#4d4d4d",
          brightYellow: "#b3b3b3",
          brightBlue: "#333333",
          brightMagenta: "#999999",
          brightCyan: "#666666",
          brightWhite: "#ffffff",
        },
        cursorBlink: true,
        cursorStyle: "bar",
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(containerRef.current);

      // Word/line navigation + keyboard selection (Option/Cmd + arrows, etc.).
      const keymap = createTerminalKeymap(term);

      // Copy/paste — intercept ⌘C/⌘V/⌘A (and Ctrl+Shift+C/V) before xterm
      // forwards them to the PTY. Plain Ctrl+C is NOT intercepted, so SIGINT
      // still works. Returning false stops xterm from sending the key.
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== "keydown") return true;

        // Textual navigation (sends readline seqs) / keyboard selection.
        const nav = keymap(e);
        if (nav === "handled") return false;
        if (typeof nav === "string") {
          const id = backendPtyIdRef.current;
          if (id) {
            void invoke("terminal_write", {
              id,
              data: Array.from(new TextEncoder().encode(nav)),
            }).catch(() => {});
          }
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
          void navigator.clipboard
            .readText()
            .then((text) => {
              if (text) term.paste(text);
            })
            .catch(() => {});
          return false;
        }
        if (e.metaKey && key === "a") {
          e.preventDefault();
          term.selectAll();
          return false;
        }
        return true;
      });

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;
      isInitializedRef.current = true;
      isInitializingRef.current = false;

      // Initial fit
      fitTerminal(6);

      // Create PTY
      try {
        const backendId = await invoke<string>("terminal_create", {
          cols: term.cols,
          rows: term.rows,
          cwd: useProjectStore.getState().currentProject?.path ?? null,
        });
        if (disposed) { invoke("terminal_close", { id: backendId }).catch(() => {}); return; }
        backendPtyIdRef.current = backendId;

        // ⌘-clickable file paths (⌘-hover underlines, ⌘-click opens). Resolution
        // (cwd join, ~ expand, existence) happens in `terminal_resolve_path`.
        linkDisposableRef.current = term.registerLinkProvider(
          createPathLinkProvider(term, backendId),
        );

        // Listen for output — buffer as Uint8Array and flush per frame
        unlistenOutputRef.current = await listen<TerminalOutput>("terminal-output", (event) => {
          if (event.payload.id === backendId && !disposed) {
            outputBufferRef.current.push(new Uint8Array(event.payload.data));
            scheduleOutputFlush();
          }
        });

        unlistenExitRef.current = await listen<{ id: string }>("terminal-exit", (event) => {
          if (event.payload.id === backendId) {
            term.writeln("\r\n\x1b[38;2;69;63;48m[Process exited]\x1b[0m");
          }
        });

        // Forward user input
        term.onData((data) => {
          if (backendPtyIdRef.current && !disposed) {
            const encoded = new TextEncoder().encode(data);
            invoke("terminal_write", { id: backendPtyIdRef.current, data: Array.from(encoded) }).catch(() => {});
          }
        });
      } catch (err) {
        term.writeln(`\x1b[38;2;154;60;60mFailed to create terminal: ${err}\x1b[0m`);
        term.write("$ ");
        let lineBuffer = "";
        term.onData((data) => {
          const code = data.charCodeAt(0);
          if (code === 13) { term.writeln(""); lineBuffer = ""; term.write("$ "); }
          else if (code === 127) { if (lineBuffer.length > 0) { lineBuffer = lineBuffer.slice(0, -1); term.write("\b \b"); } }
          else if (code >= 32) { lineBuffer += data; term.write(data); }
        });
      }

      // ResizeObserver with RAF debounce
      let resizeRafId: number | null = null;
      const observer = new ResizeObserver(() => {
        if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
        resizeRafId = requestAnimationFrame(() => {
          resizeRafId = null;
          fitTerminal(3);
        });
      });
      observer.observe(containerRef.current);

      // Store cleanup for unmount
      const cleanup = () => {
        disposed = true;
        observer.disconnect();
        if (resizeRafId !== null) cancelAnimationFrame(resizeRafId);
        if (outputFlushRafRef.current !== null) cancelAnimationFrame(outputFlushRafRef.current);
        unlistenOutputRef.current?.();
        unlistenExitRef.current?.();
        linkDisposableRef.current?.dispose();
        if (backendPtyIdRef.current) {
          invoke("terminal_close", { id: backendPtyIdRef.current }).catch(() => {});
        }
        term.dispose();
      };

      // Stash cleanup in a ref so the unmount effect can call it
      cleanupRef.current = cleanup;
    })();

    return () => { /* cleanup handled by separate unmount effect */ };
  }, [isVisible, fitTerminal, scheduleOutputFlush]);

  // Separate cleanup ref for unmount
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    return () => { cleanupRef.current?.(); };
  }, []);

  // Fit + focus when becoming active (tab switch within pane)
  useEffect(() => {
    if (!isActive || !isInitializedRef.current) return;
    const cleanupFit = fitTerminal(6);
    const cleanupFocus = verifyFocus(8);
    return () => { cleanupFit(); cleanupFocus(); };
  }, [isActive, fitTerminal, verifyFocus]);

  // Explicit focus request from outside (e.g. ⌘J shortcut)
  useEffect(() => {
    const handler = () => {
      if (!isActive || !isInitializedRef.current) return;
      verifyFocus(8);
    };
    window.addEventListener("atlas:focus-terminal", handler);
    return () => window.removeEventListener("atlas:focus-terminal", handler);
  }, [isActive, verifyFocus]);

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) setHasSelection(!!xtermRef.current?.hasSelection());
      }}
    >
      <ContextMenuTrigger asChild>
        <div
          ref={containerRef}
          className="h-full w-full bg-[#000] px-1 py-1"
          onClick={onFocus}
        />
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!hasSelection} onSelect={copySelection}>
          Copy
          <ContextMenuShortcut><KbdCombo combo="⌘C" /></ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={pasteClipboard}>
          Paste
          <ContextMenuShortcut><KbdCombo combo="⌘V" /></ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={selectAllTerm}>
          Select All
          <ContextMenuShortcut><KbdCombo combo="⌘A" /></ContextMenuShortcut>
        </ContextMenuItem>
        <ContextMenuItem onSelect={clearTerm}>Clear</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
