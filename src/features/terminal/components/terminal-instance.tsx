import { useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useProjectStore } from "@/features/project/stores/project-store";

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

      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        // Lead with Menlo — it's a system font that the WebKit Canvas
        // renderer ALWAYS resolves on macOS (xterm uses Canvas2D, which
        // doesn't honour the CSS `ui-monospace` keyword reliably and was
        // silently falling back to the proportional default in the bundled
        // app). The rest are progressive fallbacks.
        fontFamily: 'Menlo, Monaco, "SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", "Courier New", monospace',
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
    <div
      ref={containerRef}
      className="h-full w-full bg-[#000] px-1 py-1"
      onClick={onFocus}
    />
  );
}
