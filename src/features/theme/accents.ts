/**
 * App-accent registry — Slack-style accent "tones" for the Atlas UI.
 *
 * These do NOT change the theme: the AMOLED-black surfaces, text grays and
 * borders stay put. They only re-skin the UI *accent* — the few `--accent-*`
 * custom properties (plus the primary-button foreground) that drive active-tab
 * underlines, primary buttons, focus rings, mention chips, etc.
 *
 * Applied at runtime by `apply-app-accent.ts`, exactly mirroring the editor
 * theme picker (`features/editor/themes/apply-editor-theme.ts`). Mix-and-match:
 * the app accent and the code-editor theme are independent settings.
 */
export type AppAccent = {
  id: string;
  name: string;
  /** --accent-primary — the accent color (also shadcn `--primary`). */
  primary: string;
  /** --accent-primary-hover — slightly shifted for hover states. */
  hover: string;
  /** --accent-primary-muted — low-alpha wash (chip backgrounds, hovers). */
  muted: string;
  /** --accent-secondary — dimmer companion tone. */
  secondary: string;
  /** --primary-foreground — text/icon color on a *solid* accent fill. */
  foreground: string;
};

export const DEFAULT_APP_ACCENT_ID = "monochrome";

export const APP_ACCENTS: AppAccent[] = [
  {
    // Reproduces Atlas's original monochrome accent exactly.
    id: "monochrome",
    name: "Monochrome",
    primary: "#ffffff",
    hover: "#cccccc",
    muted: "rgba(255, 255, 255, 0.06)",
    secondary: "#777777",
    foreground: "#000000",
  },
  {
    id: "yellow",
    name: "Atlas Yellow",
    primary: "#ffff00",
    hover: "#e6e600",
    muted: "rgba(255, 255, 0, 0.12)",
    secondary: "#8a8a5a",
    foreground: "#000000",
  },
  {
    id: "blue",
    name: "Blue",
    primary: "#5b9bff",
    hover: "#7cb0ff",
    muted: "rgba(91, 155, 255, 0.14)",
    secondary: "#6b7f9e",
    foreground: "#000000",
  },
  {
    id: "indigo",
    name: "Indigo",
    primary: "#818cf8",
    hover: "#99a2ff",
    muted: "rgba(129, 140, 248, 0.14)",
    secondary: "#6f74a8",
    foreground: "#000000",
  },
  {
    id: "aubergine",
    name: "Aubergine",
    primary: "#9333ea",
    hover: "#a855f7",
    muted: "rgba(147, 51, 234, 0.16)",
    secondary: "#8a6ea3",
    foreground: "#ffffff",
  },
  {
    id: "jade",
    name: "Jade",
    primary: "#34d399",
    hover: "#5ee0ac",
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
    id: "clementine",
    name: "Clementine",
    primary: "#fb923c",
    hover: "#fdad6b",
    muted: "rgba(251, 146, 60, 0.14)",
    secondary: "#a8825f",
    foreground: "#000000",
  },
  {
    id: "crimson",
    name: "Crimson",
    primary: "#f43f5e",
    hover: "#fb6f88",
    muted: "rgba(244, 63, 94, 0.14)",
    secondary: "#a86470",
    foreground: "#ffffff",
  },
  {
    id: "magenta",
    name: "Magenta",
    primary: "#ec4899",
    hover: "#f472b6",
    muted: "rgba(236, 72, 153, 0.14)",
    secondary: "#a86487",
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
