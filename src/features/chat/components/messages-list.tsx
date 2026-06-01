import {
  forwardRef,
  useRef,
  useState,
  useEffect,
  useImperativeHandle,
  useMemo,
  useCallback,
  useLayoutEffect,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { ChatMessage } from "@/types/agent";
import { MessageItem } from "./message-item";
import { cn } from "@/lib/utils";

interface MessagesListProps {
  tabId: string;
  acpSessionId: string;
  messages: ChatMessage[];
  roleFilter: "all" | "user" | "assistant";
  isStreaming: boolean;
  /** Bubble up the "scrolled-up" state so the parent can render a
   *  centered scroll-to-bottom button alongside the Claude-setup pill. */
  onShowJumpChange?: (visible: boolean) => void;
}

/** Imperative handle exposed via `ref` — parent calls `scrollToBottom`
 *  when the user clicks the floating button it now owns. */
export interface MessagesListHandle {
  scrollToBottom: () => void;
}

// Persist scroll position per (tab, on-disk-session) across remounts.
// We cache distance-from-bottom rather than raw scrollTop because the
// virtualizer doesn't know item sizes on remount — for a few frames
// scrollHeight is the estimate-based total, then it grows as each
// MessageItem reports its real height. Re-applying an absolute scrollTop
// against the wrong total leaves the user at a near-random position;
// re-applying distance-from-bottom stays correct as the total grows.
interface CachedScroll {
  distanceFromBottom: number;
  isAtBottom: boolean;
}
const scrollPositionCache = new Map<string, CachedScroll>();
// Wider than it looks like it should be: a streaming assistant message
// grows in chunks of several lines per RAF. If the user is within ~one
// screen of the bottom, treat them as "following" and keep pinning.
const NEAR_BOTTOM_PX = 320;

/** A message is "empty" — would render nothing visible — when it has
 *  no prose, no thinking text, no tool calls, no file changes, and no
 *  plan. claude-agent-acp routinely emits empty `thinking` blocks
 *  (signature-only, content `""`) as turn markers; rendering them
 *  produces phantom message-items whose wrapper padding shows up as
 *  unexplained gaps in the thread. Filter them out at the list level. */
function isEmptyMessage(m: ChatMessage): boolean {
  const hasProse = m.content && m.content.trim().length > 0;
  const hasThinking = m.thinking && m.thinking.trim().length > 0;
  const hasTools = m.toolCalls.length > 0;
  const hasFiles = m.fileChanges.length > 0;
  const hasPlan = m.plan != null && m.plan.length > 0;
  return !hasProse && !hasThinking && !hasTools && !hasFiles && !hasPlan;
}

export const MessagesList = forwardRef<MessagesListHandle, MessagesListProps>(
  function MessagesList(
    {
      tabId,
      acpSessionId,
      messages,
      roleFilter,
      isStreaming,
      onShowJumpChange,
    },
    ref,
  ) {
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
  //
  // We also drop phantom-empty messages (e.g. claude-agent-acp's empty
  // `thinking` blocks that arrive with `thinking: ""`). They render
  // nothing but still pay the MessageItem wrapper's vertical padding,
  // which used to show up as a mystery gap in the thread.
  const { filtered, indexMap } = useMemo(() => {
    const filt: ChatMessage[] = [];
    const idx: number[] = [];
    const lastIdx = messages.length - 1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (roleFilter !== "all" && m.role !== roleFilter) continue;
      // Keep the streaming-tail message even if it's transiently empty
      // so MessageItem can render its "Thinking…" spinner; otherwise
      // drop phantom-empty messages so they don't add invisible gaps.
      const isStreamingTail = isStreaming && i === lastIdx && m.role === "assistant";
      if (!isStreamingTail && isEmptyMessage(m)) continue;
      filt.push(m);
      idx.push(i);
    }
    return { filtered: filt, indexMap: idx };
  }, [messages, roleFilter, isStreaming]);

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

  // Restore cached scroll on mount / session switch. We apply the
  // distance-from-bottom over several frames because the virtualizer
  // grows scrollHeight as it measures each item the first time it
  // renders — a single restore against the initial estimate-based
  // total lands at the wrong absolute position.
  useLayoutEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const cached = scrollPositionCache.get(cacheKey);
    const apply = () => {
      const node = parentRef.current;
      if (!node) return;
      if (!cached || cached.isAtBottom) {
        node.scrollTop = node.scrollHeight;
      } else {
        node.scrollTop = Math.max(
          0,
          node.scrollHeight - node.clientHeight - cached.distanceFromBottom,
        );
      }
    };
    apply();
    // Re-apply across the next few frames as MessageItems measure their
    // real heights (the virtualizer ResizeObserver bumps total size on
    // each measurement). Six frames is roughly 100 ms — enough for the
    // typical ~30-message viewport to settle.
    let rafs = 0;
    const tick = () => {
      apply();
      if (++rafs < 6) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [cacheKey]);

  // Save scroll continuously + on unmount. Publishes the "scrolled up"
  // bit to the parent via `onShowJumpChange` so the chat composer can
  // render the scroll-to-bottom pill centered alongside the Claude
  // setup pill (the parent owns the floating row above the input now).
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const isAtBottom = distance <= NEAR_BOTTOM_PX;
      scrollPositionCache.set(cacheKey, {
        distanceFromBottom: distance,
        isAtBottom,
      });
      setShowJumpToBottom(!isAtBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      scrollPositionCache.set(cacheKey, {
        distanceFromBottom: distance,
        isAtBottom: distance <= NEAR_BOTTOM_PX,
      });
      el.removeEventListener("scroll", onScroll);
    };
  }, [cacheKey]);

  useEffect(() => {
    onShowJumpChange?.(showJumpToBottom);
  }, [showJumpToBottom, onShowJumpChange]);

  // When this list unmounts (tab close, project change), make sure the
  // parent's "scrolled up" bit doesn't get stuck at `true`.
  useEffect(() => {
    return () => {
      onShowJumpChange?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // `virtualizer.scrollToIndex(..., {align: "end"})` computes its
  // target from the items' currently estimated/measured sizes. During
  // streaming the trailing message keeps growing past that estimate,
  // so the viewport is left a few hundred px above the true bottom.
  // Pinning directly to `scrollHeight` on the next frame always lands
  // at the actual bottom regardless of measurement state.
  const pinToBottom = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    requestAnimationFrame(() => {
      if (!parentRef.current) return;
      parentRef.current.scrollTop = parentRef.current.scrollHeight;
    });
  }, []);

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
      pinToBottom();
    }
  }, [filtered.length, pinToBottom]);

  // Auto-follow STREAMING content. The effect above only fires when a new
  // message is appended; during a streaming turn the agent mutates the
  // trailing message's `content` / `thinking` / `toolCalls` without
  // changing `filtered.length`, so we'd be left behind. Depend on those
  // three signals explicitly. Still gated on near-bottom so users who
  // scrolled up to read aren't yanked back down.
  const trailing = filtered[filtered.length - 1];
  const trailingContentLen = trailing?.content.length ?? 0;
  const trailingThinkingLen = trailing?.thinking?.length ?? 0;
  const trailingToolCount = trailing?.toolCalls.length ?? 0;
  useEffect(() => {
    if (!isStreaming) return;
    if (filtered.length === 0) return;
    const el = parentRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= NEAR_BOTTOM_PX) {
      pinToBottom();
    }
  }, [
    isStreaming,
    trailingContentLen,
    trailingThinkingLen,
    trailingToolCount,
    filtered.length,
    pinToBottom,
  ]);

  const scrollToBottom = useCallback(() => {
    if (filtered.length === 0) return;
    pinToBottom();
  }, [filtered.length, pinToBottom]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom,
    }),
    [scrollToBottom],
  );

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

      {/* Bottom fade — visual cue that there's more content below the
          fold. Gated on the same `showJumpToBottom` bit we publish to
          the parent so the fade and the (now parent-owned) scroll
          button crossfade together. */}
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
    </div>
  );
});

