/**
 * Flush registry — the "save all pending UI state" coordinator used when
 * switching or closing workspaces (and on app quit).
 *
 * Many stores persist project-scoped state to `<project>/.atlas/*.json`
 * through their own *debounced* `invoke(...)` writes. None of them expose a
 * way to (a) cancel the pending debounce and (b) await the resulting write.
 * Without that, switching workspaces could drop the last few edits that were
 * still sitting in a debounce timer.
 *
 * Each store registers a `flush()` that MUST: cancel its debounce timer,
 * perform the save immediately, and return a promise that resolves only once
 * the underlying `invoke` settles. `flushAll()` awaits every registered
 * flush. It is intentionally resilient — one store throwing never blocks the
 * others (and therefore never blocks a workspace switch).
 */

/** Context passed to each flush so it writes to the OUTGOING workspace even
 *  after `currentProject` has already swapped to the incoming one. */
export interface FlushCtx {
  workspaceId: string | null;
  path: string | null;
}

export type FlushFn = (ctx: FlushCtx) => Promise<void>;

interface Registration {
  /** Stable label, for dedupe + diagnostics. */
  id: string;
  flush: FlushFn;
}

const registry = new Map<string, Registration>();

/**
 * Register (or replace) a store's flush function. Returns an unregister
 * callback. Safe to call at module load — stores register once on import.
 */
export function registerFlush(id: string, flush: FlushFn): () => void {
  registry.set(id, { id, flush });
  return () => {
    const current = registry.get(id);
    if (current && current.flush === flush) registry.delete(id);
  };
}

/**
 * Flush every registered store for the given workspace. Resolves only after
 * ALL flushes settle, so callers can `await flushAll(ctx)` and be certain
 * pending writes have hit disk. Individual failures are swallowed (logged) so
 * a single bad store can't strand a workspace switch.
 *
 * `opts.skip` omits named flushes. The workspace-SWITCH path uses this to skip
 * the `app-state` flush: on a switch that write is pure overhead (it runs
 * before the active-id swaps, so it persists the OUTGOING id, and the debounced
 * `scheduleAppStateSave()` at the end of the switch already persists the new
 * one). The data-loss-sensitive flushes (`knowledge`, `editor-state`) are NOT
 * skipped — they must still complete before the stores are snapshotted/swapped.
 * Teardown paths (close / quit) call `flushAll` with no skip so app-state is
 * still durably written there.
 */
export async function flushAll(
  ctx: FlushCtx = { workspaceId: null, path: null },
  opts: { skip?: readonly string[] } = {},
): Promise<void> {
  const skip = opts.skip;
  const pending = Array.from(registry.values())
    .filter((r) => !skip || !skip.includes(r.id))
    .map((r) =>
      r.flush(ctx).catch((e) => {
        console.warn(`flushAll: "${r.id}" flush failed:`, e);
      }),
    );
  await Promise.all(pending);
}
