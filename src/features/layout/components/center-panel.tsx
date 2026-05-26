import { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense } from "react";
import { cn } from "@/lib/utils";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useLayoutStore, type Tab } from "../stores/layout-store";
// Chat is the default landing surface — always loaded so the first paint
// shows the agent UI without a Suspense flash.
import { ChatPanel } from "@/features/chat/components/chat-panel";
import { WelcomeScreen } from "@/features/project/components/welcome-screen";
import { UnsupportedView } from "@/features/unsupported/components/unsupported-view";

// Every other tab type is lazy. Editor/Terminal in particular pull in
// CodeMirror+Lezer (~600 KB) and xterm (~250 KB) respectively — keeping
// them eager added multi-second parse cost to cold start on machines that
// don't have them in the OS file cache yet. The Suspense fallback in the
// tab content area absorbs the brief load.
const TerminalPanel = lazy(() => import("@/features/terminal/components/terminal-panel").then(m => ({ default: m.TerminalPanel })));
const EditorPanel = lazy(() => import("@/features/editor/components/editor-panel").then(m => ({ default: m.EditorPanel })));
const BrowserPanel = lazy(() => import("@/features/browser/components/browser-panel").then(m => ({ default: m.BrowserPanel })));
const MediaViewer = lazy(() => import("@/features/media/components/media-viewer").then(m => ({ default: m.MediaViewer })));
const CanvasPanel = lazy(() => import("@/features/canvas/components/canvas-panel").then(m => ({ default: m.CanvasPanel })));
const KnowledgePanel = lazy(() => import("@/features/knowledge/components/knowledge-panel").then(m => ({ default: m.KnowledgePanel })));
const KnowledgeGraph = lazy(() => import("@/features/knowledge/components/knowledge-graph").then(m => ({ default: m.KnowledgeGraph })));
const ResearchPanel = lazy(() => import("@/features/research/components/research-panel").then(m => ({ default: m.ResearchPanel })));
const SettingsPanel = lazy(() => import("@/features/settings/components/settings-panel").then(m => ({ default: m.SettingsPanel })));
const LogPanel = lazy(() => import("@/features/log/components/log-panel").then(m => ({ default: m.LogPanel })));
const PomodoroPanel = lazy(() => import("@/features/pomodoro/components/pomodoro-panel").then(m => ({ default: m.PomodoroPanel })));
import { useProjectStore } from "@/features/project/stores/project-store";
import { useChatStore } from "@/features/chat/stores/chat-store";
import { useShallow } from "zustand/react/shallow";
import {
  MessageSquare,
  Map,
  Globe,
  Loader2,
  Code,
  BookOpen,
  Brain,
  Network,
  Terminal,
  GitCompare,
  Settings,
  Plus,
  X,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  ScrollText,
  Timer,
} from "lucide-react";
import type { TabType } from "@/lib/constants";

const tabIcons: Record<TabType, React.ElementType> = {
  chat: MessageSquare,
  canvas: Map,
  browser: Globe,
  tasks: CheckSquare,
  editor: Code,
  research: BookOpen,
  knowledge: Brain,
  "knowledge-graph": Network,
  terminal: Terminal,
  diff: GitCompare,
  settings: Settings,
  log: ScrollText,
  media: Code,
  unsupported: Code,
  pomodoro: Timer,
};

