import { useState, useMemo, useRef, useEffect } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { useProjectStore } from "@/features/project/stores/project-store";
import { KbdCombo } from "@/ui/kbd";
import { AtlasIcon } from "@/components/atlas-icon";
import {
  MessageSquare,
  Map,
  Globe,
  CheckSquare,
  Terminal,
  Settings,
  PanelLeft,
  PanelRight,
  BookOpen,
  Brain,
  Search,
  FolderOpen,
} from "lucide-react";

interface Command {
  id: string;
  label: string;
  shortcut?: string;
  icon: React.ElementType;
  action: () => void;
  category: string;
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { addTab, toggleLeftPanel, toggleRightPanel } =
    useLayoutStore.use.actions();
  const { openProject } = useProjectStore.use.actions();

  const handleOpenFolder = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ directory: true });
      if (selected) {
        openProject(selected as string);
      }
    } catch {
      // dialog not available
    }
  };

  const commands = useMemo<Command[]>(
    () => [
      {
        id: "open-folder",
        label: "Open Folder",
        icon: FolderOpen,
        category: "Project",
        action: handleOpenFolder,
      },
      {
        id: "new-agents-chat",
        label: "New Agents Chat",
        shortcut: "⌘T",
        icon: AtlasIcon,
        category: "Tabs",
        action: () =>
          addTab({
            id: `chat-${Date.now()}`,
            type: "chat",
            title: "Agents",
            closable: true,
            dirty: false,
            data: {},
          }),
      },
      {
        id: "new-model-chat",
        label: "New Chat",
        icon: MessageSquare,
        category: "Tabs",
        action: () =>
          addTab({
            id: `model-chat-${Date.now()}`,
            type: "model-chat",
            title: "Chat",
            closable: true,
            dirty: false,
            data: {},
          }),
      },
      {
        id: "new-canvas",
        label: "New Spaces",
        icon: Map,
        category: "Tabs",
        action: () =>
          addTab({
            id: `canvas-${Date.now()}`,
            type: "canvas",
            title: "Spaces",
            closable: true,
            dirty: false,
            data: {},
          }),
      },
      {
        id: "new-terminal",
        label: "New Terminal",
        shortcut: "⌘⇧T",
        icon: Terminal,
        category: "Tabs",
        action: () =>
          addTab({
            id: `terminal-${Date.now()}`,
            type: "terminal",
            title: "Terminal",
            closable: true,
            dirty: false,
            data: {},
          }),
      },
      {
        id: "new-browser",
        label: "Open Browser",
        icon: Globe,
        category: "Tabs",
        action: () =>
          addTab({
            id: `browser-${Date.now()}`,
            type: "browser",
            title: "Browser",
            closable: true,
            dirty: false,
            data: {},
          }),
      },
      {
        id: "new-tasks",
        label: "Task Board",
        icon: CheckSquare,
        category: "Tabs",
        action: () =>
          addTab({
            id: `tasks-${Date.now()}`,
            type: "tasks",
            title: "Tasks",
            closable: true,
            dirty: false,
            data: {},
          }),
      },
      {
        id: "new-research",
        label: "Research",
        icon: BookOpen,
        category: "Tabs",
        action: () =>
          addTab({
            id: `research-${Date.now()}`,
            type: "research",
            title: "Research",
            closable: true,
            dirty: false,
            data: {},
          }),
      },
      {
        id: "new-knowledge",
        label: "Knowledge Base",
        icon: Brain,
        category: "Tabs",
        action: () =>
          addTab({
            id: `knowledge-${Date.now()}`,
            type: "knowledge",
            title: "Knowledge",
            closable: true,
            dirty: false,
            data: {},
          }),
      },
      {
        id: "toggle-left",
        label: "Toggle Left Panel",
        shortcut: "⌘B",
        icon: PanelLeft,
        category: "Layout",
        action: toggleLeftPanel,
      },
      {
        id: "toggle-right",
        label: "Toggle Right Panel",
        shortcut: "⌘⇧B",
        icon: PanelRight,
        category: "Layout",
        action: toggleRightPanel,
      },
      {
        id: "settings",
        label: "Open Settings",
        shortcut: "⌘,",
        icon: Settings,
        category: "App",
        action: () =>
          addTab({
            id: "settings",
            type: "settings",
            title: "Settings",
            closable: true,
            dirty: false,
            data: {},
          }),
      },
    ],
    [addTab, toggleLeftPanel, toggleRightPanel]
  );

  const filtered = useMemo(() => {
    if (!query) return commands;
    const q = query.toLowerCase();
    return commands.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q)
    );
  }, [query, commands]);

  useEffect(() => {
    setSelectedIndex(0);
    setQuery("");
  }, [open]);

  function runCommand(cmd: Command) {
    cmd.action();
    onOpenChange(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && filtered[selectedIndex]) {
      e.preventDefault();
      runCommand(filtered[selectedIndex]);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/60 z-[var(--z-overlay)]" />
        <Dialog.Content
          className={cn(
            "fixed top-[20%] left-1/2 -translate-x-1/2 z-[var(--z-modal)]",
            "w-[520px] max-h-[400px] rounded-xl overflow-hidden",
            "bg-[var(--bg-secondary)] border border-[var(--border-default)]",
            "shadow-[var(--shadow-overlay)]",
            "flex flex-col"
          )}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            inputRef.current?.focus();
          }}
        >
          <div className="flex items-center gap-2 px-4 h-[44px] border-b border-[var(--border-default)]">
            <Search size={14} className="text-[var(--text-tertiary)] shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a command..."
              className="flex-1 bg-transparent border-none outline-none text-sm text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
            />
          </div>

          <div className="overflow-y-auto flex-1 py-1">
            {filtered.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-[var(--text-tertiary)]">
                No commands found
              </div>
            )}
            {filtered.map((cmd, i) => {
              const Icon = cmd.icon;
              return (
                <button
                  key={cmd.id}
                  onClick={() => runCommand(cmd)}
                  onMouseEnter={() => setSelectedIndex(i)}
                  className={cn(
                    "w-full flex items-center gap-3 px-4 h-[36px] text-left text-sm transition-colors",
                    i === selectedIndex
                      ? "bg-[var(--bg-hover)] text-[var(--text-primary)]"
                      : "text-[var(--text-secondary)]"
                  )}
                >
                  <Icon size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                  <span className="flex-1 truncate">{cmd.label}</span>
                  {cmd.shortcut && <KbdCombo combo={cmd.shortcut} />}
                </button>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
