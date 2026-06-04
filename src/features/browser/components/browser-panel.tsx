import { useState, useCallback, useRef, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
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
  AppWindow,
  RotateCw,
  BookText,
  Zap,
} from "lucide-react";

interface ReadableContent {
  title: string;
  url: string;
  html: string;
}

// Rust-owned navigation state for the embedded webview, pushed over the
// `atlas:browser-nav` event. The native child webview is the source of truth.
interface BrowserNav {
  id: string;
  url: string;
  loading: boolean;
  title: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

type BrowserMode = "live" | "reader";

interface BrowserPanelProps {
  tabId?: string;
  initialUrl?: string;
}

function normalizeUrl(url: string): string {
  const t = url.trim();
  if (t.startsWith("http://") || t.startsWith("https://")) return t;
  return `https://${t}`;
}

export function BrowserPanel({ tabId, initialUrl }: BrowserPanelProps) {
  // Stable embed id for the native child webview. One per browser tab.
  const embedId = useRef(tabId || `browser-${Math.random().toString(36).slice(2)}`).current;

  const [mode, setMode] = useState<BrowserMode>("live");
  const [inputUrl, setInputUrl] = useState(initialUrl || "");

  // ── Live (embedded native webview) state ────────────────────────────────
  const [liveNav, setLiveNav] = useState<BrowserNav | null>(null);
  const createdRef = useRef(false);
  const placeholderRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<BrowserMode>(mode);
  modeRef.current = mode;

  // ── Reader (sanitized fetch) state ──────────────────────────────────────
  const [page, setPage] = useState<ReadableContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<ReadableContent[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const currentProject = useProjectStore.use.currentProject();

  // ── Live: geometry + lifecycle ──────────────────────────────────────────

  const currentRect = useCallback((): { x: number; y: number; width: number; height: number } | null => {
    const el = placeholderRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // display:none (inactive tab) collapses to 0 — treat as "hidden".
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }, []);

  const ensureLive = useCallback(
    async (url: string) => {
      const rect = currentRect();
      if (!rect) return;
      try {
        if (!createdRef.current) {
          await invoke("browser_embed_create", { id: embedId, url, rect });
          createdRef.current = true;
        } else {
          await invoke("browser_embed_navigate", { id: embedId, url });
        }
      } catch (e) {
        logEvent({
          source: "atlas",
          kind: "browser-embed",
          summary: `Failed to load ${url} in embedded browser`,
          status: "failure",
          payload: { url, error: String(e) },
        });
      }
    },
    [embedId, currentRect],
  );

  // Listen for Rust-owned navigation deltas for this embed.
  useEffect(() => {
    const un = listen<BrowserNav>("atlas:browser-nav", (e) => {
      if (e.payload.id !== embedId) return;
      setLiveNav(e.payload);
      // Keep the address bar in sync with real navigation (clicks, redirects).
      setInputUrl(e.payload.url);
    });
    return () => {
      un.then((f) => f());
    };
  }, [embedId]);

  // Track geometry + visibility. ResizeObserver fires both when the panel
  // resizes AND when the tab is hidden (display:none → size 0), so it doubles
  // as the show/hide trigger for the native overlay.
  useEffect(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const sync = () => {
      if (modeRef.current !== "live" || !createdRef.current) return;
      const rect = currentRect();
      if (!rect) {
        invoke("browser_embed_set_visible", { id: embedId, visible: false }).catch(() => {});
      } else {
        invoke("browser_embed_set_bounds", { id: embedId, rect }).catch(() => {});
        invoke("browser_embed_set_visible", { id: embedId, visible: true }).catch(() => {});
      }
    };
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [embedId, currentRect]);

  // Create the embed once we have an initial URL and the placeholder is laid out.
  useEffect(() => {
    if (mode !== "live") return;
    if (createdRef.current || !initialUrl) return;
    const raf = requestAnimationFrame(() => ensureLive(normalizeUrl(initialUrl)));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, initialUrl]);

  // Toggle the native overlay's visibility when switching Live⇄Reader, and
  // (re)show + reposition when returning to Live.
  useEffect(() => {
    if (!createdRef.current) return;
    if (mode === "live") {
      const rect = currentRect();
      if (rect) {
        invoke("browser_embed_set_bounds", { id: embedId, rect }).catch(() => {});
        invoke("browser_embed_set_visible", { id: embedId, visible: true }).catch(() => {});
      }
    } else {
      invoke("browser_embed_set_visible", { id: embedId, visible: false }).catch(() => {});
    }
  }, [mode, embedId, currentRect]);

  // Destroy the native webview when the tab closes (panel unmounts).
  useEffect(() => {
    return () => {
      if (createdRef.current) {
        invoke("browser_embed_destroy", { id: embedId }).catch(() => {});
      }
    };
  }, [embedId]);

  // ── Reader: sanitized fetch ─────────────────────────────────────────────
  const fetchPage = useCallback(async (url: string) => {
    url = normalizeUrl(url);
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

  // ── Unified navigation (dispatches by mode) ─────────────────────────────
  const navigate = useCallback(
    (url: string) => {
      if (mode === "live") ensureLive(normalizeUrl(url));
      else fetchPage(url);
    },
    [mode, ensureLive, fetchPage],
  );

  const goBack = () => {
    if (mode === "live") {
      invoke("browser_embed_back", { id: embedId }).catch(() => {});
    } else if (historyIndex > 0) {
      const prev = history[historyIndex - 1];
      setPage(prev);
      setInputUrl(prev.url);
      setHistoryIndex((i) => i - 1);
    }
  };

  const goForward = () => {
    if (mode === "live") {
      invoke("browser_embed_forward", { id: embedId }).catch(() => {});
    } else if (historyIndex < history.length - 1) {
      const next = history[historyIndex + 1];
      setPage(next);
      setInputUrl(next.url);
      setHistoryIndex((i) => i + 1);
    }
  };

  const reload = () => {
    if (mode === "live") invoke("browser_embed_reload", { id: embedId }).catch(() => {});
    else if (page) fetchPage(page.url);
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

  const currentUrl = () => (mode === "live" ? liveNav?.url || inputUrl : page?.url || inputUrl);

  // Open the current URL in a separate native WebKit browser window.
  const openBrowserWindow = async () => {
    const url = currentUrl();
    try {
      await invoke("browser_open_window", { url });
      logEvent({ source: "atlas", kind: "browser-open-window", summary: `Opened ${url} in a browser window`, status: "success", payload: { url } });
    } catch (e) {
      logEvent({ source: "atlas", kind: "browser-open-window", summary: `Failed to open browser window: ${url}`, status: "failure", payload: { url, error: String(e) } });
    }
  };

  const openExternal = async () => {
    const url = currentUrl();
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(url);
      logEvent({ source: "atlas", kind: "browser-open-external", summary: `Opened ${url} in system browser`, status: "success", payload: { url } });
    } catch (e) {
      window.open(url, "_blank");
      logEvent({ source: "atlas", kind: "browser-open-external-fallback", summary: `Tauri opener failed; fell back to window.open: ${url}`, status: "failure", payload: { url, error: String(e) } });
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
    const url = currentUrl();
    if (url) navigator.clipboard.writeText(url);
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

  // ── Derived chrome state ────────────────────────────────────────────────
  const isLive = mode === "live";
  const canBack = isLive ? !!liveNav?.canGoBack : historyIndex > 0;
  const canFwd = isLive ? !!liveNav?.canGoForward : historyIndex < history.length - 1;
  const isLoading = isLive ? !!liveNav?.loading : loading;

  return (
    <div className="h-full flex flex-col bg-bg-base">
      {/* Address bar */}
      <div className="flex items-center gap-1.5 px-2 h-[36px] shrink-0 border-b border-border-default bg-bg-primary">
        <button onClick={goBack} disabled={!canBack} className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer disabled:opacity-30">
          <ArrowLeft size={12} />
        </button>
        <button onClick={goForward} disabled={!canFwd} className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer disabled:opacity-30">
          <ArrowRight size={12} />
        </button>
        <button onClick={reload} className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer" title="Reload">
          {isLoading ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
        </button>

        <div className="flex-1 flex items-center gap-2 h-7 rounded border border-border-default bg-bg-secondary px-2 focus-within:ring-1 focus-within:ring-border-focus">
          <Globe size={11} className="text-text-tertiary shrink-0" />
          <input
            value={inputUrl}
            onChange={(e) => setInputUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") navigate(inputUrl); }}
            className="flex-1 bg-transparent outline-none text-[11px] text-text-primary font-mono placeholder:text-text-tertiary"
            placeholder="Enter URL..."
          />
        </div>

        {/* Live ⇄ Reader toggle */}
        <button
          onClick={() => setMode((m) => (m === "live" ? "reader" : "live"))}
          className="flex items-center gap-1 px-1.5 h-6 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer"
          title={isLive ? "Switch to Reader mode (sanitized, no JS)" : "Switch to Live mode (full browser)"}
        >
          {isLive ? <Zap size={11} /> : <BookText size={11} />}
          <span className="text-[10px]">{isLive ? "Live" : "Reader"}</span>
        </button>

        {!isLive && page && currentProject && (
          <button onClick={saveToKnowledge} className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer" title="Save to knowledge base">
            <Save size={12} />
          </button>
        )}
        {!isLive && (
          <button onClick={() => setSearchOpen(!searchOpen)} className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer" title="Find in page">
            <Search size={12} />
          </button>
        )}
        <button onClick={openBrowserWindow} className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer" title="Open in browser window">
          <AppWindow size={12} />
        </button>
        <button onClick={openExternal} className="p-1 rounded hover:bg-bg-hover text-text-tertiary transition-colors cursor-pointer" title="Open in system browser">
          <ExternalLink size={12} />
        </button>
      </div>

      {/* Search bar (Reader only) */}
      {!isLive && searchOpen && (
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

      {/* ── Live mode: placeholder the native webview is positioned over ── */}
      {isLive && (
        <div ref={placeholderRef} className="flex-1 relative bg-bg-base">
          {!createdRef.current && !initialUrl && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center space-y-3">
                <Globe size={32} className="text-text-tertiary mx-auto" />
                <p className="text-sm text-text-secondary">Enter a URL to browse</p>
                <div className="flex flex-wrap gap-2 justify-center max-w-[320px] pt-2">
                  {["google.com", "youtube.com", "github.com", "news.ycombinator.com"].map((site) => (
                    <button
                      key={site}
                      onClick={() => { setInputUrl(`https://${site}`); navigate(site); }}
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
      )}

      {/* ── Reader mode: sanitized content ── */}
      {!isLive && (
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
                    <BookText size={32} className="text-text-tertiary mx-auto" />
                    <p className="text-sm text-text-secondary">Reader mode — enter a URL for a clean, JS-free view</p>
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
              <ContextMenu.Item onClick={openBrowserWindow} className="flex items-center gap-2 px-3 h-[28px] text-[11px] text-[#aaa] hover:bg-[#1a1a1a] hover:text-[#fff] cursor-default outline-none">
                <AppWindow size={11} className="text-[#555]" /> Open in Browser Window
              </ContextMenu.Item>
              <ContextMenu.Item onClick={openExternal} className="flex items-center gap-2 px-3 h-[28px] text-[11px] text-[#aaa] hover:bg-[#1a1a1a] hover:text-[#fff] cursor-default outline-none">
                <ExternalLink size={11} className="text-[#555]" /> Open in System Browser
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
      )}
    </div>
  );
}
