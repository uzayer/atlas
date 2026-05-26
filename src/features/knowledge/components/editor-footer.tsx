interface EditorFooterProps {
  wordCount: number;
  charCount: number;
  /** "indexed" | "pending" — drives the status dot color + label.
   *  Lives at the right edge of the footer (the old vault slot). */
  status: "indexed" | "pending";
}

const READ_WPM = 240;

/**
 * Compact footer: word/char/read counts on the left, indexing status
 * on the right where the vault label used to be. Vault label removed
 * per user feedback — the project context is already shown elsewhere
 * (sidebar + breadcrumbs).
 */
export function EditorFooter({ wordCount, charCount, status }: EditorFooterProps) {
  const readMinutes = Math.max(1, Math.round(wordCount / READ_WPM));
  return (
    <div
      className="flex items-center shrink-0 border-t border-border-subtle text-text-tertiary"
      style={{
        height: 24,
        gap: 14,
        padding: "0 14px",
        fontSize: 10,
        background: "var(--bg-canvas)",
      }}
    >
      <span>
        <span className="mono tnum">{wordCount.toLocaleString("en-US")}</span> words
      </span>
      <span>
        <span className="mono tnum">{charCount.toLocaleString("en-US")}</span> chars
      </span>
      <span>
        <span className="mono">~{readMinutes}m</span> read
      </span>
      <span className="flex-1" />
      <span className="flex items-center" style={{ gap: 5 }}>
        <span
          className="dot"
          style={{
            width: 5,
            height: 5,
            background:
              status === "indexed"
                ? "var(--status-success)"
                : "var(--text-muted)",
          }}
        />
        {status === "indexed" ? "Indexed for retrieval" : "Pending index"}
      </span>
    </div>
  );
}
