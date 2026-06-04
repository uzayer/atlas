import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

export interface CommandInputHandle {
  focus: () => void;
}

interface CommandInputProps {
  onSubmit: (cmd: string) => void;
  onInterrupt: () => void;
}

export const CommandInput = forwardRef<CommandInputHandle, CommandInputProps>(
  function CommandInput({ onSubmit, onInterrupt }, ref) {
    const taRef = useRef<HTMLTextAreaElement>(null);
    const [value, setValue] = useState("");
    // Command history + a cursor into it (-1 = the live, un-submitted line).
    const historyRef = useRef<string[]>([]);
    const histIdxRef = useRef<number>(-1);

    useImperativeHandle(ref, () => ({ focus: () => taRef.current?.focus() }), []);

    // Auto-grow the textarea with its content (multi-line via Shift+Enter).
    const resize = useCallback(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.style.height = "0px";
      ta.style.height = `${ta.scrollHeight}px`;
    }, []);
    useLayoutEffect(resize, [value, resize]);

    // The terminal pane isn't measured yet when this first mounts, so the
    // initial scrollHeight is stale (the textarea renders over-tall until the
    // first keystroke). Re-run resize whenever the textarea's real geometry
    // changes — i.e. once the pane lays out / becomes visible.
    useEffect(() => {
      const ta = taRef.current;
      if (!ta) return;
      let lastW = -1;
      const ro = new ResizeObserver(() => {
        if (ta.clientWidth !== lastW) {
          lastW = ta.clientWidth;
          resize();
        }
      });
      ro.observe(ta);
      return () => ro.disconnect();
    }, [resize]);

    const setText = (text: string) => {
      setValue(text);
      // Move the caret to the end after a programmatic change (history recall).
      requestAnimationFrame(() => {
        const ta = taRef.current;
        if (ta) ta.setSelectionRange(text.length, text.length);
      });
    };

    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget;

      // Enter submits; Shift+Enter inserts a newline (default behaviour).
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const cmd = value;
        onSubmit(cmd);
        if (cmd.trim()) historyRef.current.push(cmd);
        histIdxRef.current = -1;
        setValue("");
        return;
      }

      // Ctrl+C interrupts when there's no selection (otherwise let copy happen).
      if (e.key === "c" && e.ctrlKey && ta.selectionStart === ta.selectionEnd) {
        e.preventDefault();
        onInterrupt();
        return;
      }

      // History: ↑ only from the first line, ↓ only from the last line, so
      // multi-line editing still works normally.
      if (e.key === "ArrowUp") {
        const onFirstLine = !value.slice(0, ta.selectionStart).includes("\n");
        if (!onFirstLine) return;
        const h = historyRef.current;
        if (!h.length) return;
        e.preventDefault();
        histIdxRef.current =
          histIdxRef.current < 0 ? h.length - 1 : Math.max(0, histIdxRef.current - 1);
        setText(h[histIdxRef.current]);
        return;
      }
      if (e.key === "ArrowDown") {
        const onLastLine = !value.slice(ta.selectionStart).includes("\n");
        if (!onLastLine) return;
        if (histIdxRef.current < 0) return;
        e.preventDefault();
        const h = historyRef.current;
        histIdxRef.current += 1;
        if (histIdxRef.current >= h.length) {
          histIdxRef.current = -1;
          setText("");
        } else {
          setText(h[histIdxRef.current]);
        }
        return;
      }
    };

    return (
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        placeholder="Run a command…"
        className="flex-1 resize-none overflow-hidden border-none bg-transparent p-0 text-[13px] leading-[18px] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
        style={{ fontFamily: 'var(--font-mono, "JetBrains Mono", monospace)' }}
      />
    );
  }
);
