import { useState, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useProjectStore } from "@/features/project/stores/project-store";
import { logEvent } from "@/features/log/lib/log";
import {
  Globe,
  ExternalLink,
  Loader2,
  ArrowLeft,
  ArrowRight,
  Save,
  Search,
  Copy,
  BookOpen,
} from "lucide-react";

interface ReadableContent {
  title: string;
  url: string;
  html: string;
}

interface BrowserPanelProps {
  initialUrl?: string;
}

export function BrowserPanel({ initialUrl }: BrowserPanelProps) {
  const [inputUrl, setInputUrl] = useState(initialUrl || "https://");
  const [page, setPage] = useState<ReadableContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ReadableContent[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const currentProject = useProjectStore.use.currentProject();

  const fetchPage = useCallback(async (url: string) => {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      url = `https://${url}`;
    }
    setInputUrl(url);
    setLoading(true);
    setError(null);
    try {
      const result = await invoke<ReadableContent>("fetch_readable", { url });
      setPage(result);
      setInputUrl(result.url);
      setHistory((h) => [...h.slice(0, historyIndex + 1), result]);
      setHistoryIndex((i) => i + 1);
    } catch (e) {
      setError(String(e));
      setPage(null);
    }
    setLoading(false);
  }, [historyIndex]);

  const goBack = () => {
    if (historyIndex > 0) {
      const prev = history[historyIndex - 1];
      setPage(prev);
      setInputUrl(prev.url);
      setHistoryIndex((i) => i - 1);
    }
  };

  const goForward = () => {
    if (historyIndex < history.length - 1) {
      const next = history[historyIndex + 1];
      setPage(next);
      setInputUrl(next.url);
      setHistoryIndex((i) => i + 1);
    }
  };

  const handleContentClick = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest("a");
    if (!anchor) return;
    e.preventDefault();
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    fetchPage(href);
  }, [fetchPage]);

  const openExternal = async () => {
    const url = page?.url || inputUrl;
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      logEvent({
        source: "atlas",
        kind: "browser-open-external",
        summary: `Opened ${url} in system browser`,
        status: "success",
        payload: { url },
      });
    } catch (e) {
      window.open(url, "_blank");
      logEvent({
        source: "atlas",
        kind: "browser-open-external-fallback",
        summary: `Tauri opener failed; fell back to window.open: ${url}`,
        status: "failure",
        payload: { url, error: String(e) },
      });
    }
  };

  const saveToKnowledge = async () => {
    if (!page || !currentProject) return;
    const textContent = contentRef.current?.innerText || "";
    try {
      await invoke("save_knowledge_note", {
        projectPath: currentProject.path,
        id: `web-${Date.now()}`,
        content: `# ${page.title}\n\nSource: ${page.url}\n\n${textContent.slice(0, 50000)}`,
      });
      const { useKnowledgeStore } = await import("@/features/knowledge/stores/knowledge-store");
      useKnowledgeStore.getState().actions.loadEntries(currentProject.path);
    } catch {}
  };

  const copySelection = () => {
    const sel = window.getSelection()?.toString();
    if (sel) navigator.clipboard.writeText(sel);
  };

  const copyLink = () => {
    if (page?.url) navigator.clipboard.writeText(page.url);
  };

  const handleSearch = () => {
    if (!searchQuery || !contentRef.current) return;
    const sel = window.getSelection();
    if (!sel) return;
    sel.removeAllRanges();
    const walker = document.createTreeWalker(contentRef.current, NodeFilter.SHOW_TEXT);
    const query = searchQuery.toLowerCase();
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const text = node.textContent?.toLowerCase() || "";
      const idx = text.indexOf(query);
      if (idx >= 0) {
        const range = document.createRange();
        range.setStart(node, idx);
        range.setEnd(node, idx + searchQuery.length);
        sel.addRange(range);
        (node as HTMLElement).parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
        return;
      }
    }
  };

  return (
    <div className="h-full flex flex-col bg-bg-base">
      {/* Address bar */}
      <div className="flex items-center gap-1.5 px-2 h-[36px] shrink-0 border-b border-border-default bg-bg-primary">
        <button onClick={goBack} disabled={historyIndex <= 0} className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer disabled:opacity-30">
          <ArrowLeft size={12} />
        </button>
        <button onClick={goForward} disabled={historyIndex >= history.length - 1} className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer disabled:opacity-30">
          <ArrowRight size={12} />
        </button>

        <div className="flex-1 flex items-center gap-2 h-7 rounded border border-border-default bg-bg-secondary px-2 focus-within:ring-1 focus-within:ring-border-focus">
          <Globe size={11} className="text-text-tertiary shrink-0" />
          <input
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") fetchPage(inputUrl); }}
            className="flex-1 bg-transparent outline-none text-[11px] text-text-primary font-mono placeholder:text-text-tertiary"
            placeholder="Enter URL..."
          />
        </div>

        <button onClick={() => setSearchOpen(!searchOpen)} className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer" title="Find in page">
          <Search size={12} />
        </button>
        {page && currentProject && (
          <button onClick={saveToKnowledge} className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer" title="Save to knowledge base">
            <Save size={12} />
          </button>
        )}
        <button onClick={openExternal} className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer" title="Open in system browser">
          <ExternalLink size={12} />
        </button>
      </div>

      {/* Search bar */}
      {searchOpen && (
        <div className="flex items-center gap-1.5 px-2 h-[32px] shrink-0 border-b border-border-default bg-bg-primary">
          <Search size={11} className="text-text-tertiary shrink-0" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); if (e.key === "Escape") setSearchOpen(false); }}
            className="flex-1 bg-transparent outline-none text-[11px] text-text-primary placeholder:text-text-tertiary"
            placeholder="Find in page..."
            autoFocus
          />
        </div>
      )}

      {/* Content with context menu */}
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className="flex-1 overflow-auto hide-scrollbar" onContextMenu={(e) => e.stopPropagation()}>
            {loading && (
              <div className="flex items-center justify-center py-16">
                <Loader2 size={20} className="animate-spin text-accent" />
              </div>
            )}

            {error && (
              <div className="px-6 py-8 text-center">
                <p className="text-[12px] text-error">{error}</p>
                <button onClick={() => fetchPage(inputUrl)} className="mt-2 text-[11px] text-accent underline cursor-pointer">Retry</button>
              </div>
            )}

            {!loading && !error && page && (
              <div className="select-text">
                <div className="px-4 py-3 border-b border-border-default">
                  <h1 className="text-[15px] font-semibold text-text-primary leading-snug">{page.title}</h1>
                  <span className="text-[10px] text-text-tertiary font-mono">{page.url}</span>
                </div>
                <div
                  ref={contentRef}
                  className="reader-content px-4 py-4"
                  onClick={handleContentClick}
                  dangerouslySetInnerHTML={{ __html: page.html }}
                />
              </div>
            )}

            {!loading && !error && !page && (
              <div className="h-full flex items-center justify-center py-16">
                <div className="text-center space-y-3">
                  <Globe size={32} className="text-text-tertiary mx-auto" />
                  <p className="text-sm text-text-secondary">Enter a URL to browse</p>
                  <div className="flex flex-wrap gap-2 justify-center max-w-[300px] pt-2">
                    {["arxiv.org", "github.com", "news.ycombinator.com", "developer.mozilla.org"].map((site) => (
                      <button
                        key={site}
                        onClick={() => fetchPage(`https://${site}`)}
                        className="px-2.5 py-1 rounded border border-border-default bg-bg-secondary text-[10px] text-text-secondary hover:bg-bg-hover hover:text-text-primary transition-colors font-mono cursor-pointer"
                      >
                        {site}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className="w-[180px] rounded-lg border border-[#1a1a1a] bg-[#0f0f0f] shadow-xl py-1" style={{ zIndex: 99999 }}>
            <ContextMenu.Item onClick={copySelection} className="flex items-center gap-2 px-3 h-[28px] text-[11px] text-[#aaa] hover:bg-[#1a1a1a] hover:text-[#fff] cursor-default outline-none">
              <Copy size={11} className="text-[#555]" /> Copy Selection
            </ContextMenu.Item>
            <ContextMenu.Item onClick={copyLink} className="flex items-center gap-2 px-3 h-[28px] text-[11px] text-[#aaa] hover:bg-[#1a1a1a] hover:text-[#fff] cursor-default outline-none">
              <Globe size={11} className="text-[#555]" /> Copy Link
            </ContextMenu.Item>
            <ContextMenu.Separator className="h-px bg-[#1a1a1a] my-1" />
            <ContextMenu.Item onClick={() => setSearchOpen(true)} className="flex items-center gap-2 px-3 h-[28px] text-[11px] text-[#aaa] hover:bg-[#1a1a1a] hover:text-[#fff] cursor-default outline-none">
              <Search size={11} className="text-[#555]" /> Find in Page
            </ContextMenu.Item>
            <ContextMenu.Item onClick={openExternal} className="flex items-center gap-2 px-3 h-[28px] text-[11px] text-[#aaa] hover:bg-[#1a1a1a] hover:text-[#fff] cursor-default outline-none">
              <ExternalLink size={11} className="text-[#555]" /> Open in Browser
            </ContextMenu.Item>
            {page && currentProject && (
              <>
                <ContextMenu.Separator className="h-px bg-[#1a1a1a] my-1" />
                <ContextMenu.Item onClick={saveToKnowledge} className="flex items-center gap-2 px-3 h-[28px] text-[11px] text-[#aaa] hover:bg-[#1a1a1a] hover:text-[#fff] cursor-default outline-none">
                  <BookOpen size={11} className="text-[#555]" /> Save to Knowledge
                </ContextMenu.Item>
              </>
            )}
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
    </div>
  );
}
