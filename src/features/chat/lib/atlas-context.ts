// Helpers for splitting the "Atlas context" suffix the @-mention picker
// appends to user prose. Lives in /lib/ so both the chat-store
// (computing once on message insert) and the MessageItem renderer (as
// a fallback for legacy messages) can use the same split logic.

export const ATLAS_CONTEXT_MARKER = "\n\n---\n# Atlas context\n\n";

export interface SplitContext {
  prose: string;
  context: string | null;
  blockCount: number;
}

/** Split a user message into (prose, contextBody, contextBlockCount).
 *  Returns `context: null` for messages without an Atlas-context
 *  suffix. Each block in the context starts with a `## ` heading
 *  (see `composePrompt`) so block count is a regex over the body. */
export function splitAtlasContext(content: string): SplitContext {
  const idx = content.indexOf(ATLAS_CONTEXT_MARKER);
  if (idx === -1) return { prose: content, context: null, blockCount: 0 };
  const prose = content.slice(0, idx);
  const context = content.slice(idx + ATLAS_CONTEXT_MARKER.length).replace(/\n+$/, "");
  if (context.length === 0) return { prose, context: null, blockCount: 0 };
  const matches = context.match(/^## /gm);
  return {
    prose,
    context,
    blockCount: matches ? matches.length : 0,
  };
}
