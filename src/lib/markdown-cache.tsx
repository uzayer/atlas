// Markdown → HTML cache for the chat thread. Built once per unique source
// string and stored in a bounded LRU so virtualizer remounts (scroll a
// message off-screen and back in) don't re-parse react-markdown or re-run
// highlight.js synchronously on the main thread — the cost was visible as
// scroll-back jank on long code-heavy answers.
//
// The pipeline mirrors what `react-markdown` would do internally:
//   remark-parse → remark-gfm → remark-rehype
//   → rehype-highlight (tokenise code blocks) → rehype-sanitize
//   → rehype-stringify.
//
// `rehype-sanitize` is in the chain on purpose: cached HTML lands in the
// DOM via `dangerouslySetInnerHTML`, so we guarantee no script tags,
// inline event handlers, or `javascript:` URLs can survive a malicious or
// accidentally-pasted prompt. We extend the default schema with the few
// `className`s rehype-highlight emits so its colors don't get stripped.

import { useEffect, useRef, useState } from "react";
import { unified, type Processor } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import "highlight.js/styles/github-dark.css";
import { cn } from "./utils";

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

const CACHE_MAX = 250;
// Insertion-ordered Map → simple LRU via delete+set on hit. Bounded so a
// thread of thousands of unique strings can't grow this unbounded.
const cache = new Map<string, string>();

function renderToHtml(src: string): string {
  const cached = cache.get(src);
  if (cached !== undefined) {
    cache.delete(src);
    cache.set(src, cached);
    return cached;
  }
  let html: string;
  try {
    html = String(getProcessor().processSync(src));
  } catch {
    html = `<p>${escapeHtml(src)}</p>`;
  }
  cache.set(src, html);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return html;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Imperative entry — returns a `__html` payload ready for
 *  `dangerouslySetInnerHTML`. Cheap on cache hits (O(1) Map lookup). */
export function renderMarkdownCached(src: string): { __html: string } {
  return { __html: renderToHtml(src) };
}

interface CachedMarkdownProps {
  source: string;
  className?: string;
}

/**
 * Drop-in replacement for `<Markdown>` in the chat thread. Renders the
 * cached HTML via `dangerouslySetInnerHTML`, so scroll-back remounts
 * don't re-parse markdown or re-run highlight.js. Large strings defer
 * the first parse to a `requestIdleCallback` so initial mount paint
 * isn't blocked; subsequent remounts hit the cache and skip the deferral.
 */
export function CachedMarkdown({ source, className }: CachedMarkdownProps) {
  const [html, setHtml] = useState<string | null>(() => {
    if (cache.has(source)) return cache.get(source)!;
    if (source.length < 2000) return renderToHtml(source);
    return null;
  });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (cache.has(source)) {
      const fresh = cache.get(source)!;
      if (fresh !== html) setHtml(fresh);
      return;
    }
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      setHtml(renderToHtml(source));
    };
    type WindowWithIdle = Window & {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout?: number },
      ) => number;
    };
    const w = window as WindowWithIdle;
    if (typeof w.requestIdleCallback === "function") {
      w.requestIdleCallback(run, { timeout: 250 });
    } else {
      queueMicrotask(run);
    }
    return () => {
      cancelled = true;
    };
  }, [source, html]);

  // One delegated click handler: copy-code buttons + safe external links.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      // Copy-code button (injected below).
      const copyBtn = target?.closest?.(".atlas-code-copy");
      if (copyBtn instanceof HTMLElement) {
        e.preventDefault();
        const pre = copyBtn.closest("pre");
        const text = pre?.querySelector("code")?.textContent ?? pre?.textContent ?? "";
        void navigator.clipboard.writeText(text).catch(() => {});
        copyBtn.textContent = "Copied";
        window.setTimeout(() => {
          copyBtn.textContent = "Copy";
        }, 1200);
        return;
      }
      // External links: open in the system browser via the opener plugin
      // rather than letting an `<a>` navigate the WKWebView away from Atlas.
      const anchor = target?.closest?.("a");
      if (anchor instanceof HTMLAnchorElement && anchor.href && /^https?:/i.test(anchor.href)) {
        e.preventDefault();
        const href = anchor.href;
        void import("@tauri-apps/plugin-opener")
          .then((m) => m.openUrl(href))
          .catch(() => {});
      }
    };
    node.addEventListener("click", onClick);
    return () => node.removeEventListener("click", onClick);
  }, []);

  // Inject a language label + copy button into each code block once the
  // cached HTML lands (and again whenever it changes).
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.querySelectorAll("pre").forEach((pre) => {
      if ((pre as HTMLElement).dataset.enhanced) return;
      (pre as HTMLElement).dataset.enhanced = "1";
      const code = pre.querySelector("code");
      const lang = Array.from(code?.classList ?? [])
        .find((c) => c.startsWith("language-"))
        ?.slice("language-".length);
      const bar = document.createElement("div");
      bar.className = "atlas-code-bar";
      if (lang && lang !== "text" && lang !== "plaintext") {
        const l = document.createElement("span");
        l.className = "atlas-code-lang";
        l.textContent = lang;
        bar.appendChild(l);
      }
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "atlas-code-copy";
      btn.setAttribute("aria-label", "Copy code");
      btn.textContent = "Copy";
      bar.appendChild(btn);
      pre.appendChild(bar);
    });
  }, [html]);

  return (
    <div
      ref={ref}
      className={cn(
        "prose-chat text-[var(--text-primary)] leading-relaxed break-words select-text",
        className,
      )}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html ?? "" }}
    />
  );
}
