import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * Atlas bars loader (`.atlas-loader` in globals.css) — four bars that shuffle,
 * evoking the Atlas logo. Inherits `currentColor`; `size` is the bar height in
 * px (width follows the 1.6 aspect ratio). Drop-in replacement for the circular
 * spinner.
 */
export function AtlasLoader({
  size = 16,
  className,
  style,
}: {
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={cn("atlas-loader", className)}
      role="status"
      aria-label="Loading"
      style={
        {
          height: size,
          // Keep the shuffle offset proportional to the loader size.
          "--g": `${Math.max(2, Math.round(size * 0.2))}px`,
          ...style,
        } as CSSProperties
      }
    />
  );
}