export function CenterPanel() {
  const tabs = useLayoutStore.use.tabs();
  const activeTabId = useLayoutStore.use.activeTabId();
  const tabBarVisible = useLayoutStore.use.tabBarVisible();
  const tabHistory = useLayoutStore.use.tabHistory();
  const tabHistoryIndex = useLayoutStore.use.tabHistoryIndex();
  const { setActiveTab, closeTab, addTab, navigateTabBack, navigateTabForward } =
    useLayoutStore.use.actions();
  const currentProject = useProjectStore.use.currentProject();

  const canGoBack = useMemo(() => {
    for (let i = tabHistoryIndex - 1; i >= 0; i--) {
      if (tabs.find((t) => t.id === tabHistory[i])) return true;
    }
    return false;
  }, [tabHistory, tabHistoryIndex, tabs]);

  const canGoForward = useMemo(() => {
    for (let i = tabHistoryIndex + 1; i < tabHistory.length; i++) {
      if (tabs.find((t) => t.id === tabHistory[i])) return true;
    }
    return false;
  }, [tabHistory, tabHistoryIndex, tabs]);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Running-tab IDs. Pulled as a sorted string via shallow-equal selector so
  // streaming chunks (which don't change `status`) never invalidate this and
  // the tab bar doesn't re-render per token.
  const runningTabIdsArray = useChatStore(
    useShallow((s) =>
      Object.entries(s.sessions)
        .filter(([, sess]) => sess.status === "running")
        .map(([id]) => id)
        .sort()
    )
  );
  const runningTabIds = useMemo(
    () => new Set(runningTabIdsArray),
    [runningTabIdsArray]
  );

  // Show welcome screen when no project is open
  if (!currentProject) {
    return <WelcomeScreen />;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-bg-surface">
      {/* Tab bar */}
      {tabBarVisible && (
        <div className="flex items-stretch h-[29px] shrink-0 bg-bg-base border-b border-border-default">
          {/* Back / forward nav */}
          <div className="flex items-center gap-0.5 px-1 border-r border-border-default shrink-0">
            <button
              onClick={navigateTabBack}
              disabled={!canGoBack}
              className={cn(
                "flex items-center justify-center w-6 h-6 rounded transition-colors outline-none",
                canGoBack
                  ? "text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
                  : "text-text-tertiary/40 cursor-not-allowed"
              )}
              title="Back"
            >
              <ChevronLeft size={13} />
            </button>
            <button
              onClick={navigateTabForward}
              disabled={!canGoForward}
              className={cn(
                "flex items-center justify-center w-6 h-6 rounded transition-colors outline-none",
                canGoForward
                  ? "text-text-secondary hover:text-text-primary hover:bg-bg-hover cursor-pointer"
                  : "text-text-tertiary/40 cursor-not-allowed"
              )}
              title="Forward"
            >
              <ChevronRight size={13} />
            </button>
          </div>

          <div className="flex items-stretch min-w-0 flex-1 overflow-x-auto hide-scrollbar">
            {tabs.map((tab) => {
              const Icon = tabIcons[tab.type as TabType] ?? MessageSquare;
              const isActive = tab.id === activeTabId;
              const isRunning = runningTabIds.has(tab.id);
              return (
                <div
                  key={tab.id}
                  role="tab"
                  tabIndex={0}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") setActiveTab(tab.id); }}
                  className={cn(
                    "group relative flex items-center gap-1.5 pl-3 h-full text-[12px] font-medium shrink-0 cursor-pointer select-none border-r border-border-default",
                    "transition-[padding-right,background-color,color] duration-150",
                    // Reserve right padding only on hover so the close
                    // button has room without claiming any space at
                    // rest. Title text shifts left by ~16px during the
                    // fade — reads as one motion together with the X
                    // fading in.
                    tab.closable ? "pr-3 hover:pr-7" : "pr-3",
                    isActive
                      ? "text-text-primary bg-bg-surface"
                      : "text-text-tertiary bg-bg-base hover:text-text-secondary hover:bg-bg-hover",
                  )}
                >
                  {isRunning ? (
                    <Loader2 size={12} className="animate-spin text-accent shrink-0" />
                  ) : (
                    <Icon size={12} className={cn("shrink-0", isActive ? "text-text-secondary" : "text-text-tertiary")} />
                  )}
                  <span
                    className={cn(
                      "truncate max-w-[140px] leading-none",
                      tab.dirty && "italic"
                    )}
                  >
                    {tab.title}
                  </span>
                  {tab.closable && (
                    // Absolute-positioned: the button claims no inline
                    // space at rest, stays vertically centered on the
                    // tab's midline regardless of font metrics, and
                    // fades in via opacity (no width animation to
                    // drift the icon during reveal).
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }}
                      title="Close tab"
                      className={cn(
                        "absolute right-1.5 top-1/2 -translate-y-1/2",
                        "inline-flex items-center justify-center w-4 h-4 rounded-full",
                        "text-text-tertiary opacity-0",
                        "group-hover:opacity-100",
                        "hover:bg-[#ffffff22] hover:text-text-primary",
                        "transition-opacity duration-150",
                      )}
                    >
                      <X size={10} strokeWidth={2.2} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          <div className="relative flex items-center shrink-0">
            {/* Fade tabs into the new-tab button instead of a hard divider */}
            <div
              aria-hidden
              className="pointer-events-none absolute right-full top-0 h-full w-8"
              style={{
                background:
                  "linear-gradient(to right, transparent, var(--bg-base))",
              }}
            />
            <NewTabDropdown addTab={addTab} />
          </div>
        </div>
      )}

      {/* Tab content */}
      <TabContentContainer activeTab={activeTab} />
    </div>
  );
}

function TabContentContainer({ activeTab }: { activeTab: Tab | undefined }) {
  const tabs = useLayoutStore.use.tabs();
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const h = el.getBoundingClientRect().height;
      if (h > 0) setHeight(Math.floor(h));
    };
    measure();
    requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!activeTab) {
    return (
      <div ref={ref} style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden" }}>
        <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
          No tabs open
        </div>
      </div>
    );
  }

  // Keep editor, terminal, and browser instances alive across tab switches
  const persistentTabs = tabs.filter((t) => t.type === "editor" || t.type === "terminal" || t.type === "browser");
  const activeIsNonPersistent = !persistentTabs.find((t) => t.id === activeTab.id);

  return (
    <div ref={ref} style={{ flex: "1 1 0%", minHeight: 0, overflow: "hidden", position: "relative" }}>
      {/* Single Suspense boundary — Editor/Terminal/Browser are all lazy
          (CodeMirror+Lezer / xterm / WebView pull in significant chunks),
          and we want one fallback for the whole pane rather than per-tab
          flicker. */}
      <Suspense fallback={<PanelLoading />}>
        {/* Persistent tabs: stay mounted, hidden when inactive */}
        {persistentTabs.map((tab) => {
          const isActive = tab.id === activeTab.id;
          return (
            <div
              key={tab.id}
              style={{
                display: isActive ? "contents" : "none",
              }}
            >
              {tab.type === "editor" ? (
                <EditorPanel
                  tabId={tab.id}
                  filePath={tab.data.filePath as string | undefined}
                  containerHeight={height}
                />
              ) : tab.type === "browser" ? (
                <BrowserPanel initialUrl={tab.data.url as string | undefined} />
              ) : (
                <TerminalPanel tabId={tab.id} />
              )}
            </div>
          );
        })}

        {/* Non-persistent tabs: mount/unmount normally */}
        {activeIsNonPersistent && <TabContent tab={activeTab} />}
      </Suspense>
    </div>
  );
}

function PanelLoading() {
  return (
    <div className="h-full flex items-center justify-center text-text-tertiary text-sm">
      Loading…
    </div>
  );
}

function TabContent({ tab }: { tab: Tab }) {
  switch (tab.type) {
    case "chat":
      return <ChatPanel tabId={tab.id} />;
    case "canvas":
      return <CanvasPanel />;
    case "knowledge":
      return <KnowledgePanel />;
    case "knowledge-graph":
      return <KnowledgeGraph />;
    case "research":
      return <ResearchPanel />;
    case "browser":
      return <BrowserPanel initialUrl={tab.data.url as string | undefined} />;
    case "settings":
      return <SettingsPanel />;
    case "log":
      return <LogPanel />;
    case "pomodoro":
      return <PomodoroPanel />;
    case "media":
      return <MediaViewer filePath={tab.data.filePath as string} />;
    case "unsupported":
      return <UnsupportedView filePath={tab.data.filePath as string} />;
    default:
      return <PlaceholderContent tab={tab} />;
  }
}

function PlaceholderContent({ tab }: { tab: Tab }) {
  const Icon = tabIcons[tab.type as TabType] ?? MessageSquare;
  return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="w-12 h-12 rounded-xl bg-bg-secondary border border-border-default flex items-center justify-center mx-auto">
          <Icon size={24} className="text-text-tertiary" />
        </div>
        <div>
          <p className="text-sm font-medium text-text-primary">{tab.title}</p>
          <p className="text-xs text-text-tertiary mt-1">Coming soon</p>
        </div>
      </div>
    </div>
  );
}

const NEW_TAB_OPTIONS: Array<{ type: TabType; label: string; icon: React.ElementType }> = [
  { type: "chat", label: "Chat", icon: MessageSquare },
  { type: "terminal", label: "Terminal", icon: Terminal },
  { type: "canvas", label: "Spaces", icon: Map },
  { type: "browser", label: "Browser", icon: Globe },
  { type: "research", label: "Research", icon: BookOpen },
  { type: "knowledge", label: "Knowledge", icon: Brain },
  { type: "log", label: "Log", icon: ScrollText },
  { type: "pomodoro", label: "Pomodoro", icon: Timer },
];

function NewTabDropdown({ addTab }: { addTab: (tab: Tab) => void }) {
  const handleAdd = useCallback(
    (type: TabType, label: string) => {
      addTab({
        id: `${type}-${Date.now()}`,
        type,
        title: label,
        closable: true,
        dirty: false,
        data: {},
      });
    },
    [addTab]
  );

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="self-center flex items-center justify-center w-6 h-6 text-text-tertiary hover:text-text-secondary hover:bg-bg-hover rounded transition-colors shrink-0 mx-1 cursor-pointer outline-none focus:outline-none focus-visible:outline-none ring-0 focus:ring-0">
          <Plus size={14} />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="w-[160px] rounded-lg border border-border-default bg-bg-secondary shadow-lg py-1"
          style={{ zIndex: 99999 }}
        >
          {NEW_TAB_OPTIONS.map(({ type, label, icon: Icon }) => (
            <DropdownMenu.Item
              key={type}
              onClick={() => handleAdd(type, label)}
              className="flex items-center gap-2 px-3 h-[30px] text-[11px] text-text-secondary hover:bg-bg-hover hover:text-text-primary cursor-default outline-none"
            >
              <Icon size={12} className="text-text-tertiary" />
              {label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
