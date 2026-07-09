/**
 * App-accent registry — a curated set of accent "tones" for the Atlas UI.
 *
 * These do NOT change the theme: the AMOLED-black surfaces, text grays and
 * borders stay put. They re-skin the UI *accent* — the `--accent-*` tokens
 * (underlines, primary buttons, focus rings, mention chips) AND the side-panel
 * surface tints + active/selected states (see `apply-app-accent.ts`).
 *
 * Palette intent: sophisticated, slightly-muted jewel tones (Radix-9 calibrated)
 * that read premium on pure black and tint the near-black panels *cleanly* — no
 * muddy olive from raw primaries. Each accent is a single hue picked to match
 * Atlas's sleek, minimal vibe rather than Slack's saturated brights.
 *
 * `foreground` is the text/icon color on a *solid* accent fill (primary buttons)
 * — black for light accents, white for dark ones — so contrast always holds.
 */
export type AppAccent = {
  id: string;
  name: string;
  /** --accent-primary — the accent color (also shadcn `--primary`). */
  primary: string;
  /** --accent-primary-hover — a lighter shade for hover states. */
  hover: string;
  /** --accent-primary-muted — low-alpha wash (chip backgrounds, hovers). */
  muted: string;
  /** --accent-secondary — a dimmer companion tone. */
  secondary: string;
  /** --primary-foreground — text/icon color on a solid accent fill. */
  foreground: string;
};

export const DEFAULT_APP_ACCENT_ID = "monochrome";

export const APP_ACCENTS: AppAccent[] = [
  {
    // Reproduces Atlas's original monochrome accent exactly. Selecting it
    // clears every override (see apply-app-accent.ts) → pristine baseline.
    id: "monochrome",
    name: "Monochrome",
    primary: "#ffffff",
    hover: "#cccccc",
    muted: "rgba(255, 255, 255, 0.06)",
    secondary: "#777777",
    foreground: "#000000",
  },
  {
    // Refined warm gold — Atlas's signature yellow, tuned so it tints the
    // panels a clean amber rather than the muddy olive raw #ffff00 produces.
    id: "amber",
    name: "Amber",
    primary: "#ffb224",
    hover: "#ffc55c",
    muted: "rgba(255, 178, 36, 0.14)",
    secondary: "#b98a3e",
    foreground: "#000000",
  },
  {
    id: "blue",
    name: "Blue",
    primary: "#4c9dff",
    hover: "#74b3ff",
    muted: "rgba(76, 157, 255, 0.14)",
    secondary: "#5f7fa8",
    foreground: "#000000",
  },
  {
    id: "iris",
    name: "Iris",
    primary: "#6366f1",
    hover: "#8184f4",
    muted: "rgba(99, 102, 241, 0.16)",
    secondary: "#6d6fae",
    foreground: "#ffffff",
  },
  {
    id: "violet",
    name: "Violet",
    primary: "#8b5cf6",
    hover: "#a481f8",
    muted: "rgba(139, 92, 246, 0.16)",
    secondary: "#8b6fae",
    foreground: "#ffffff",
  },
  {
    id: "plum",
    name: "Plum",
    primary: "#c052ce",
    hover: "#d072dc",
    muted: "rgba(192, 82, 206, 0.15)",
    secondary: "#9c6aa3",
    foreground: "#ffffff",
  },
  {
    id: "emerald",
    name: "Emerald",
    primary: "#34d399",
    hover: "#5cdeae",
    muted: "rgba(52, 211, 153, 0.14)",
    secondary: "#5f9e86",
    foreground: "#000000",
  },
  {
    id: "teal",
    name: "Teal",
    primary: "#2dd4bf",
    hover: "#5ce0d0",
    muted: "rgba(45, 212, 191, 0.14)",
    secondary: "#5c9e97",
    foreground: "#000000",
  },
  {
    id: "coral",
    name: "Coral",
    primary: "#fb7256",
    hover: "#fd8f78",
    muted: "rgba(251, 114, 86, 0.14)",
    secondary: "#a8735f",
    foreground: "#000000",
  },
  {
    id: "rose",
    name: "Rose",
    primary: "#f43f5e",
    hover: "#fb6f88",
    muted: "rgba(244, 63, 94, 0.14)",
    secondary: "#a86470",
    foreground: "#ffffff",
  },
];

/** Look up an accent by id, falling back to the monochrome default. */
export function getAppAccent(id: string | undefined | null): AppAccent {
  return (
    APP_ACCENTS.find((a) => a.id === id) ??
    APP_ACCENTS.find((a) => a.id === DEFAULT_APP_ACCENT_ID) ??
    APP_ACCENTS[0]
  );
}
