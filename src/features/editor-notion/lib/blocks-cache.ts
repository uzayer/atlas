/**
 * Module-level cache of parsed editor documents keyed by knowledge
 * entry id (or any opaque string the caller picks). Lives outside the
 * Zustand store on purpose:
 *
 *  - Document JSON trees are large nested objects; Immer-proxying them
 *    costs more than the cache saves.
 *  - The cache is pure view-state (Rust still owns the markdown on
 *    disk and the @mention pipeline) so it doesn't belong in
 *    `useKnowledgeStore`.
 *  - Switching to a previously-viewed note becomes a synchronous
 *    `editor.commands.setContent(get(id))` — no markdown reparse.
 *
 * Stores the editor's JSON document shape (Tiptap's `getJSON()`).
 * Tiptap parses markdown via the tiptap-markdown extension; once
 * parsed, we keep the JSON so the next visit doesn't pay parse cost.
 */
import type { JSONContent } from "@tiptap/core";

const cache = new Map<string, JSONContent>();

export function getCachedDoc(id: string): JSONContent | undefined {
  return cache.get(id);
}

export function setCachedDoc(id: string, doc: JSONContent): void {
  cache.set(id, doc);
}

export function dropCachedDoc(id: string): void {
  cache.delete(id);
}

export function clearDocCache(): void {
  cache.clear();
}
