// Block-level splitting for streaming markdown. Parse the source to an mdast
// (parse only — no rehype/highlight/sanitize, so it's cheap + linear) and slice
// it into its top-level blocks by source offset. A completed block's slice is
// byte-identical every frame, so rendering each block through the source-keyed
// `CachedMarkdown` cache makes completed blocks pure cache hits — only the
// trailing (still-streaming) block re-parses. Mirrors Zed's `root_block_starts`
// and Open WebUI's per-block-token rendering.

import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

type OffsetNode = {
  position?: { start?: { offset?: number }; end?: { offset?: number } };
};

function buildParser() {
  return unified().use(remarkParse).use(remarkGfm);
}
let parser: ReturnType<typeof buildParser> | null = null;
function getBlockParser(): ReturnType<typeof buildParser> {
  if (!parser) parser = buildParser();
  return parser;
}

/**
 * Split a markdown source into its top-level block source strings. Returns
 * `[source]` (a single block) when there's nothing to split or on any parse
 * error — the caller renders that one block as a whole, which is always safe.
 */
export function splitTopLevelBlocks(source: string): string[] {
  if (!source) return [];
  try {
    const tree = getBlockParser().parse(source) as { children?: OffsetNode[] };
    const children = tree.children ?? [];
    if (children.length <= 1) return [source];
    const blocks: string[] = [];
    for (const child of children) {
      const start = child.position?.start?.offset;
      const end = child.position?.end?.offset;
      if (start == null || end == null) continue;
      const block = source.slice(start, end);
      if (block.trim().length > 0) blocks.push(block);
    }
    return blocks.length > 0 ? blocks : [source];
  } catch {
    return [source];
  }
}

const REF_DEF = /^\s{0,3}\[[^\]]+\]:\s/m;
const FOOTNOTE_DEF = /^\s{0,3}\[\^[^\]]+\]:\s/m;

/**
 * True when the source uses reference-style link/image or footnote
 * *definitions* — the one case where independent per-block parsing loses
 * cross-block context. The caller falls back to a whole-message render. Rare in
 * agent output.
 */
export function hasReferenceDefinitions(source: string): boolean {
  return REF_DEF.test(source) || FOOTNOTE_DEF.test(source);
}

/**
 * True when `block` opens a fenced code block that hasn't been closed yet — the
 * still-streaming trailing code block. Render it as plain text until the fence
 * closes so a growing code block doesn't re-highlight every frame (it snaps to
 * highlighted once complete).
 */
export function isIncompleteCodeFence(block: string): boolean {
  const lines = block.split("\n");
  const first = (lines[0] ?? "").trimStart();
  const open = first.match(/^(`{3,}|~{3,})/);
  if (!open) return false;
  const fenceChar = open[1][0]; // ` or ~ (both are literal in regex)
  const minLen = open[1].length;
  const closeRe = new RegExp(`^\\s{0,3}${fenceChar}{${minLen},}\\s*$`);
  for (let i = 1; i < lines.length; i++) {
    if (closeRe.test(lines[i])) return false; // found the closing fence
  }
  return true; // opened, never closed
}
