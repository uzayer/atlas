import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import "highlight.js/styles/github-dark.css";

interface Props {
  source: string;
}

/**
 * Read-only README viewer for the KB git/repo section. Distinct from the
 * shared `<Markdown>` helper (which is tuned for chat bubbles with tight
 * spacing): this one targets long-form documentation with proper heading
 * scale, image rendering, and raw-HTML support since most GitHub READMEs
 * lean heavily on `<h1 align="center">`, `<details>`, `<img>`, etc.
 */
export const ReadmeView = memo(function ReadmeView({ source }: Props) {
  return (
    <div className="atlas-readme text-[14px] leading-relaxed text-[var(--text-primary)] break-words select-text">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // `rehype-raw` lets <h1>, <p>, <a>, <img>, <details>, etc. that
        // appear inline in the markdown actually render as HTML. Without
        // it ReactMarkdown escapes the tags and you see the source.
        rehypePlugins={[rehypeRaw, rehypeHighlight]}
        components={{
          h1: (p) => (
            <h1 className="text-[26px] font-bold tracking-tight mt-8 mb-3 pb-2 border-b border-[var(--border-default)]">
              {p.children}
            </h1>
          ),
          h2: (p) => (
            <h2 className="text-[20px] font-semibold tracking-tight mt-7 mb-3 pb-1.5 border-b border-[var(--border-subtle)]">
              {p.children}
            </h2>
          ),
          h3: (p) => (
            <h3 className="text-[16px] font-semibold mt-6 mb-2">{p.children}</h3>
          ),
          h4: (p) => (
            <h4 className="text-[14px] font-semibold mt-4 mb-1.5">{p.children}</h4>
          ),
          p: (p) => <p className="my-3">{p.children}</p>,
          a: (p) => (
            <a
              {...p}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--accent-primary)] underline hover:opacity-80"
            />
          ),
          ul: (p) => <ul className="list-disc pl-6 space-y-1 my-3">{p.children}</ul>,
          ol: (p) => <ol className="list-decimal pl-6 space-y-1 my-3">{p.children}</ol>,
          li: (p) => <li className="leading-relaxed">{p.children}</li>,
          img: (p) => (
            // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
            <img
              {...p}
              className="inline-block max-w-full h-auto rounded my-1 align-middle"
            />
          ),
          code(props) {
            const { className, children, ...rest } = props as {
              className?: string;
              children?: React.ReactNode;
            };
            const isInline = !className;
            if (isInline) {
              return (
                <code
                  className="px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-primary)] text-[12.5px] font-mono"
                  {...rest}
                >
                  {children}
                </code>
              );
            }
            return (
              <code className={className} {...rest}>
                {children}
              </code>
            );
          },
          pre: (p) => (
            <pre
              className="rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] p-4 text-[12.5px] my-4 overflow-x-auto"
              style={{ whiteSpace: "pre", wordBreak: "normal" }}
            >
              {p.children}
            </pre>
          ),
          blockquote: (p) => (
            <blockquote className="border-l-2 border-[var(--border-default)] pl-4 my-3 text-[var(--text-secondary)]">
              {p.children}
            </blockquote>
          ),
          hr: () => <hr className="my-6 border-[var(--border-subtle)]" />,
          table: (p) => (
            <div className="my-4 rounded-md border border-[var(--border-default)] overflow-x-auto">
              <table className="w-full text-[13px] border-collapse">{p.children}</table>
            </div>
          ),
          thead: (p) => (
            <thead className="bg-[var(--bg-elevated)]">{p.children}</thead>
          ),
          th: (p) => (
            <th className="px-3 py-2 text-left text-[12px] font-semibold text-[var(--text-secondary)] border-b border-[var(--border-default)] border-r last:border-r-0">
              {p.children}
            </th>
          ),
          tr: (p) => (
            <tr className="border-b border-[var(--border-subtle)] last:border-b-0">
              {p.children}
            </tr>
          ),
          td: (p) => (
            <td className="px-3 py-2 align-top text-[13px] text-[var(--text-primary)] border-r border-[var(--border-subtle)] last:border-r-0 break-words">
              {p.children}
            </td>
          ),
          details: (p) => (
            <details className="my-3 rounded-md border border-[var(--border-default)] bg-[var(--bg-secondary)] px-3 py-2">
              {p.children}
            </details>
          ),
          summary: (p) => (
            <summary className="cursor-pointer font-medium text-[var(--text-primary)] py-1">
              {p.children}
            </summary>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
