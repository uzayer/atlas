import { useEffect, useRef, useCallback } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags } from "@lezer/highlight";
import { useEditorStore } from "../stores/editor-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight } from "lucide-react";
import { logEvent } from "@/features/log/lib/log";

const TOOLBAR_HEIGHT = 32;
const DIRTY_CHECK_DEBOUNCE = 300; // ms — only check dirty state, not sync content

// Atlas dark theme — editor chrome
const atlasTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "#000000",
      color: "#b3b3b3",
      height: "100%",
    },
    ".cm-content": {
      fontFamily: "JetBrains Mono, SF Mono, Fira Code, monospace",
      fontSize: "14px",
      lineHeight: "18px",
      caretColor: "#b3b3b3",
      padding: "4px 0",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "#b3b3b3",
      borderLeftWidth: "2px",
    },
    ".cm-gutters": {
      backgroundColor: "#000000",
      color: "#222222",
      border: "none",
      minWidth: "40px",
    },
    ".cm-activeLineGutter": {
      color: "#777777",
      backgroundColor: "transparent",
    },
    ".cm-activeLine": {
      backgroundColor: "#ffffff0a",
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "#303030 !important",
    },
    ".cm-focused .cm-selectionBackground": {
      backgroundColor: "#303030 !important",
    },
    ".cm-matchingBracket": {
      backgroundColor: "#2d2d2d",
      outline: "1px solid #3d3d3d",
    },
    ".cm-foldGutter .cm-gutterElement": {
      color: "#333",
      fontSize: "12px",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "#1a1a1a",
      border: "1px solid #2a2a2a",
      color: "#555",
    },
    "&.cm-focused": {
      outline: "none",
    },
    ".cm-scroller": {
      overflow: "auto",
      scrollbarWidth: "none",
      "&::-webkit-scrollbar": { display: "none" },
    },
    ".cm-line": {
      padding: "0 4px",
    },
  },
  { dark: true }
);

// Atlas syntax highlighting
const atlasHighlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: "#555555", fontStyle: "italic" },
  { tag: tags.keyword, color: "#585858", fontStyle: "italic" },
  { tag: [tags.string, tags.special(tags.string)], color: "#aaaaaa" },
  { tag: tags.number, color: "#aaaaaa" },
  { tag: [tags.typeName, tags.className], color: "#cccccc" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "#FFFF00" },
  { tag: tags.variableName, color: "#ffffff" },
  { tag: tags.operator, color: "#B3B3B3" },
  { tag: tags.punctuation, color: "#B3B3B3" },
  { tag: tags.tagName, color: "#cccccc" },
  { tag: tags.attributeName, color: "#777777" },
  { tag: [tags.constant(tags.variableName), tags.standard(tags.variableName)], color: "#aaaaaa" },
  { tag: tags.regexp, color: "#999999" },
  { tag: tags.escape, color: "#999999" },
  { tag: tags.definition(tags.variableName), color: "#ffffff" },
  { tag: tags.propertyName, color: "#b3b3b3" },
  { tag: tags.bool, color: "#aaaaaa" },
  { tag: tags.null, color: "#aaaaaa" },
]);

// Language extension loader — lazy imports for tree-shaking
async function getLanguageExtension(lang: string): Promise<Extension> {
  switch (lang) {
    case "typescript":
    case "javascript": {
      const { javascript } = await import("@codemirror/lang-javascript");
      return javascript({ typescript: lang === "typescript", jsx: true });
    }
    case "rust": {
      const { rust } = await import("@codemirror/lang-rust");
      return rust();
    }
    case "python": {
      const { python } = await import("@codemirror/lang-python");
      return python();
    }
    case "go": {
      const { go } = await import("@codemirror/lang-go");
      return go();
    }
    case "json": {
      const { json } = await import("@codemirror/lang-json");
      return json();
    }
    case "markdown": {
      const { markdown } = await import("@codemirror/lang-markdown");
      return markdown();
    }
    case "html": {
      const { html } = await import("@codemirror/lang-html");
      return html();
    }
    case "css":
    case "scss": {
      const { css } = await import("@codemirror/lang-css");
      return css();
    }
    case "java": {
      const { java } = await import("@codemirror/lang-java");
      return java();
    }
    case "c":
    case "cpp": {
      const { cpp } = await import("@codemirror/lang-cpp");
      return cpp();
    }
    case "xml": {
      const { xml } = await import("@codemirror/lang-xml");
      return xml();
    }
    case "sql": {
      const { sql } = await import("@codemirror/lang-sql");
      return sql();
    }
    case "yaml":
    case "toml": {
      const { yaml } = await import("@codemirror/lang-yaml");
      return yaml();
    }
    default:
      return [];
  }
}

interface EditorPanelProps {
  tabId: string;
  filePath?: string;
  containerHeight: number;
}

