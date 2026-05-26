import { Mention as TiptapMention } from "@tiptap/extension-mention";
import Suggestion from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { createRoot } from "react-dom/client";
import { createRef } from "react";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useKnowledgeStore } from "@/features/knowledge/stores/knowledge-store";
import {
  MentionPicker,
  type MentionPickerHandle,
} from "@/features/mentions/components/mention-picker";
import type { MentionData } from "@/features/chat/lib/mentions";

/**
 * Atlas-wide @-mention for any Tiptap editor.
 *
 * This is the universal-reference adapter: instead of a bespoke picker,
 * we mount the same `<MentionPicker>` the chat composer uses. The
 * suggestion plugin owns the trigger / query / lifecycle; we own the
 * popup mount + the imperative keyboard relay.
 *
 * Excludes: the knowledge editor passes the open note (`knowledge:<id>`)
 * via the `excludeIds` prop so users can't @-reference the doc they're
 * editing. Other surfaces can layer their own excludes the same way.
 */

const MentionPluginKey = new PluginKey("atlas-mention");

const HOST_SELECTORS = [".atlas-tiptap"];

interface PopupState {
  el: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
  pickerRef: React.RefObject<MentionPickerHandle | null>;
  query: string;
  anchor: { x: number; y: number } | null;
  command: ((m: MentionData) => void) | null;
  close: () => void;
}

function buildExcludeIds(): Set<string> {
  // The knowledge store keeps the active entry id; the chat composer
  // doesn't use this extension at all (it has its own integration), so
  // there's no false-positive for other surfaces.
  const id = useKnowledgeStore.getState().activeEntryId;
  return id ? new Set([`knowledge:${id}`]) : new Set();
}

function createPopup(): PopupState {
  const el = document.createElement("div");
  el.className = "atlas-mention-popup-host";
  document.body.appendChild(el);
  const root = createRoot(el);
  return {
    el,
    root,
    pickerRef: createRef<MentionPickerHandle | null>(),
    query: "",
    anchor: null,
    command: null,
    close: () => {},
  };
}

function destroyPopup(popup: PopupState) {
  try { popup.root.unmount(); } catch { /* ignore */ }
  popup.el.remove();
}

function renderPopup(popup: PopupState) {
  const projectPath = useProjectStore.getState().currentProject?.path ?? null;
  popup.root.render(
    <MentionPicker
      ref={popup.pickerRef}
      open={popup.anchor !== null}
      query={popup.query}
      anchor={popup.anchor}
      projectPath={projectPath}
      excludeIds={buildExcludeIds()}
      hostSelectors={HOST_SELECTORS}
      onSelect={(m) => popup.command?.(m)}
      onClose={() => popup.close()}
    />,
  );
}

export const AtlasMention = TiptapMention.extend({
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute("data-id") },
      kind: {
        default: "ref",
        parseHTML: (el) => el.getAttribute("data-mention-kind"),
      },
      label: {
        default: null,
        parseHTML: (el) => el.textContent?.replace(/^@/, "") ?? null,
      },
    };
  },
  renderText({ node }) {
    // Wire format expected by compose_prompt.rs::MentionSpec.
    return `@${node.attrs.kind ?? "ref"}:${node.attrs.id ?? ""}`;
  },
  renderHTML({ node }) {
    return [
      "span",
      {
        class: "atlas-mention-chip",
        "data-id": node.attrs.id ?? "",
        "data-mention-kind": node.attrs.kind ?? "",
      },
      `@${node.attrs.label ?? node.attrs.id}`,
    ];
  },
  // tiptap-markdown serializer: emit `@kind:id` as plain text so the
  // Rust backlinks scanner (which looks for that exact wire form) can
  // pick up references on save. Without this, the inline mention chip
  // serializes as an HTML <span> and the scanner never sees the link.
  addStorage() {
    return {
      markdown: {
        serialize(
          state: { write: (s: string) => void },
          node: { attrs: { kind?: string; id?: string } },
        ) {
          const kind = node.attrs.kind ?? "ref";
          const id = node.attrs.id ?? "";
          state.write(`@${kind}:${id}`);
        },
        parse: {
          // markdown-it picks up the HTML span on re-parse; if we ever
          // want bare `@kind:id` text to re-hydrate into a node we'd
          // hook a tokenizer here.
        },
      },
    };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    let popup: PopupState | null = null;
    return [
      Suggestion({
        editor,
        pluginKey: MentionPluginKey,
        char: "@",
        allowSpaces: false,
        // The universal picker calls Rust directly for results, so we
        // don't need to return items here. Return an empty array to
        // satisfy the suggestion contract; the picker handles search.
        items: () => [],
        command: ({ editor: ed, range, props }) => {
          const m = props as unknown as MentionData;
          const label = mentionLabel(m);
          ed
            .chain()
            .focus()
            .insertContentAt(range, [
              {
                type: "mention",
                attrs: { id: m.id, kind: m.kind, label },
              },
              { type: "text", text: " " },
            ])
            .run();
        },
        render: () => ({
          onStart: (props) => {
            popup = createPopup();
            popup.query = props.query;
            const rect = props.clientRect?.();
            popup.anchor = rect ? { x: rect.left, y: rect.top } : null;
            popup.command = (m) => props.command(m as unknown as never);
            popup.close = () => {
              // Tiptap doesn't expose a public "cancel suggestion" — we
              // fake it by removing the trigger char from the doc so
              // the suggestion plugin's tracker resets.
              try {
                editor
                  .chain()
                  .focus()
                  .deleteRange({ from: props.range.from, to: props.range.to })
                  .run();
              } catch { /* ignore */ }
            };
            renderPopup(popup);
          },
          onUpdate: (props) => {
            if (!popup) return;
            popup.query = props.query;
            const rect = props.clientRect?.();
            popup.anchor = rect ? { x: rect.left, y: rect.top } : null;
            popup.command = (m) => props.command(m as unknown as never);
            renderPopup(popup);
          },
          onKeyDown: (props) => {
            const handle = popup?.pickerRef.current;
            if (!handle) return false;
            switch (props.event.key) {
              case "ArrowDown":
                handle.moveDown();
                return true;
              case "ArrowUp":
                handle.moveUp();
                return true;
              case "Enter":
              case "Tab":
                return handle.commit();
              case "Escape":
                if (handle.goBack()) return true;
                if (popup) {
                  destroyPopup(popup);
                  popup = null;
                }
                return true;
              case "Backspace":
                // Let the editor handle the deletion. If the user
                // backspaces the trigger char, suggestion's onExit will
                // fire and tear the popup down.
                return false;
              default:
                return false;
            }
          },
          onExit: () => {
            if (popup) {
              destroyPopup(popup);
              popup = null;
            }
          },
        }),
      }),
    ];
  },
});

function mentionLabel(m: MentionData): string {
  switch (m.kind) {
    case "file":
    case "folder": {
      const rel = m.displayName;
      const idx = rel.lastIndexOf("/");
      return idx >= 0 ? rel.slice(idx + 1) : rel;
    }
    default:
      return m.displayName;
  }
}
