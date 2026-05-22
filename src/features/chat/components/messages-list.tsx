import {
  useRef,
  useState,
  useEffect,
  useMemo,
  useCallback,
  useLayoutEffect,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown } from "lucide-react";
import type { ChatMessage } from "@/types/agent";
import { MessageItem } from "./message-item";
import { cn } from "@/lib/utils";

interface MessagesListProps {
  tabId: string;
  acpSessionId: string;
  messages: ChatMessage[];
  roleFilter: "all" | "user" | "assistant";
  isStreaming: boolean;
}

// Persist scroll position per (tab, on-disk-session) across remounts.
const scrollPositionCache = new Map<string, number>();
const NEAR_BOTTOM_PX = 100;

export function MessagesList({
  tabId,
  acpSessionId,
  messages,
  roleFilter,
  isStreaming,
}: MessagesListProps) {
  const streamingId =
    isStreaming && messages.length > 0 && messages[messages.length - 1].role === "assistant"
      ? messages[messages.length - 1].id
      : null;
  const parentRef = useRef<HTMLDivElement>(null);
  const cacheKey = `${tabId}:${acpSessionId}`;

  // Apply role filter + map filtered→original indices in one pass. The old
  // implementation used `messages.findIndex` per filtered message, making
  // this O(n²) on every streaming chunk (hot path) — at a few thousand
  // messages it was the single biggest contributor to UI stutter.
  const { filtered, indexMap } = useMemo(() => {
    if (roleFilter === "all") {
      const idx = messages.map((_, i) => i);
      return { filtered: messages, indexMap: idx };
    }
    const filt: ChatMessage[] = [];
    const idx: number[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === roleFilter) {
        filt.push(messages[i]);
        idx.push(i);
      }
    }
    return { filtered: filt, indexMap: idx };
  }, [messages, roleFilter]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 200,
    overscan: 3,
    getItemKey: (i) => filtered[i]?.id ?? i,
    measureElement:
      typeof window !== "undefined" && !navigator.userAgent.includes("Firefox")
        ? (el) => el?.getBoundingClientRect().height ?? 200
        : undefined,
  });

  // Restore cached scroll on mount / session switch.
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const cached = scrollPositionCache.get(cacheKey);
    if (cached !== undefined) {
      el.scrollTop = cached;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [cacheKey]);

  // Save scroll continuously + on unmount.
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      scrollPositionCache.set(cacheKey, el.scrollTop);
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowJumpToBottom(distance > NEAR_BOTTOM_PX);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      scrollPositionCache.set(cacheKey, el.scrollTop);
      el.removeEventListener("scroll", onScroll);
    };
  }, [cacheKey]);

  // Auto-follow new messages only when already near bottom.
  const prevLenRef = useRef(filtered.length);
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const grew = filtered.length > prevLenRef.current;
    prevLenRef.current = filtered.length;
    if (!grew) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= NEAR_BOTTOM_PX) {
      virtualizer.scrollToIndex(filtered.length - 1, { align: "end" });
    }
  }, [filtered.length, virtualizer]);

  const scrollToBottom = useCallback(() => {
    if (filtered.length === 0) return;
    virtualizer.scrollToIndex(filtered.length - 1, { align: "end" });
  }, [filtered.length, virtualizer]);

  const jumpToMessage = useCallback(
    (originalIndex: number) => {
      const filteredIdx = indexMap.findIndex((oi) => oi === originalIndex);
      if (filteredIdx < 0) return;
      virtualizer.scrollToIndex(filteredIdx, { align: "center" });
    },
    [indexMap, virtualizer]
  );

  // Listen for external jump requests (e.g. clicks in the bash-history panel).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ index: number }>).detail;
      if (typeof detail?.index !== "number") return;
      jumpToMessage(detail.index);
    };
    window.addEventListener("atlas:chat-jump", handler);
    return () => window.removeEventListener("atlas:chat-jump", handler);
  }, [jumpToMessage]);

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={parentRef}
        className="h-full overflow-y-auto hide-scrollbar"
      >
        {filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center text-[11px] text-[var(--text-tertiary)]">
            No messages match the filter.
          </div>
        ) : (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const message = filtered[vItem.index];
              return (
                <div
                  key={message.id}
                  ref={virtualizer.measureElement}
                  data-index={vItem.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${vItem.start}px)`,
                  }}
                >
                  <MessageItem
                    message={message}
                    streaming={message.id === streamingId}
                    dividerAbove={
                      vItem.index > 0 &&
                      filtered[vItem.index - 1].role !== message.role
                    }
                    // Suppress avatar + role header for consecutive
                    // assistant messages — the per-block model emits one
                    // message per tool/text/thought, and we want them
                    // grouped under a single ASSISTANT turn header like Zed.
                    compact={
                      vItem.index > 0 &&
                      filtered[vItem.index - 1].role === message.role &&
                      message.role === "assistant"
                    }
                    // Last in a same-role run — show the Reply/Save/Copy row
                    // here instead of on every member of the group.
                    isLastInGroup={
                      vItem.index === filtered.length - 1 ||
                      filtered[vItem.index + 1].role !== message.role
                    }
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Bottom fade + scroll-to-bottom button. Both are gated on the same
          showJumpToBottom flag and crossfade together so the fade never
          lingers without the affordance, and there's no abrupt pop-in. */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute left-0 right-0 bottom-0 h-16 z-[1] transition-opacity duration-200",
          showJumpToBottom ? "opacity-100" : "opacity-0"
        )}
        style={{
          background:
            "linear-gradient(to bottom, transparent, var(--bg-surface))",
        }}
      />
      <button
        onClick={scrollToBottom}
        tabIndex={showJumpToBottom ? 0 : -1}
        aria-hidden={!showJumpToBottom}
        className={cn(
          "absolute bottom-1 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3 h-7 rounded-full border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-elevated)] shadow-[0_6px_16px_rgba(0,0,0,0.5)] cursor-pointer transition-[opacity,transform,background-color,color] duration-200",
          showJumpToBottom
            ? "opacity-100 translate-y-0 pointer-events-auto"
            : "opacity-0 translate-y-1 pointer-events-none"
        )}
        title="Jump to latest"
        style={{ backdropFilter: "blur(4px)" }}
      >
        <ChevronDownIcon />
        Scroll to bottom
      </button>
    </div>
  );
}

function ChevronDownIcon() {
  return <ArrowDown size={11} />;
}
