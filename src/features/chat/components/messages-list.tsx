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
import { Sparkles } from "lucide-react";
import type { ChatMessage } from "@/types/agent";
import { MessageItem } from "./message-item";
import { cn } from "@/lib/utils";
import { warmMarkdownWorker } from "@/lib/markdown-cache";

// Render a faint "· Xh ago ·" divider between turns separated by more
// than this gap, so a long thread reads in sessions.
const TURN_GAP_MS = 20 * 60 * 1000;
function formatGap(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

interface MessagesListProps {
  tabId: string;
  acpSessionId: string;
  messages: ChatMessage[];
  roleFilter: "all" | "user" | "assistant";
  isStreaming: boolean;
  /** Bubble up the "scrolled-up" state so the parent can render a
   *  centered scroll-to-bottom button alongside the Claude-setup pill. */
  onShowJumpChange?: (visible: boolean, newCount?: number) => void;
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

// Persist measured row heights per message id across remounts/scrolls.
// When a message scrolls off-screen and back into view the virtualizer
// would otherwise start from the estimate and snap to the real height
// once measureElement fires, producing a visible jump. Keyed by stable
// message id, so the first `estimateSize` call after a remount returns
// the real height instantly. Module-level so it survives the entire app
// session — typical thread sizes (few hundred messages × ~80 bytes per
// entry) make this trivially small.
//
// Heights are stored as INTEGERS. `getBoundingClientRect().height` is
// fractional, and feeding fractional values back means a row re-mounting
// at 92.33 vs a cached 92.34 reads as a size change — which makes the
// virtualizer recompute offsets and nudge scrollTop on every remount.
// Rounding turns repeated measurements of unchanged content into true
// no-ops, eliminating that scroll-compensation churn (the dominant
// source of fling jank).
const measuredHeights = new Map<string, number>();
// Running aggregate of measured heights → used to estimate rows we
// haven't seen yet. A flat estimate (e.g. 200) is wildly off for a
// code-agent thread where most rows are ~40-90px tool cards: as those
// rows measure in, the total height collapses and everything above
// yanks upward (visible as big gaps mid-scroll). Estimating from the
// observed average keeps the total close to reality, so the per-row
// scroll correction stays tiny.
let heightSum = 0;
let heightCount = 0;
const DEFAULT_ROW_ESTIMATE = 96;

function recordHeight(id: string, h: number) {
  const prev = measuredHeights.get(id);
  if (prev === h) return;
  if (prev === undefined) {
    heightCount += 1;
    heightSum += h;
  } else {
    heightSum += h - prev;
  }
  measuredHeights.set(id, h);
}

function averageHeight(): number {
  return heightCount > 0 ? Math.round(heightSum / heightCount) : DEFAULT_ROW_ESTIMATE;
}
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

/** Shown in the thread while the turn is running but the agent hasn't emitted
 *  its first token yet — the otherwise-blank wait after sending. Mirrors the
 *  assistant row layout (avatar + label) with an animated "thinking" cue. */
function WorkingIndicator() {
  // Mirror MessageItem's layout (px-6 → flex gap-4 max-w-[760px] mx-auto, w-8
  // avatar) so the "Thinking" row lines up with the assistant messages above it.
  return (
    <div className="group px-6 pb-6 animate-scale-in">
      <div className="flex gap-4 max-w-[760px] mx-auto">
        <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5 bg-[var(--bg-elevated)] border border-[var(--border-default)]">
          <Sparkles size={14} className="text-[var(--text-secondary)] animate-pulse" />
        </div>
        <div className="flex h-8 items-center gap-1.5">
          <span className="text-[12px] text-[var(--text-secondary)]">Thinking</span>
          <span className="flex items-center gap-0.5">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1 w-1 rounded-full bg-[var(--text-tertiary)] animate-bounce"
                style={{ animationDelay: `${i * 150}ms` }}
              />
            ))}
          </span>
        </div>
      </div>
    </div>
  );
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

  // The assistant turn badge renders the model stamped onto each message at
  // creation (`message.model`) — never live session state, which relabels the
  // whole thread when the session's model or agent changes later. Unstamped
  // messages (pre-fix history, disk-hydrated transcripts) show no badge
  // rather than a possibly-wrong one.

  // Apply role filter + map filtered→original indices in one pass. The old
  // implementation used `messages.findIndex` per filtered message, making
  // this O(n²) on every streaming chunk (hot path) — at a few thousand
  // messages it was the single biggest contributor to UI stutter.
  //
  // We also drop phantom-empty messages (e.g. claude-agent-acp's empty
  // `thinking` blocks that arrive with `thinking: ""`). They render
  // nothing but still pay the MessageItem wrapper's vertical padding,
  // which used to show up as a mystery gap in the thread.
  // Stabilize `filtered` array identity when only the trailing message
  // mutated. During streaming, immer rewrites `session.messages` on
  // every chunk (new array ref + new tail message), while messages
  // 0..N-1 keep their object identity via structural sharing. A naive
  // useMemo would still allocate a fresh `filt` array per chunk and
  // force the virtualizer's reconciliation pass over every visible
  // item. The ref-based memo below reuses the prior `filtered` array
  // when shape + ids are unchanged — only the tail slot is swapped in
  // when its object identity changed. The virtualizer's id-keyed
  // measurement cache then keeps non-tail rows from re-measuring, and
  // memo'd MessageItems skip rendering for unchanged props.
  const prevFilteredRef = useRef<{
    filtered: ChatMessage[];
    indexMap: number[];
  } | null>(null);
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
    const prev = prevFilteredRef.current;
    if (prev && prev.filtered.length === filt.length) {
      // Check id-shape parity. We expect either:
      //   (a) every element identical (no change) → reuse prev as-is.
      //   (b) every element identical except the last → swap the tail
      //       in place into the previous array so the reference is
      //       stable but content is up to date.
      let allSameRef = true;
      let allSameId = true;
      for (let i = 0; i < filt.length; i++) {
        if (filt[i] !== prev.filtered[i]) allSameRef = false;
        if (filt[i].id !== prev.filtered[i].id) {
          allSameId = false;
          break;
        }
      }
      if (allSameId) {
        if (allSameRef) {
          return prev;
        }
        // Determine which slots changed identity. Common case during
        // streaming: only the last slot. Mutate prev in place so the
        // outer array reference is stable; React keys by message.id so
        // mutation is safe across the diff.
        for (let i = 0; i < filt.length; i++) {
          if (filt[i] !== prev.filtered[i]) prev.filtered[i] = filt[i];
        }
        return prev;
      }
    }
    const next = { filtered: filt, indexMap: idx };
    prevFilteredRef.current = next;
    return next;
  }, [messages, roleFilter, isStreaming]);

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (i) => {
      // Consult the cross-remount height cache first — when a message
      // scrolls back into view we want the row to occupy its real
      // height immediately instead of starting from the default
      // estimate and snapping after measureElement fires (visible
      // jump). For rows we haven't measured yet, estimate from the
      // running average of measured rows rather than a flat constant —
      // far closer to reality, so the total barely drifts as new rows
      // measure in and the scroll correction stays imperceptible.
      const id = filtered[i]?.id;
      if (id) {
        const cached = measuredHeights.get(id);
        if (cached !== undefined) return cached;
      }
      return averageHeight();
    },
    // Higher overscan keeps fast scrolls inside DOM-mounted territory
    // — items don't unmount/remount as the user flicks through the
    // thread, which kills both the markdown re-parse cost and the
    // first-paint estimate jump. Memory cost on a typical thread (a
    // few hundred messages × ~2 KB DOM) is trivial.
    overscan: 12,
    getItemKey: (i) => filtered[i]?.id ?? i,
    measureElement:
      typeof window !== "undefined" && !navigator.userAgent.includes("Firefox")
        ? (el) => {
            // Round to an integer so re-measures of unchanged content
            // return the exact same value and the virtualizer treats
            // them as no-ops (no offset recompute, no scrollTop nudge).
            //
            // NB: we ALWAYS report the freshly-measured height. An earlier
            // optimization skipped re-measuring while scrolling up (reuse
            // cached size, TanStack #659) to avoid upward stutter — but
            // Atlas message rows change height after first measure
            // (streaming <pre> → rendered markdown, accordions toggling,
            // images/code blocks settling), so a stale cached height left
            // tall rows too short and the next row overlapped them. Always
            // measuring is the correctness-first choice; the integer
            // rounding + average-estimate already keep scrolling smooth.
            const raw = el?.getBoundingClientRect().height ?? averageHeight();
            const h = Math.round(raw);
            const id = el?.getAttribute("data-message-id");
            if (id) recordHeight(id, h);
            return h;
          }
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

  // Cold-wake warm-up. When the window becomes active after a long idle, WebKit
  // has throttled the main thread / rAF / layout; the first scroll otherwise
  // eats the catch-up (a measurement + re-render storm), which reads as lag.
  // Front-load it here — re-measure the virtualizer and re-anchor scroll the
  // moment we regain focus, plus nudge the markdown worker awake — so the user's
  // first scroll lands on an already-warm pipeline.
  useEffect(() => {
    const onActive = () => {
      warmMarkdownWorker();
      virtualizer.measure();
      const cached = scrollPositionCache.get(cacheKey);
      let rafs = 0;
      const tick = () => {
        const n = parentRef.current;
        if (!n) return;
        if (!cached || cached.isAtBottom) {
          n.scrollTop = n.scrollHeight;
        } else {
          n.scrollTop = Math.max(
            0,
            n.scrollHeight - n.clientHeight - cached.distanceFromBottom,
          );
        }
        if (++rafs < 3) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    };
    window.addEventListener("atlas:window-active", onActive);
    return () => window.removeEventListener("atlas:window-active", onActive);
  }, [virtualizer, cacheKey]);

  // Save scroll continuously + on unmount. Publishes the "scrolled up"
  // bit to the parent via `onShowJumpChange` so the chat composer can
  // render the scroll-to-bottom pill centered alongside the Claude
  // setup pill (the parent owns the floating row above the input now).
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  // Count of messages that arrived while the user was scrolled up, shown
  // on the scroll-to-bottom pill ("3 new"). `lastSeenLenRef` marks how
  // many were visible the last time the user was at the bottom.
  const [newCount, setNewCount] = useState(0);
  const lastSeenLenRef = useRef(filtered.length);
  const filteredLenRef = useRef(filtered.length);
  filteredLenRef.current = filtered.length;
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
      if (isAtBottom) {
        // Caught up — everything is seen.
        lastSeenLenRef.current = filteredLenRef.current;
        setNewCount((c) => (c === 0 ? c : 0));
      }
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
    onShowJumpChange?.(showJumpToBottom, showJumpToBottom ? newCount : 0);
  }, [showJumpToBottom, newCount, onShowJumpChange]);

  // Container resize (panel drag, window resize, sidebar toggle) reflows
  // every message — their cached heights become wrong for the new width
  // and `scrollTop` drifts because total height shifts under it. Snapshot
  // distance-from-bottom on every width change and re-apply across a few
  // frames as the virtualizer's ResizeObserver re-measures rows. Same
  // mechanism as the mount/session-switch restore above, just driven by
  // width changes instead of cache-key changes.
  useEffect(() => {
    const el = parentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.clientWidth;
    let activeRaf: number | null = null;
    const ro = new ResizeObserver(() => {
      const node = parentRef.current;
      if (!node) return;
      const newWidth = node.clientWidth;
      if (newWidth === lastWidth) return;
      // Capture intent BEFORE the post-resize scroll has a chance to
      // fire and overwrite our cached distance. Using current scrollTop
      // here rather than the cached `distanceFromBottom` because the
      // cache may be stale by one frame.
      const distanceBefore = node.scrollHeight - node.scrollTop - node.clientHeight;
      const wasAtBottom = distanceBefore <= NEAR_BOTTOM_PX;
      lastWidth = newWidth;
      // NB: do NOT clear the height cache here. A panel drag fires this
      // observer continuously; wiping all heights every tick collapses
      // the total to count×average and makes the scroll reapply fight a
      // wildly wrong scrollHeight (visible as violent jumping). The
      // visible rows whose width actually changed are re-measured
      // automatically by the virtualizer's own per-row ResizeObserver;
      // off-screen rows keep their (stale-width) height until revisited,
      // which is a cheap one-time correction rather than a per-frame
      // storm.
      // Reapply for ~6 frames as item heights re-measure. Each pass
      // corrects against the latest scrollHeight, so we converge as
      // measurements settle.
      if (activeRaf !== null) cancelAnimationFrame(activeRaf);
      let rafs = 0;
      const tick = () => {
        const n = parentRef.current;
        if (!n) return;
        if (wasAtBottom) {
          n.scrollTop = n.scrollHeight;
        } else {
          n.scrollTop = Math.max(
            0,
            n.scrollHeight - n.clientHeight - distanceBefore,
          );
        }
        rafs += 1;
        if (rafs < 6) {
          activeRaf = requestAnimationFrame(tick);
        } else {
          activeRaf = null;
        }
      };
      activeRaf = requestAnimationFrame(tick);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (activeRaf !== null) cancelAnimationFrame(activeRaf);
    };
  }, []);

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
      lastSeenLenRef.current = filtered.length;
      setNewCount((c) => (c === 0 ? c : 0));
    } else {
      // New messages landed while the user is reading above — surface the
      // unseen count on the scroll-to-bottom pill.
      setNewCount(Math.max(0, filtered.length - lastSeenLenRef.current));
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

  // Auto-follow the TURN-END adaptive card. The streaming effect above is gated
  // on `isStreaming`, so it doesn't fire when the trailing message grows *after*
  // the turn ends — i.e. when the TurnSummaryCard's files/actions land at
  // turn_finished, or its suggestion chips resolve from loading→ready. Without
  // this a near-bottom reader drifts up a few hundred px as the card appears.
  // Same near-bottom gate, so a user reading above is never yanked.
  const trailingFooterSig = `${trailing?.turnSummary ? 1 : 0}:${trailing?.suggestions?.status ?? ""}:${trailing?.suggestions?.chips.length ?? 0}`;
  useEffect(() => {
    if (filtered.length === 0) return;
    const el = parentRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= NEAR_BOTTOM_PX) pinToBottom();
  }, [trailingFooterSig, filtered.length, pinToBottom]);

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

  // ChatGPT-style navigation rail: one tick per user message, on the left.
  const userAnchors = useMemo(
    () =>
      messages
        .map((m, i) => ({ id: m.id, index: i, role: m.role, content: m.content }))
        .filter((a) => a.role === "user")
        .map((a) => ({
          id: a.id,
          index: a.index,
          preview: (a.content || "").replace(/\s+/g, " ").trim().slice(0, 80),
        })),
    [messages],
  );
  // The active tick = the last user message at/above the top of the viewport.
  const topOriginalIndex = (() => {
    const items = virtualizer.getVirtualItems();
    return items.length ? (indexMap[items[0].index] ?? 0) : 0;
  })();
  let activeAnchorIndex = -1;
  for (const a of userAnchors) {
    if (a.index <= topOriginalIndex) activeAnchorIndex = a.index;
    else break;
  }

  return (
    <div className="relative flex-1 min-h-0">
      {userAnchors.length > 1 && (
        <div className="pointer-events-none absolute left-0 top-1/2 z-[3] -translate-y-1/2">
          {/* Fade so the rail reads cleanly over message borders/content. */}
          <div className="pointer-events-none absolute inset-y-[-12px] left-0 w-10 bg-gradient-to-r from-[var(--bg-surface)] via-[var(--bg-surface)]/70 to-transparent" />
          {/* No overflow here: an `overflow` container would clip the
              horizontally-extending hover tooltip. Natural height, centered. */}
          <div className="relative flex flex-col justify-center gap-1.5 py-2 pl-2 pr-4">
            {userAnchors.map((a) => {
              const active = a.index === activeAnchorIndex;
              return (
                <button
                  key={a.id}
                  type="button"
                  aria-label={a.preview || "Jump to message"}
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("atlas:chat-jump", { detail: { index: a.index } }),
                    )
                  }
                  className="group pointer-events-auto relative flex cursor-pointer items-center"
                >
                  <span
                    className={cn(
                      "h-0.5 rounded-full transition-all duration-200 ease-out",
                      active
                        ? "w-4 bg-[var(--accent-primary)]"
                        : "w-2 bg-[var(--text-tertiary)]/40 group-hover:w-3 group-hover:bg-[var(--text-tertiary)]",
                    )}
                  />
                  {/* Styled tooltip: the target user message preview. High z so
                      it renders above the thread content. */}
                  <span
                    className="pointer-events-none absolute left-5 top-1/2 z-[50] max-w-[260px] -translate-y-1/2 translate-x-[-4px] truncate rounded-md border border-[var(--border-default)] bg-[var(--bg-elevated)] px-2 py-1 text-[10px] text-[var(--text-secondary)] opacity-0 shadow-[var(--shadow-overlay)] transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100"
                    style={{ backdropFilter: "blur(8px)" }}
                  >
                    {a.preview || "(message)"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div
        ref={parentRef}
        // `overflow-anchor: none` stops the browser's native scroll
        // anchoring from competing with the virtualizer's own offset
        // bookkeeping (a source of small scroll-position fights).
        className="h-full overflow-y-auto hide-scrollbar [overflow-anchor:none]"
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
              const prev = vItem.index > 0 ? filtered[vItem.index - 1] : null;
              const gapMs = prev
                ? new Date(message.timestamp).getTime() -
                  new Date(prev.timestamp).getTime()
                : 0;
              const timeGapAbove =
                prev && gapMs > TURN_GAP_MS ? formatGap(gapMs) : null;
              return (
                <div
                  key={message.id}
                  ref={virtualizer.measureElement}
                  data-index={vItem.index}
                  data-message-id={message.id}
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
                    tabId={tabId}
                    streaming={message.id === streamingId}
                    model={message.model ?? null}
                    timeGapAbove={timeGapAbove}
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
        {/* Working indicator: the turn is running but no assistant token has
            arrived yet (the 5–8s the model spends before its first chunk). The
            streaming spinner only shows once an assistant message exists, so
            without this the thread looks idle after sending. */}
        {isStreaming && !streamingId && <WorkingIndicator />}
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

