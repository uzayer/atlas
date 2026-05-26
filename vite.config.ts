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
  // Pre-bundle the heavy dependency graphs into single ESM files served as
  // one request, instead of letting Vite's dev server stream hundreds of
  // tiny `node_modules/...` modules over individual HTTP roundtrips. The
  // single biggest dev-mode startup speedup — `tauri dev` cold launch goes
  // from "8 s to open devtools" territory down to a couple of seconds
  // because the WebKit main thread isn't blocked on per-module fetches.
  // Production builds ignore this; it's purely a dev-mode optimization.
  optimizeDeps: {
    include: [
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/language",
      "@codemirror/commands",
      "@codemirror/autocomplete",
      "@codemirror/search",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
      "react-markdown",
      "remark-gfm",
      "rehype-highlight",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-popover",
      "@radix-ui/react-dialog",
      "@radix-ui/react-context-menu",
      // Pre-bundle the Tiptap stack so opening the Knowledge tab for
      // the first time doesn't trigger Vite's "new dependencies
      // optimized → reloading" cycle (which dumps editor state and
      // looks like a full app reload to the user).
      "@tiptap/core",
      // NOTE: @tiptap/pm has no root export — it's only accessed via
      // subpaths (@tiptap/pm/state, /view, etc.) which Vite picks up
      // through the dep walker automatically. Including the bare name
      // here errors with "Missing '.' specifier".
      "@tiptap/react",
      "@tiptap/starter-kit",
      "@tiptap/extension-task-list",
      "@tiptap/extension-task-item",
      "@tiptap/extension-link",
      "@tiptap/extension-placeholder",
      "@tiptap/extension-typography",
      "@tiptap/extension-highlight",
      "@tiptap/extension-underline",
      "@tiptap/extension-table",
      "@tiptap/extension-table-row",
      "@tiptap/extension-table-header",
      "@tiptap/extension-table-cell",
      "@tiptap/extension-code-block-lowlight",
      "@tiptap/extension-mention",
      "@tiptap/extension-bubble-menu",
      "@tiptap/suggestion",
      "tiptap-markdown",
      "lowlight",
    ],
  },
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
    // Pre-transform the boot critical-path the moment `tauri dev` starts the
    // Vite server. Without this, Vite transforms each user-source module on
    // first request, which on a 2400-module project shows up as a ~1.5 s
    // "html → main-eval" gap on cold launch. Warmup hits the cache so the
    // WebView's first request finds the module already transformed.
    warmup: {
      clientFiles: [
        "./src/main.tsx",
        "./src/App.tsx",
        "./src/styles/globals.css",
        "./src/features/layout/components/app-layout.tsx",
        "./src/features/layout/components/center-panel.tsx",
        "./src/features/layout/components/left-panel.tsx",
        "./src/features/layout/components/right-panel.tsx",
        "./src/features/layout/stores/layout-store.ts",
        "./src/features/project/stores/project-store.ts",
        "./src/features/project/components/welcome-screen.tsx",
        "./src/features/chat/components/chat-panel.tsx",
        "./src/features/chat/components/message-input.tsx",
        "./src/features/chat/stores/chat-store.ts",
        "./src/features/chat/lib/agents-api.ts",
        "./src/components/titlebar.tsx",
        "./src/components/command-palette.tsx",
        "./src/components/atlas-icon.tsx",
      ],
    },
  },
}));
