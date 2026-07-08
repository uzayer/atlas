import { getAppAccent } from "./accents";

/**
 * Apply the given app-accent id by writing its tokens as CSS custom properties
 * onto `document.documentElement`. These few properties cascade through both the
 * Tailwind v4 `@theme` utilities (`--color-accent*`, `--color-primary*` in
 * globals.css) and every direct `var(--accent-*)` consumer, so overriding them
 * re-skins the whole UI accent without touching the AMOLED-black theme.
 *
 * Pure DOM, safe to call pre-mount. Mirrors `apply-editor-theme.ts`.
 */
export function applyAppAccent(id: string | undefined | null): void {
  if (typeof document === "undefined") return;
  const a = getAppAccent(id);
  const root = document.documentElement;
  root.style.setProperty("--accent-primary", a.primary);
  root.style.setProperty("--accent-primary-hover", a.hover);
  root.style.setProperty("--accent-primary-muted", a.muted);
  root.style.setProperty("--accent-secondary", a.secondary);
  // Text/icon color on a solid accent fill (shadcn `--primary` buttons).
  root.style.setProperty("--primary-foreground", a.foreground);
}
