import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    // CRITICAL: dedupe CodeMirror + Lezer. In production the lang packages
    // (lang-json, lang-rust, …) get lazy-imported as separate chunks and
    // each transitively imports @codemirror/{state,view,language} and
    // @lezer/{common,highlight,lr}. Without dedup Rollup can ship two copies;
    // `EditorView.theme(...)` registers against copy A's StyleModule but the
    // EditorView constructor uses copy B's, so the theme silently no-ops and
    // text renders with default styling (often invisible against the dark
    // background). The dev server doesn't hit this because Vite serves
    // pre-bundled deps as a single instance.
    dedupe: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/commands",
      "@codemirror/search",
      "@codemirror/autocomplete",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
    ],
  },
  clearScreen: false,
  build: {
    // Vendor splitting so the initial chunk only holds what first paint
    // needs (React + the chat panel). Heavy panel-specific vendors live in
    // their own chunks and load on demand when the user opens a tab that
    // pulls them in.
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("@codemirror") || id.includes("@lezer")) {
            return "vendor-codemirror";
          }
          if (id.includes("@xterm") || id.includes("/xterm/") || id.includes("/xterm-")) {
            return "vendor-xterm";
          }
          if (
            id.includes("react-markdown") ||
            id.includes("remark-") ||
            id.includes("rehype-") ||
            id.includes("shiki") ||
            id.includes("highlight.js")
          ) {
            return "vendor-markdown";
          }
          if (id.includes("@radix-ui")) {
            return "vendor-radix";
          }
          if (id.includes("@tanstack")) {
            return "vendor-tanstack";
          }
          if (id.includes("@tauri-apps")) {
            return "vendor-tauri";
          }
          if (
            id.includes("/react/") ||
            id.includes("/react-dom/") ||
            id.includes("/scheduler/")
          ) {
            return "vendor-react";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