export function EditorPanel({ tabId, filePath, containerHeight }: EditorPanelProps) {
  const path = filePath ?? "";
  const isUntitled = path.startsWith("untitled:");
  const buffer = useEditorStore((s) => s.buffers[path]);
  const { openBuffer, setDirty, markSaved } = useEditorStore.use.actions();
  const projectPath = useProjectStore.use.currentProject()?.path ?? "";
  const layoutActions = useLayoutStore.use.actions();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSaveRef = useRef<() => void>(() => {});
  const dirtyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load file content from disk — unless this is an untitled scratch
  // buffer (Cmd+N), in which case we seed an empty buffer in-memory
  // and skip the IPC. The synthetic `untitled:<ts>` key keeps each
  // unsaved tab's buffer separate in the store.
  useEffect(() => {
    if (!path || buffer) return;
    if (isUntitled) {
      openBuffer(path, "");
      return;
    }
    invoke<string>("read_file_content", { path })
      .then((content) => openBuffer(path, content))
      .catch(() => openBuffer(path, `// Failed to read: ${path}`));
  }, [path, buffer, openBuffer, isUntitled]);

  // Save: read content directly from CodeMirror, not from store.
  // Untitled buffers open the OS save dialog first; on commit we
  // write the file, replace the untitled tab with a real-path tab,
  // and migrate the buffer key so the new tab picks up the content
  // immediately without a disk round-trip.
  const handleSave = useCallback(async () => {
    const view = viewRef.current;
    if (!view) return;
    const content = view.state.doc.toString();
    if (isUntitled) {
      try {
        const { save: saveDialog } = await import("@tauri-apps/plugin-dialog");
        const chosen = await saveDialog({
          defaultPath: projectPath || undefined,
          title: "Save File",
        });
        if (!chosen) return; // user cancelled
        const newPath = chosen as string;
        await invoke("write_file_content", { path: newPath, content });
        // Carry the freshly-saved content over to the new buffer key.
        openBuffer(newPath, content);
        markSaved(newPath, content);
        // Swap the tab in place: close untitled, open real-path tab
        // with the same activation behavior addTab gives.
        layoutActions.closeTab(tabId);
        layoutActions.addTab({
          id: `editor-${newPath}`,
          type: "editor",
          title: newPath.split("/").pop() ?? newPath,
          closable: true,
          dirty: false,
          data: { filePath: newPath },
        });
        logEvent({
          source: "editor",
          kind: "save",
          summary: newPath.split("/").pop() ?? newPath,
          payload: { path: newPath, bytes: content.length },
        });
      } catch (err) {
        console.error("Save-as failed:", err);
      }
      return;
    }
    try {
      await invoke("write_file_content", { path, content });
      markSaved(path, content);
      logEvent({
        source: "editor",
        kind: "save",
        summary: path.split("/").pop() ?? path,
        payload: { path, bytes: content.length },
      });
    } catch (err) {
      console.error("Save failed:", err);
    }
  }, [path, markSaved, isUntitled, projectPath, openBuffer, layoutActions, tabId]);

  onSaveRef.current = handleSave;

  // Create/destroy CodeMirror view
  useEffect(() => {
    if (!buffer || !containerRef.current) return;

    const originalContent = buffer.originalContent;
    let cancelled = false;

    (async () => {
      const langExt = await getLanguageExtension(buffer.language);
      if (cancelled) return;

      const view = new EditorView({
        doc: originalContent,
        extensions: [
          atlasTheme,
          syntaxHighlighting(atlasHighlightStyle),
          langExt,
          lineNumbers(),
          highlightActiveLine(),
          drawSelection(),
          bracketMatching(),
          foldGutter(),
          indentOnInput(),
          history(),
          highlightSelectionMatches(),
          keymap.of([
            { key: "Mod-s", run: () => { onSaveRef.current(); return true; } },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          // Debounced dirty check — never sync full content to store on keystroke
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              if (dirtyTimerRef.current) clearTimeout(dirtyTimerRef.current);
              dirtyTimerRef.current = setTimeout(() => {
                const current = update.view.state.doc.toString();
                const orig = useEditorStore.getState().buffers[path]?.originalContent ?? "";
                setDirty(path, current !== orig);
              }, DIRTY_CHECK_DEBOUNCE);
            }
          }),
          EditorState.tabSize.of(2),
        ],
        parent: containerRef.current!,
      });

      if (cancelled) {
        view.destroy();
        return;
      }

      viewRef.current = view;
    })();

    return () => {
      cancelled = true;
      if (dirtyTimerRef.current) clearTimeout(dirtyTimerRef.current);
      if (viewRef.current) {
        viewRef.current.destroy();
        viewRef.current = null;
      }
    };
  }, [path, !!buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!buffer) {
    return (
      <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
        Loading...
      </div>
    );
  }

  const editorHeight = containerHeight > TOOLBAR_HEIGHT
    ? containerHeight - TOOLBAR_HEIGHT
    : window.innerHeight - 140;

  return (
    <div style={{ background: "#000000", height: containerHeight || "100%", overflow: "hidden" }}>
      {/* Breadcrumb toolbar */}
      <div
        className="flex items-center px-3 border-b border-border-default bg-bg-primary overflow-hidden"
        style={{ height: TOOLBAR_HEIGHT }}
      >
        <Breadcrumbs filePath={path} projectPath={projectPath} />
        {buffer.dirty && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0 ml-2" />
        )}
      </div>

      {/* CodeMirror container */}
      <div
        ref={containerRef}
        style={{ height: editorHeight, overflow: "hidden" }}
      />
    </div>
  );
}

function Breadcrumbs({ filePath, projectPath }: { filePath: string; projectPath: string }) {
  const relative = projectPath && filePath.startsWith(projectPath)
    ? filePath.slice(projectPath.length + 1)
    : filePath;
  const segments = relative.split("/").filter(Boolean);

  return (
    <div className="flex items-center min-w-0 overflow-hidden">
      {segments.map((segment, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={i} className="flex items-center shrink-0">
            {i > 0 && <ChevronRight size={10} className="text-text-tertiary mx-0.5 shrink-0" />}
            <span className={`text-[11px] font-mono ${isLast ? "text-text-primary" : "text-text-tertiary"}`}>
              {segment}
            </span>
          </span>
        );
      })}
    </div>
  );
}
