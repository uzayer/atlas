// CodeMirror 6 composer for the chat input. Replaces what used to be a
// `<textarea>` in `message-input.tsx`.
//
// Why CodeMirror instead of textarea: this composer needs to host real
// inline atomic chips (mention pills) that delete in one backspace, plus
// markdown bullet auto-indent. Both are very hard to do well over a plain
// textarea. CodeMirror is already a project dep (used by the file editor)
// so adding a thin wrapper here costs us nothing in bundle terms.
//
// This file intentionally has *no* mention awareness yet — the mention
// state field + chip widget extension lands in a follow-up and just plugs
// into the `extraExtensions` prop. Today this is "textarea + bullets".

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentMore,
  indentLess,
} from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";

import {
  mentionExtension,
  mentionTriggerPlugin,
  mentionKeymap,
  insertMention as insertMentionInView,
  getMentions as getMentionsFromView,
  type MentionKeyInterceptor,
  type MentionTrigger,
} from "../lib/cm-mention-extension";
import {
  slashTriggerPlugin,
  type SlashKeyInterceptor,
  type SlashTrigger,
} from "../lib/cm-slash-extension";
import type { MentionData } from "../lib/mentions";

export interface ChatInputHandle {
  focus(): void;
  blur(): void;
  getValue(): string;
  setValue(text: string): void;
  clear(): void;
  /** Read mentions registered with the current document. */
  getMentions(): MentionData[];
  /**
   * Insert a mention chip. If `from`/`to` are provided, that doc slice is
   * replaced (used when the picker commits and we want to swallow the
   * `@query` the user typed). Otherwise inserts at the caret.
   */
  insertMention(m: MentionData, from?: number, to?: number): void;
  /** Imperative dispatch — escape hatch for the mention extension to
   *  insert a chip into the buffer. Pass the raw view if you need more. */
  view(): EditorView | null;
}

