import { DEFAULT_APP_ACCENT_ID, getAppAccent } from "./accents";

// Every CSS custom property the accent may override. Monochrome (default)
// removes all of them so the app falls back to the stylesheet baseline verbatim
// (exact original look); colored accents set them.
const ACCENT_VARS = [
  "--accent-primary",
  "--accent-primary-hover",
  "--accent-primary-muted",
  "--accent-secondary",
  "--primary-foreground",
  "--panel-rail-bg",
  "--panel-bg",
  "--panel-bg-2",
  "--bg-selected",
  "--bg-active",
] as const;

/**
 * Apply the given app-accent id by writing CSS custom properties onto
 * `document.documentElement`. Slack-style: keep the AMOLED-black theme but tint
 * the side-panel surfaces (workspace rail, left file-tree panel, right
 * source-control panel) and the active/selected states with a dark shade of the
 * accent — so picking an accent visibly reskins the chrome, not just a few
 * texts. The center content (chat/editor) stays black.
 *
 * The panel tints are derived from the accent's `primary` via `color-mix`
 * (supported by the Tauri WKWebView), so no per-accent surface table is needed.
 *
 * Pure DOM, safe to call pre-mount. Mirrors `apply-editor-theme.ts`.
 */
export function applyAppAccent(id: string | undefined | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const a = getAppAccent(id);

  // Monochrome = no overrides at all → the tokens.css defaults apply (exact
  // original monochrome look, including the near-black panels).
  if (a.id === DEFAULT_APP_ACCENT_ID) {
    for (const k of ACCENT_VARS) root.style.removeProperty(k);
    return;
  }

  const p = a.primary;
  const set = (k: string, v: string) => root.style.setProperty(k, v);

  // Accent tokens (underlines, primary buttons, focus rings, mention chips).
  set("--accent-primary", p);
  set("--accent-primary-hover", a.hover);
  set("--accent-primary-muted", a.muted);
  set("--accent-secondary", a.secondary);
  set("--primary-foreground", a.foreground);

  // Tinted side-panel surfaces — a dark accent-hued shade over near-black.
  set("--panel-rail-bg", `color-mix(in srgb, ${p} 12%, #0e0f0e)`);
  set("--panel-bg", `color-mix(in srgb, ${p} 10%, #070807)`);
  set("--panel-bg-2", `color-mix(in srgb, ${p} 11%, #0b0c0b)`);

  // Accent-tinted active/selected states so highlighted rows (active workspace,
  // selected file, active tab) glow in the accent rather than plain white.
  set("--bg-selected", `color-mix(in srgb, ${p} 22%, transparent)`);
  set("--bg-active", `color-mix(in srgb, ${p} 32%, transparent)`);
}
