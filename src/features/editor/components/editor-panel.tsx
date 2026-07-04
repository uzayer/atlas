import { useEffect, useRef, useCallback } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { getEditorTheme } from "../themes/themes";
import { buildEditorChromeTheme, buildHighlightStyle } from "../themes/build-cm-theme";
import { useEditorStore } from "../stores/editor-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ChevronRight } from "lucide-react";
import { logEvent } from "@/features/log/lib/log";
import { diffGutter, applyDiffStatus } from "../lib/diff-gutter";
import { gitDiffLineStatus } from "@/features/git/lib/git-diff-api";

const TOOLBAR_HEIGHT = 32;
const DIRTY_CHECK_DEBOUNCE = 300; // ms — only check dirty state, not sync content

// Editor theme — live-swappable via a Compartment. The concrete colors come
// from the theme registry (src/features/editor/themes), keyed by the persisted
// `settings.codeEditorTheme`.
const themeCompartment = new Compartment();

function themeExtensions(themeId: string | undefined | null): Extension {
  const theme = getEditorTheme(themeId);
  return [buildEditorChromeTheme(theme), syntaxHighlighting(buildHighlightStyle(theme))];
}

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
  const refreshGutterRef = useRef<() => void>(() => {});
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
      // A save mutates the working tree — refresh git status/dots + diff
      // right now instead of waiting for the workspace fs watcher (FSEvents
      // latency + fileindex 150 ms + git-store debounce). Lazy-imported to
      // keep the editor decoupled from the git store.
      void import("@/features/git/stores/git-store").then(({ useGitStore }) => {
        const git = useGitStore.getState();
        if (git.repoPath) {
          void git.actions.refreshStatusNow(git.repoPath);
          void git.actions.loadDiff();
        }
      });
      // Repaint this editor's diff gutter against the just-saved content.
      refreshGutterRef.current();
    } catch (err) {
      console.error("Save failed:", err);
    }
  }, [path, markSaved, isUntitled, projectPath, openBuffer, layoutActions, tabId]);

  onSaveRef.current = handleSave;

  // Fetch this file's git diff vs HEAD and paint the gutter (added/changed/
  // deleted bars). No-op for untitled scratch buffers or files outside the repo.
  const refreshDiffGutter = useCallback(() => {
    const view = viewRef.current;
    if (!view || isUntitled || !projectPath) return;
    if (!path.startsWith(projectPath + "/")) return;
    const rel = path.slice(projectPath.length + 1);
    void gitDiffLineStatus(projectPath, rel, false)
      .then((status) => {
        if (viewRef.current) applyDiffStatus(viewRef.current, status);
      })
      .catch(() => {});
  }, [path, projectPath, isUntitled]);
  refreshGutterRef.current = refreshDiffGutter;

  // Repaint the gutter when the working tree changes elsewhere (commits,
  // stage/unstage, external edits) — same event the git store listens to.
  useEffect(() => {
    const un = listen("atlas:git-changed", () => refreshDiffGutter());
    return () => {
      un.then((u) => u());
    };
  }, [refreshDiffGutter]);

  // Re-paint when inputs settle (e.g. the project path resolves AFTER the view
  // was created, or the buffer swaps). The in-view-creation call covers the
  // common case; this covers the late-projectPath race.
  useEffect(() => {
    refreshDiffGutter();
  }, [refreshDiffGutter, buffer]);

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
          themeCompartment.of(themeExtensions(useProjectStore.getState().settings.codeEditorTheme)),
          langExt,
          lineNumbers(),
          diffGutter(),
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
      refreshDiffGutter();
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

  // Live-reskin the editor when the persisted theme changes — reconfigure the
  // theme compartment in place so the buffer/undo history survive.
  const codeEditorTheme = useProjectStore.use.settings().codeEditorTheme;
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: themeCompartment.reconfigure(themeExtensions(codeEditorTheme)) });
  }, [codeEditorTheme]);

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
