import { useEffect, useState, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cn } from "@/lib/utils";
import { useKnowledgeStore } from "../stores/knowledge-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { ScrollArea } from "@/ui/scroll-area";
import { logEvent } from "@/features/log/lib/log";
import {
  Plus,
  Trash2,
  RefreshCw,
  FolderPlus,
  ChevronRight,
  GitBranch,
  ExternalLink,
  Copy,
} from "lucide-react";

export function KnowledgePanel() {
  const entries = useKnowledgeStore.use.entries();
  const activeEntryId = useKnowledgeStore.use.activeEntryId();
  const editContent = useKnowledgeStore.use.editContent();
  const loading = useKnowledgeStore.use.loading();
  const {
    loadEntries,
    selectEntry,
    setEditContent,
    saveEntry,
    createEntry,
    deleteEntry,
    createDir,
  } = useKnowledgeStore.use.actions();
  const currentProject = useProjectStore.use.currentProject();
  const [newFolderName, setNewFolderName] = useState("");
  const [showFolderInput, setShowFolderInput] = useState(false);
  const [showSubfolderInput, setShowSubfolderInput] = useState<string | null>(null);
  const [subfolderName, setSubfolderName] = useState("");
  const [isDirty, setIsDirty] = useState(false);
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
  const [clonedRepos, setClonedRepos] = useState<Array<{ name: string; path: string; has_readme: boolean }>>([]);
  const [repoReadme, setRepoReadme] = useState<string | null>(null);
  const [activeRepoName, setActiveRepoName] = useState<string | null>(null);

  // Group entries: extract unique directories and separate root vs nested entries
  const { directories, rootEntries, entriesByDir } = useMemo(() => {
    const dirSet = new Set<string>();
    const root: typeof entries = [];
    const byDir: Record<string, typeof entries> = {};

    for (const entry of entries) {
      const slashIdx = entry.id.indexOf("/");
      if (slashIdx === -1) {
        root.push(entry);
      } else {
        const dir = entry.id.substring(0, slashIdx);
        dirSet.add(dir);
        if (!byDir[dir]) byDir[dir] = [];
        byDir[dir].push(entry);
      }
    }
    return { directories: Array.from(dirSet).sort(), rootEntries: root, entriesByDir: byDir };
  }, [entries]);

  const toggleDir = (dir: string) => {
    setExpandedDirs((s) => { const n = new Set(s); if (n.has(dir)) n.delete(dir); else n.add(dir); return n; });
  };

  const loadRepos = useCallback(() => {
    if (currentProject) {
      invoke<Array<{ name: string; path: string; has_readme: boolean }>>("list_cloned_repos", { projectPath: currentProject.path })
        .then(setClonedRepos).catch(() => {});
    }
  }, [currentProject]);

  // Load entries and cloned repos when project changes
  useEffect(() => {
    if (currentProject) {
      loadEntries(currentProject.path);
      loadRepos();
    }
  }, [currentProject?.path, loadEntries, loadRepos]);

  // Re-check repos when the panel becomes visible (tab switch back)
  useEffect(() => {
    const handler = () => loadRepos();
    window.addEventListener("focus", handler);
    return () => window.removeEventListener("focus", handler);
  }, [loadRepos]);

  // Listen for custom event from GitHub panel after clone
  useEffect(() => {
    const handler = () => loadRepos();
    window.addEventListener("atlas:repo-cloned", handler);
    return () => window.removeEventListener("atlas:repo-cloned", handler);
  }, [loadRepos]);

  const handleRepoClick = async (repoName: string) => {
    setActiveRepoName(repoName);
    selectEntry(""); // deselect any note
    try {
      const readme = await invoke<string>("read_repo_readme", { projectPath: currentProject!.path, repoName });
      setRepoReadme(readme);
    } catch {
      setRepoReadme(null);
    }
  };

  const handleDeleteRepo = async (repoName: string) => {
    if (!currentProject) return;
    await invoke("delete_cloned_repo", { projectPath: currentProject.path, repoName }).catch(() => {});
    logEvent({ source: "github", kind: "repo-delete", summary: repoName, payload: { repoName } });
    loadRepos();
    if (activeRepoName === repoName) { setActiveRepoName(null); setRepoReadme(null); }
  };

  const handleCopyPath = (path: string) => {
    navigator.clipboard.writeText(path);
  };

  const handleOpenNewWindow = (_repoPath: string) => {
    import("@tauri-apps/api/webviewWindow").then(({ WebviewWindow }) => {
      new WebviewWindow(`atlas-${Date.now()}`, { url: "/?new=1", title: "Atlas", width: 1200, height: 800, center: true, decorations: true, titleBarStyle: "overlay", hiddenTitle: true });
    }).catch(() => {});
  };

  // Reset dirty on entry switch
  useEffect(() => { setIsDirty(false); }, [activeEntryId]);

  // Cmd+S to save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (currentProject && isDirty) {
          saveEntry(currentProject.path);
          setIsDirty(false);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentProject, isDirty, saveEntry]);

  const handleContentChange = useCallback((value: string) => {
    setEditContent(value);
    setIsDirty(true);
  }, [setEditContent]);

  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !currentProject) return;
    const name = newFolderName.trim();
    await createDir(currentProject.path, name);
    await invoke("save_knowledge_note", {
      projectPath: currentProject.path,
      id: `${name}/note-${Date.now()}`,
      content: `# ${name}\n\n`,
    });
    await loadEntries(currentProject.path);
    setNewFolderName("");
    setShowFolderInput(false);
    setExpandedDirs((s) => new Set(s).add(name));
  };

  const handleCreateSubfolder = async (parentDir: string) => {
    if (!subfolderName.trim() || !currentProject) return;
    const name = subfolderName.trim();
    const fullDir = `${parentDir}/${name}`;
    await createDir(currentProject.path, fullDir);
    await invoke("save_knowledge_note", {
      projectPath: currentProject.path,
      id: `${fullDir}/note-${Date.now()}`,
      content: `# ${name}\n\n`,
    });
    await loadEntries(currentProject.path);
    setSubfolderName("");
    setShowSubfolderInput(null);
  };

  const handleCreateNoteInDir = async (dir: string) => {
    if (!currentProject) return;
    const id = `${dir}/note-${Date.now()}`;
    await invoke("save_knowledge_note", {
      projectPath: currentProject.path,
      id,
      content: "# Untitled\n\n",
    });
    await loadEntries(currentProject.path);
    selectEntry(id);
  };

  const activeEntry = entries.find((e) => e.id === activeEntryId);

  if (!currentProject) {
    return (
      <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
        Open a project first
      </div>
    );
  }

  return (
    <div className="h-full flex">
      {/* Entry list sidebar */}
      <div className="w-[200px] shrink-0 border-r border-border-default bg-bg-primary flex flex-col">
        <div className="flex items-center justify-between px-3 h-[32px] shrink-0 border-b border-border-default">
          <span className="text-[11px] font-semibold text-text-secondary">
            Knowledge ({entries.length})
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => loadEntries(currentProject.path)}
              className={cn(
                "p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors",
                loading && "animate-spin"
              )}
            >
              <RefreshCw size={10} />
            </button>
            <button
              onClick={() => setShowFolderInput(!showFolderInput)}
              className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer"
              title="New folder"
            >
              <FolderPlus size={10} />
            </button>
            <button
              onClick={() => createEntry(currentProject.path)}
              className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer"
            >
              <Plus size={12} />
            </button>
          </div>
        </div>
        {showFolderInput && (
          <div className="flex items-center gap-1 px-2 py-1 border-b border-border-default">
            <input
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleCreateFolder(); if (e.key === "Escape") setShowFolderInput(false); }}
              placeholder="Folder name..."
              className="flex-1 h-5 bg-bg-secondary border border-border-default rounded px-1.5 text-[10px] text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-border-focus"
              autoFocus
            />
          </div>
        )}
        <ScrollArea className="flex-1 py-1">
          {entries.length === 0 && !loading && (
            <div className="px-3 py-6 text-[11px] text-text-tertiary text-center">
              No notes yet. Create one or save a research paper.
            </div>
          )}

          {/* Folders */}
          {directories.map((dir) => {
            const isExpanded = expandedDirs.has(dir);
            const dirEntries = entriesByDir[dir] || [];
            return (
              <div key={`dir-${dir}`}>
                <div
                  className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-bg-hover cursor-pointer group"
                  onClick={() => toggleDir(dir)}
                >
                  <ChevronRight size={10} className={cn("text-text-tertiary shrink-0", isExpanded && "rotate-90")} />
                  <span className="text-[11px] text-text-secondary truncate flex-1">{dir}</span>
                  <span className="text-[9px] text-text-tertiary shrink-0">{dirEntries.length}</span>
                  <button onClick={(e) => { e.stopPropagation(); handleCreateNoteInDir(dir); }} className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-text-primary" title="New note"><Plus size={9} /></button>
                  <button onClick={(e) => { e.stopPropagation(); setShowSubfolderInput(dir); setSubfolderName(""); }} className="opacity-0 group-hover:opacity-100 p-0.5 text-text-tertiary hover:text-text-primary" title="New subfolder"><FolderPlus size={9} /></button>
                </div>
                {isExpanded && showSubfolderInput === dir && (
                  <div className="flex items-center gap-1 px-2 py-1 pl-7">
                    <input
                      value={subfolderName}
                      onChange={(e) => setSubfolderName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleCreateSubfolder(dir); if (e.key === "Escape") setShowSubfolderInput(null); }}
                      placeholder="Subfolder name..."
                      className="flex-1 h-5 bg-bg-secondary border border-border-default rounded px-1.5 text-[10px] text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-border-focus"
                      autoFocus
                    />
                  </div>
                )}
                {isExpanded && dirEntries.map((entry) => (
                    <button
                      key={entry.id}
                      onClick={() => { selectEntry(entry.id); setActiveRepoName(null); setRepoReadme(null); }}
                      className={cn(
                        "w-full text-left pl-7 pr-3 py-1.5 group",
                        entry.id === activeEntryId
                          ? "bg-bg-selected border-l-2 border-l-accent"
                          : "hover:bg-bg-hover border-l-2 border-l-transparent"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="w-1 h-1 rounded-full bg-text-tertiary shrink-0" />
                          <span className="text-[11px] text-text-secondary truncate">{entry.title}</span>
                        </div>
                        <button onClick={(e) => { e.stopPropagation(); deleteEntry(currentProject.path, entry.id); }} className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-error text-text-tertiary"><Trash2 size={9} /></button>
                      </div>
                    </button>
                ))}
              </div>
            );
          })}

          {/* Root-level notes */}
          {rootEntries.map((entry) => (
              <button
                key={entry.id}
                onClick={() => { selectEntry(entry.id); setActiveRepoName(null); setRepoReadme(null); }}
                className={cn(
                  "w-full text-left px-3 py-1.5 group",
                  entry.id === activeEntryId
                    ? "bg-bg-selected border-l-2 border-l-accent"
                    : "hover:bg-bg-hover border-l-2 border-l-transparent"
                )}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="w-1 h-1 rounded-full bg-text-tertiary shrink-0" />
                    <span className="text-[11px] text-text-secondary truncate">{entry.title}</span>
                  </div>
                  <button onClick={(e) => { e.stopPropagation(); deleteEntry(currentProject.path, entry.id); }} className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-error text-text-tertiary"><Trash2 size={9} /></button>
                </div>
              </button>
          ))}
          {/* Cloned Repos */}
          {clonedRepos.length > 0 && (
            <div className="mt-2 pt-2 border-t border-border-default">
              <div className="px-2 py-1 text-[10px] text-text-tertiary uppercase tracking-wide font-semibold">Repositories</div>
              {clonedRepos.map((repo) => (
                <div
                  key={repo.name}
                  onClick={() => handleRepoClick(repo.name)}
                  className={cn(
                    "flex items-center gap-1.5 px-2 py-1.5 group cursor-pointer",
                    activeRepoName === repo.name ? "bg-bg-selected border-l-2 border-l-accent" : "hover:bg-bg-hover border-l-2 border-l-transparent"
                  )}
                >
                  <GitBranch size={10} className="text-accent shrink-0" />
                  <span className="text-[11px] text-text-secondary truncate flex-1">{repo.name}</span>
                  <span className="text-[7px] text-[#000] bg-accent px-1 py-0.5 rounded font-bold shrink-0">GIT</span>
                  <button onClick={(e) => { e.stopPropagation(); handleDeleteRepo(repo.name); }} className="opacity-0 group-hover:opacity-100 p-0.5 hover:text-error text-text-tertiary"><Trash2 size={9} /></button>
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Cloned repo README view */}
        {activeRepoName ? (
          <>
            <div className="flex items-center px-4 h-[32px] shrink-0 border-b border-border-default bg-bg-primary gap-2">
              <GitBranch size={10} className="text-accent shrink-0" />
              <span className="text-[11px] text-text-secondary font-mono truncate flex-1 min-w-0">{activeRepoName}</span>
              <span className="text-[7px] text-[#000] bg-accent px-1 py-0.5 rounded font-bold shrink-0">GIT</span>
              <button onClick={() => handleCopyPath(clonedRepos.find((r) => r.name === activeRepoName)?.path ?? "")} className="p-1 rounded hover:bg-bg-hover text-text-tertiary cursor-pointer" title="Copy path"><Copy size={10} /></button>
              <button onClick={() => handleOpenNewWindow(clonedRepos.find((r) => r.name === activeRepoName)?.path ?? "")} className="p-1 rounded hover:bg-bg-hover text-text-tertiary cursor-pointer" title="Open in new window"><ExternalLink size={10} /></button>
            </div>
            {repoReadme ? (
              <textarea
                value={repoReadme}
                readOnly
                className={cn(
                  "flex-1 w-full bg-bg-base text-text-primary text-sm",
                  "font-mono leading-relaxed resize-none outline-none",
                  "p-4 select-text"
                )}
                spellCheck={false}
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center gap-3 text-text-tertiary">
                <p className="text-[12px]">No README.md found</p>
                <div className="flex items-center gap-2">
                  <button onClick={() => handleOpenNewWindow(clonedRepos.find((r) => r.name === activeRepoName)?.path ?? "")} className="flex items-center gap-1 px-2 py-1 rounded border border-border-default text-[10px] text-text-secondary hover:bg-bg-hover cursor-pointer"><ExternalLink size={10} /> Open in new window</button>
                  <button onClick={() => handleCopyPath(clonedRepos.find((r) => r.name === activeRepoName)?.path ?? "")} className="flex items-center gap-1 px-2 py-1 rounded border border-border-default text-[10px] text-text-secondary hover:bg-bg-hover cursor-pointer"><Copy size={10} /> Copy path</button>
                </div>
              </div>
            )}
          </>
        ) : activeEntry ? (
          <>
            <div className="flex items-center px-4 h-[32px] shrink-0 border-b border-border-default bg-bg-primary gap-2">
              <span className="text-[11px] text-text-secondary font-mono truncate flex-1 min-w-0">
                {activeEntry.title}
              </span>
              <span className="text-[8px] text-text-tertiary uppercase px-1 py-0.5 rounded bg-bg-elevated border border-border-default shrink-0">
                {activeEntry.source}
              </span>
              {isDirty && (
                <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
              )}
            </div>
            <textarea
              value={editContent}
              onChange={(e) => handleContentChange(e.target.value)}
              onBlur={() => { if (isDirty) { saveEntry(currentProject.path); setIsDirty(false); } }}
              className={cn(
                "flex-1 w-full bg-bg-base text-text-primary text-sm",
                "font-mono leading-relaxed resize-none outline-none",
                "p-4 placeholder:text-text-tertiary"
              )}
              placeholder="Start writing... (Markdown supported)"
              spellCheck={false}
            />
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
            Select or create a note
          </div>
        )}
      </div>
    </div>
  );
}
