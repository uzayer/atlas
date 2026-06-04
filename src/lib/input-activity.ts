// Shared "user is actively typing" signal.
//
// The chat composer (CodeMirror) stamps activity on every keydown/doc change.
// Heavy, uninterruptible main-thread work that is otherwise scheduled during
// idle time — notably the chat markdown+syntax-highlight parse in
// `markdown-cache.tsx` — checks this before running so it doesn't seize the
// thread in the middle of a keystroke burst and stall input.
//
// `requestIdleCallback` already yields for callbacks that haven't started, but
// a parse already in flight can't be preempted; gating on recent input keeps
// such long tasks out of active typing windows entirely.

let lastInputAt = 0;

/** Record that the user just interacted with a text input. */
export function markInputActivity(): void {
  lastInputAt = performance.now();
}

/** True if the user typed within the last `windowMs` (default 600ms). */
export function isTypingHot(windowMs = 600): boolean {
  return performance.now() - lastInputAt < windowMs;
}
