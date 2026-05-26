import type { CSSProperties, ReactNode } from "react";
import {
  ChevronRight,
  File as FileIcon,
  Folder,
  FolderOpen,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { INDENT_PER_LEVEL, ROW_HEIGHT } from "../lib/tree-constants";

interface TreeRowProps {
  depth: number;
  /** True for folders/groups — renders a twisty chevron. */
  isDir: boolean;
  /** Folder open/closed state. Ignored when !isDir. */
  isExpanded?: boolean;
  isActive?: boolean;
  name: string;
  /** Tooltip on hover (commonly the full path). */
  title?: string;
  onClick: () => void;
  /** Absolute-positioning style from the virtualizer. */
  style?: CSSProperties;
  /** Optional leaf icon override (defaults to lucide `File`). Folders
   *  always render Folder/FolderOpen regardless of this. */
  leafIcon?: LucideIcon;
  /** Optional leaf icon rendered as inline content (e.g. an emoji glyph
   *  from page metadata). Takes precedence over `leafIcon`. */
  leafIconNode?: ReactNode;
  /** Optional trailing slot rendered at the row's right edge.
   *  Useful for hover-revealed actions (delete, new-file, etc.). */
  trailing?: ReactNode;
}

/**
 * One row in a virtualized tree. Extracted from FileTree so the
 * knowledge tree can reuse the exact same row chrome (indent, chevron,
 * hover state, active pill) — see plans/lexical-wibbling-elephant.md.
 */
export function TreeRow({
  depth,
  isDir,
  isExpanded,
  isActive,
  name,
  title,
  onClick,
  style,
  leafIcon: LeafIcon = FileIcon,
  leafIconNode,
  trailing,
}: TreeRowProps) {
  // Rendered as a div (not <button>) so the optional `trailing` slot
  // can host real <button> children — nested buttons are invalid HTML
  // and trigger a React DOM-nesting error.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      title={title}
      className={cn(
        "absolute left-0 right-0 flex items-center gap-1.5 text-left rounded-md mx-1",
        "transition-colors cursor-pointer group select-none",
        "focus:outline-none focus-visible:ring-1 focus-visible:ring-border-focus",
        isActive
          ? "bg-[var(--bg-elevated)] text-text-primary"
          : "text-text-secondary hover:bg-bg-hover hover:text-text-primary",
      )}
      style={{
        height: ROW_HEIGHT - 2,
        top: 1,
        // Base 2px lands the chevron at 12px from the panel edge,
        // matching the header's `px-3` so the name aligns vertically
        // with the panel title (see comment in file-tree.tsx).
        paddingLeft: 2 + depth * INDENT_PER_LEVEL,
        paddingRight: 6,
        ...style,
      }}
    >
      {isDir ? (
        <ChevronRight
          size={12}
          className={cn(
            "shrink-0 text-text-tertiary transition-transform",
            isExpanded && "rotate-90",
          )}
          strokeWidth={2}
        />
      ) : (
        <span className="w-3 shrink-0" aria-hidden />
      )}

      {isDir ? (
        isExpanded ? (
          <FolderOpen
            size={13}
            className="shrink-0 text-text-tertiary"
            strokeWidth={1.5}
          />
        ) : (
          <Folder
            size={13}
            className="shrink-0 text-text-tertiary"
            strokeWidth={1.5}
          />
        )
      ) : leafIconNode ? (
        <span
          className="shrink-0 inline-flex items-center justify-center"
          style={{ width: 13, height: 13, fontSize: 12, lineHeight: 1 }}
        >
          {leafIconNode}
        </span>
      ) : (
        <LeafIcon
          size={13}
          className="shrink-0 text-text-tertiary"
          strokeWidth={1.5}
        />
      )}

      <span
        className={cn(
          "truncate font-mono text-[12px] leading-none flex-1 min-w-0",
          isDir && "text-text-primary",
        )}
      >
        {name}
      </span>

      {trailing ? (
        <span className="shrink-0 flex items-center gap-0.5">{trailing}</span>
      ) : null}
    </div>
  );
}
