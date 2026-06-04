// Pure markdown → sanitized-HTML pipeline. Lives in its own module so it can
// be imported BOTH on the main thread (synchronous fast path for small blocks
// + worker-unavailable fallback) and inside the markdown Web Worker
// (`markdown.worker.ts`) without the logic drifting between the two.
//
// Pipeline (mirrors react-markdown internals):
//   remark-parse → remark-gfm → remark-rehype
//   → rehype-highlight (tokenise code blocks) → rehype-sanitize
//   → rehype-stringify.
//
// `rehype-sanitize` is in the chain on purpose: the HTML lands in the DOM via
// `dangerouslySetInnerHTML`, so we guarantee no script tags, inline event
// handlers, or `javascript:` URLs survive a malicious or pasted prompt. We
// extend the default schema with the few classNames rehype-highlight emits so
// its colors don't get stripped.

import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";

const SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), ["className"]],
    pre: [...(defaultSchema.attributes?.pre ?? []), ["className"]],
    span: [...(defaultSchema.attributes?.span ?? []), ["className"]],
  },
};

let processor: Processor | null = null;
function getProcessor(): Processor {
  if (!processor) {
    processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype, { allowDangerousHtml: false })
      .use(rehypeHighlight, { detect: true, plainText: ["text", "plaintext"] })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .use(rehypeSanitize, SANITIZE_SCHEMA as any)
      .use(rehypeStringify) as unknown as Processor;
  }
  return processor;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Parse one markdown source string to sanitized HTML. Synchronous and
 *  uncached — callers own caching. Never throws: falls back to an escaped
 *  paragraph on parser error. */
export function parseMarkdown(src: string): string {
  try {
    return String(getProcessor().processSync(src));
  } catch {
    return `<p>${escapeHtml(src)}</p>`;
  }
}