interface ChatInputProps {
  /** Bound text. Reads it once on mount; changes via setValue/clear. */
  initialValue?: string;
  placeholder?: string;
  /** Fires on every doc change. Receives the plain text body. */
  onChange?: (value: string) => void;
  /** Fires on Cmd/Ctrl+Enter — the submit gesture. */
  onSubmit?: () => void;
  /** Fires whenever the `@` trigger range changes (open or close). */
  onMentionTrigger?: (trigger: MentionTrigger | null) => void;
  /** Fires whenever the `/` trigger range changes (open or close). */
  onSlashTrigger?: (trigger: SlashTrigger | null) => void;
  /**
   * Lookup function called for Up/Down/Enter/Escape **before** CodeMirror's
   * default keymap. Return `true` to swallow the key (picker is open and
   * handled it); return `false` to pass through to CM. Read at keypress
   * time so callers can change it without remounting the view.
   *
   * Wired to both the mention and slash keymaps — the parent decides which
   * picker is open and routes accordingly.
   */
  keyInterceptor?: MentionKeyInterceptor | null;
  /** Slot for future extensions. */
  extraExtensions?: Extension[];
  /** Min height in pixels (matches old textarea: 44). */
  minHeight?: number;
  /** Max height before vertical scroll kicks in (matches old: 200). */
  maxHeight?: number;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>(
  function ChatInput(
    {
      initialValue = "",
      placeholder = "Message Atlas... (@ to mention, / for commands)",
      onChange,
      onSubmit,
      onMentionTrigger,
      onSlashTrigger,
      keyInterceptor,
      extraExtensions,
      minHeight = 44,
      maxHeight = 200,
    },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);

    // Keep the latest callbacks in refs so the extensions captured at mount
    // can always reach the current handler without us tearing down the view
    // on every keystroke.
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onSubmitRef = useRef(onSubmit);
    onSubmitRef.current = onSubmit;
    const onMentionTriggerRef = useRef(onMentionTrigger);
    onMentionTriggerRef.current = onMentionTrigger;
    const onSlashTriggerRef = useRef(onSlashTrigger);
    onSlashTriggerRef.current = onSlashTrigger;
    const keyInterceptorRef = useRef<
      MentionKeyInterceptor | SlashKeyInterceptor | null | undefined
    >(keyInterceptor);
    keyInterceptorRef.current = keyInterceptor;

    // Build the theme once — sized to the container, transparent
    // background so the parent's chip rounding shows through.
    const theme = useMemo(
      () =>
        EditorView.theme(
          {
            "&": {
              backgroundColor: "transparent",
              color: "var(--text-primary)",
              fontSize: "13px",
              lineHeight: "1.55",
            },
            ".cm-scroller": {
              fontFamily:
                'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
              minHeight: `${minHeight}px`,
              maxHeight: `${maxHeight}px`,
              overflowY: "auto",
            },
            ".cm-content": {
              padding: "12px 16px 4px",
              // Hide the native contenteditable caret — CodeMirror's own
              // `drawSelection` extension paints the visible cursor. Without
              // this, WebKit shows BOTH (the native blink + CM's div), which
              // looks like a double-caret glitch in the composer.
              caretColor: "transparent",
            },
            ".cm-line": {
              padding: "0",
            },
            "&.cm-focused": {
              outline: "none",
            },
            // Style CM's drawn cursor to match the theme.
            ".cm-cursor, .cm-dropCursor": {
              borderLeftColor: "var(--text-primary)",
              borderLeftWidth: "1px",
            },
            ".cm-placeholder": {
              color: "var(--text-tertiary)",
            },
            // Hide the active-line highlight; this is a chat composer, not
            // a source editor.
            ".cm-activeLine, .cm-activeLineGutter": {
              backgroundColor: "transparent",
            },
            ".cm-selectionBackground, ::selection": {
              background: "var(--bg-selected) !important",
            },
          },
          { dark: true }
        ),
      [minHeight, maxHeight]
    );

    const extensionsKey = extraExtensions ?? null;

    // One mount/unmount per component lifetime — the view itself is
    // mutated via dispatch, never recreated, to avoid losing focus and
    // selection state when callbacks change. Extension changes recompile
    // via `reconfigure`.
    useEffect(() => {
      const parent = containerRef.current;
      if (!parent) return;

      const submitKeymap = keymap.of([
        {
          key: "Mod-Enter",
          run: () => {
            onSubmitRef.current?.();
            return true;
          },
        },
        {
          // Tab on a bullet line indents the line; otherwise insert spaces
          // (kept as a soft-indent so users can still tab-navigate out).
          key: "Tab",
          run: (view) => {
            if (isOnListLine(view)) {
              return indentMore(view);
            }
            return false; // fall through to default Tab handling
          },
          shift: (view) => {
            if (isOnListLine(view)) {
              return indentLess(view);
            }
            return false;
          },
        },
      ]);

      const view = new EditorView({
        parent,
        state: EditorState.create({
          doc: initialValue,
          extensions: [
            history(),
            // CM-managed caret + selection rendering. Pairs with
            // `caret-color: transparent` on `.cm-content` (see theme) to
            // eliminate the WebKit double-caret artifact.
            drawSelection(),
            // The markdown language pack ships an Enter binding that
            // continues `-` / `*` / `1.` bullets on the next line and
            // outdents on an empty marker — exactly the "type `- a` Enter
            // → `- ` on next line; empty bullet + Enter → outdent" UX.
            markdown({ base: markdownLanguage, addKeymap: true }),
            // Soft wrap so the composer feels like a textarea.
            EditorView.lineWrapping,
            submitKeymap,
            keymap.of([...historyKeymap, ...defaultKeymap]),
            cmPlaceholder(placeholder),
            theme,
            EditorView.contentAttributes.of({
              "aria-label": "Chat message",
              role: "textbox",
              "aria-multiline": "true",
            }),
            EditorView.updateListener.of((u) => {
              if (u.docChanged) {
                onChangeRef.current?.(u.state.doc.toString());
              }
            }),
            ...mentionExtension,
            mentionTriggerPlugin((t) => onMentionTriggerRef.current?.(t)),
            slashTriggerPlugin((t) => onSlashTriggerRef.current?.(t)),
            // Prec.highest puts the picker keymap above lang-markdown's
            // Enter binding (which would otherwise continue a bullet) and
            // above the default Enter (which inserts a newline). The
            // mention and slash pickers share an interceptor signature —
            // the parent routes by which trigger state is non-null — so
            // one keymap fronts both pickers and we avoid running the
            // interceptor twice per keypress.
            Prec.highest(
              keymap.of(
                mentionKeymap(
                  () =>
                    (keyInterceptorRef.current as MentionKeyInterceptor | null) ?? null,
                )
              )
            ),
            ...(extensionsKey ?? []),
          ],
        }),
      });
      viewRef.current = view;

      return () => {
        view.destroy();
        viewRef.current = null;
      };
      // `placeholder` / `theme` / `extensionsKey` are stable enough not to
      // bounce the view; if a caller needs to change them at runtime they
      // can call `.setValue("")` after a remount instead.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useImperativeHandle(
      ref,
      (): ChatInputHandle => ({
        focus: () => viewRef.current?.focus(),
        blur: () => viewRef.current?.contentDOM.blur(),
        getValue: () => viewRef.current?.state.doc.toString() ?? "",
        setValue: (text) => {
          const v = viewRef.current;
          if (!v) return;
          v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: text },
          });
        },
        clear: () => {
          const v = viewRef.current;
          if (!v) return;
          v.dispatch({
            changes: { from: 0, to: v.state.doc.length, insert: "" },
          });
        },
        getMentions: () =>
          viewRef.current ? getMentionsFromView(viewRef.current) : [],
        insertMention: (m, from, to) => {
          const v = viewRef.current;
          if (!v) return;
          const head = v.state.selection.main.head;
          insertMentionInView(v, m, from ?? head, to ?? head);
        },
        view: () => viewRef.current,
      }),
      []
    );

    return <div ref={containerRef} className="atlas-chat-cm-host" />;
  }
);

/** Whether the current selection's main caret sits on a markdown bullet or
 *  ordered-list line. Used to gate the Tab indent/outdent behavior so
 *  Tab outside lists still inserts whatever the default handler wants. */
function isOnListLine(view: EditorView): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  return /^\s*([-*+]|\d+\.)\s/.test(line.text);
}
