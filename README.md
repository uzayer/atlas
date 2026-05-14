# Atlas

A native desktop second-brain for code and research — built on Tauri v2, React 19, and Rust.

Atlas wraps a code editor, a multi-session AI chat (with first-class Claude Code agent integration), a Git client with a real commit graph, a paged file explorer, a PTY terminal, a research/knowledge layer, an infinite spatial canvas for notes, and a unified activity log into one application. Everything is local-first: project state lives in `.atlas/` next to the code, global state lives in `~/.atlas/`.

> Status: pre-1.0. Targets macOS for now; Linux/Windows are reachable from the same Tauri build but untested.

---

## Table of contents

- [Why Atlas](#why-atlas)
- [Features](#features)
- [Getting started](#getting-started)
- [Architecture](#architecture)
  - [High-level layout](#high-level-layout)
  - [Frontend (React + Zustand)](#frontend-react--zustand)
  - [Backend (Tauri + Rust)](#backend-tauri--rust)
  - [The Claude Code integration](#the-claude-code-integration)
  - [State, persistence, and IPC](#state-persistence-and-ipc)
- [Project structure](#project-structure)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)

---

## Why Atlas

Most "AI IDEs" today are forks of VS Code with a chat pane bolted on. Atlas is the opposite: a small, opinionated shell that treats the AI agent and your own thinking as equal first-class citizens, alongside the editor and terminal. The goal is a tool that an individual researcher / engineer can keep open all day and trust with project context — not a hosted product, not a fork, no telemetry, no account.

Concretely:

- **The agent is plural.** Multiple Claude Code sessions run concurrently, each with its own thread history and stop button. Switching tabs never freezes a running stream.
- **State is just files.** No SQLite, no proprietary format. Chat history is JSONL on disk (read directly by Claude Code's own resume flag), notes are markdown, canvases are JSON.
- **Local-first.** Everything except outbound API calls is on your machine. There is no Atlas account or server.

---

## Features

| Area | What's there |
|------|--------------|
| **Chat / Agent** | Multi-session Claude Code with stop-button, message queue, permission-mode cycling (⇧⇥), tri-state send button (send / queue / stop), per-tab session sidebar, bash-call history panel, in-chat search (⌘F). Falls back to direct LLM API (Anthropic / OpenAI / Google) when Claude Code CLI isn't installed. |
| **Editor** | CodeMirror 6 with language support for JS/TS, Python, Rust, Go, Java, C++, JSON, YAML, Markdown, SQL, CSS, HTML, XML. Cmd+S writes to disk and emits an editor save event picked up by the log. |
| **Terminal** | xterm.js v6 + Rust `portable-pty` backend. Splits, persistent buffers, RAF-batched output, multi-attempt fit on visibility change. |
| **Git** | Real commit graph (custom SVG lane-assignment), stage/unstage/commit, branch list with checkout / create / delete, file-level diff. |
| **Explorer** | Paged file tree with lazy directory expansion. |
| **GitHub** | Search public repos, clone into a managed directory, browse cloned READMEs, delete clones. |
| **Research** | arXiv + Semantic Scholar search, PDF download, "save to knowledge base" pipeline. |
| **Knowledge** | Markdown notes with subdirectories, an interactions log appended to per-project JSONL, surfaced as system-prompt context to the chat model. |
| **Canvas (Spaces)** | Infinite ReactFlow board for spatial note-taking with edges between nodes. |
| **Log** | Global ring-buffered activity log (500 events) with pinned-rows-survive-restart, TanStack Table view, source/project filtering, per-row JSON expand. |
| **Project** | Open / close project, project picker, per-project state in `.atlas/`. |
| **Monitor** | Token-usage tracker per provider/model. |
| **Tasks** | Lightweight task list driven by agent plans. |
| **Settings** | Provider / model / API key, theme tokens, keyboard shortcuts. |

---

## Getting started

### Prerequisites

- **Node.js 20+** and a package manager (`pnpm`, `npm`, or `bun` — `bun` is the one wired into `tauri.conf.json` by default).
- **Rust toolchain** (stable). Install via [rustup](https://rustup.rs/).
- **Tauri prerequisites** for your OS. See the [Tauri prerequisites guide](https://tauri.app/start/prerequisites/). On macOS this is just Xcode Command Line Tools.
- **(Optional) Claude Code CLI** if you want the agent. Install per Anthropic's instructions and make sure `claude` is on your `PATH`.

### Install and run in dev

```bash
git clone https://github.com/<your-org>/atlas
cd atlas

# Install JS dependencies — pick one
pnpm install
# or: npm install
# or: bun install

# Start the desktop app in dev mode (hot-reload frontend, recompiles Rust on change)
npm run dev:app
```

The first Rust compile takes a few minutes; subsequent runs are seconds.

### Build a production .app

```bash
# macOS .app bundle
npm run build:app

# .app + .dmg installer
npm run build:app:dmg
```

The bundled app lands under `src-tauri/target/release/bundle/macos/Atlas.app`. The bundle augments the GUI process `PATH` at runtime (login-shell init) so `claude`, `git`, `bun`, etc. resolve the same way they do in your terminal — even though macOS otherwise strips `PATH` from GUI launches.

### Available scripts

| Script | What it does |
|--------|--------------|
| `npm run dev` | Vite dev server only (no Tauri shell). For quick frontend iteration. |
| `npm run dev:app` | Full Tauri dev — Rust backend + Vite frontend + hot-reload. |
| `npm run build` | Type-check + production Vite build to `dist/`. |
| `npm run build:app` | `.app` bundle. |
| `npm run build:app:dmg` | `.app` + `.dmg`. |
| `npm run preview` | Preview the static Vite build in a browser. |
| `npm run lint` | ESLint on `src/`. |
| `npm run format` | Prettier on `src/`. |

---

## Architecture

### High-level layout

```
┌──────────────────────────────────────────────────────────────────┐
│                         Atlas (Tauri shell)                      │
│                                                                  │
│  ┌────────────────────────────┐    ┌──────────────────────────┐  │
│  │  React 19 frontend         │    │  Rust backend            │  │
│  │  (WKWebView on macOS)      │◀──▶│  (tokio + tauri 2)       │  │
│  │                            │ IPC│                          │  │
│  │  • Zustand stores          │    │  • commands/ — IPC verbs │  │
│  │  • CodeMirror, xterm,      │    │  • atlas-terminal (PTY)  │  │
│  │    ReactFlow, TanStack     │    │  • atlas-agents          │  │
│  │  • Tailwind v4             │    │  • spawn_blocking for    │  │
│  │                            │    │    subprocess streams    │  │
│  └────────────────────────────┘    └──────────────────────────┘  │
│                                                                  │
│  Persistence:                                                    │
│  • Per-project: <project>/.atlas/ (knowledge, canvas, log,       │
│    editor state, interactions.jsonl)                             │
│  • Global:      ~/.atlas/        (pinned log, GitHub clones)     │
│  • Claude Code: ~/.claude/projects/<project-slug>/*.jsonl        │
└──────────────────────────────────────────────────────────────────┘
```

### Frontend (React + Zustand)

`src/` is organised by **feature**, not by file type. Each feature is a self-contained slice:

```
src/features/<feature>/
  components/   — React components
  stores/       — Zustand store(s) for this feature
  lib/          — Pure helpers (parsers, formatters, IPC wrappers)
```

State management uses **Zustand + Immer** with a shared `createSelectors` helper (`src/lib/create-selectors.ts`) that auto-generates `useStore.use.x()` selectors. Stores never call other stores directly; cross-feature coordination happens by reading via `getState()` at action boundaries or by listening for `window.dispatchEvent(new CustomEvent("atlas:..."))` events.

Key feature stores and their responsibilities:

- `chat/stores/chat-store.ts` — sessions per tab, queues, `runningArchive` (a parking lot for streams whose tab navigated away to a different history item — see [the agent integration section](#the-claude-code-integration)).
- `project/stores/project-store.ts` — current project, recent projects, project metadata.
- `editor/stores/editor-store.ts` — open files, dirty flags. **CodeMirror owns the document text** — the store only holds metadata so editor performance doesn't degrade with file size.
- `git/stores/git-store.ts` — branch, status, commits, lane-assigned graph.
- `terminal/stores/terminal-store.ts` — split layout. The terminal backend buffer is the source of truth for bytes, not the store.
- `layout/stores/layout-store.ts` — tab system (`addTab`, `closeTab`, dedupe rules per tab type), split sizes.
- `log/stores/log-store.ts` — ring-buffered event log (500 in memory) + on-disk pinned entries.
- `knowledge/stores/knowledge-store.ts` — notes, directories, interaction log.
- `canvas/stores/canvas-store.ts` — ReactFlow nodes + edges, persisted JSON.
- `monitor/stores/usage-store.ts` — token-usage counters per provider/model.
- `analysis/`, `browser/`, `github/`, `research/`, `settings/`, `tasks/` — their respective domains.

The layout is three columns (`src/features/layout/components/app-layout.tsx`):

```
LeftPanel        CenterPanel                RightPanel
─ Explorer       ─ Tab system               ─ Chat / Knowledge / Git
─ Knowledge      ─ Editor, Terminal,          (whichever is active)
─ Git / Search   ─ Canvas, Log, Analysis…
─ GitHub         ─ each panel lazy-loaded
```

`CenterPanel.tsx` owns the tab type registry — see `src/lib/constants.ts` for `TAB_TYPES` and the lazy-import map. Adding a new panel type is: lazy-import in `CenterPanel`, add to `TAB_TYPES`, optionally add an entry to `NEW_TAB_OPTIONS` for the `+` menu.

### Backend (Tauri + Rust)

`src-tauri/src/` is the Tauri host process. The IPC surface is one module per domain under `src-tauri/src/commands/`:

| Module | Responsibility |
|--------|----------------|
| `chat.rs` | Direct LLM call (Anthropic / OpenAI / Google) via `reqwest`. |
| `claude.rs` | Spawn the `claude` CLI as a subprocess; stream JSONL stdout back as `claude-stream` Tauri events; PID registry for stop-generation. Also reads `~/.claude/projects/.../session.jsonl` for history. |
| `terminal.rs` | PTY lifecycle (`terminal_create`, `_write`, `_resize`, `_close`) backed by the `atlas-terminal` workspace crate (`portable-pty`). |
| `fs.rs` | Directory listing, file read / write. |
| `git.rs` | Shells out to `git` for status, log, diff, stage, unstage, commit, branch ops, refs. |
| `github.rs` | GitHub search via REST, repo clone via `git clone` into `~/.atlas/clones/`. |
| `analysis.rs` | Whole-project file/line/language counts and symbol indexing. |
| `search.rs` | Fast in-files text search. |
| `research.rs` | arXiv + Semantic Scholar API calls, PDF download, paper → knowledge persistence. |
| `knowledge.rs` | Read/write `.atlas/knowledge/`, `.atlas/interactions.jsonl`, editor state, readability fetch. |
| `canvas.rs` | Read/write `.atlas/canvas.json`. |
| `log.rs` | Append-only pinned log at `~/.atlas/log/pinned.jsonl`. |

All long-running or blocking operations (`Command::output`, `Command::spawn` + line reads, file I/O on big trees) run inside `tokio::task::spawn_blocking` so the Tauri command runtime never blocks the UI's IPC channel.

There are two workspace crates under `crates/` that are imported as path dependencies from `src-tauri/Cargo.toml`:

- `atlas-terminal` — wraps `portable-pty` and bridges PTY bytes to Tauri events.
- `atlas-agents` — agent abstractions for future non-Claude-Code adapters.

The remaining `crates/` directories (`atlas-analysis`, `atlas-background`, `atlas-core`, `atlas-git`, `atlas-lsp`, `atlas-mcp`, `atlas-memory`, `atlas-monitor`, `atlas-research`) are scaffolds for an in-progress migration of logic out of the monolithic `commands/` modules. They are not currently wired in.

### The Claude Code integration

This is the most non-obvious part of the system, so it gets its own section.

Atlas does **not** use ACP (Agent Client Protocol). It invokes the public `claude` CLI directly:

```
claude --print --output-format stream-json --verbose [--resume <sid>] [--permission-mode <m>] <prompt>
```

Each invocation streams newline-delimited JSON to stdout. The Rust side spawns the process, reads stdout line by line in a blocking thread, parses each line, and re-emits it as a `claude-stream` Tauri event with payload:

```ts
{ session_id: string; event_type: "session" | "text" | "tool_use" | "tool_result" | "done" | "error"; content: string }
```

Two design decisions matter here:

**1. The `session_id` is per-send, not per-tab.**
Each call to `handleSend()` in `chat-panel.tsx` mints a fresh `streamId` like `${tabId}-${ts36}-${rand6}` and passes it as the Rust `session_id`. The Rust backend keys its PID registry by this `streamId`, so two concurrent streams in the same tab don't collide, and the stop button always targets exactly one PID. The frontend listener also filters on `streamId`, so streams can't cross-contaminate each other's assistant message.

**2. Streams survive tab navigation via a "running archive".**
When the user clicks a different history item in the session sidebar while a stream is running, `chat-store.archiveCurrent(tabId)` deep-copies the in-flight session into `runningArchive[claudeSessionId]`. The stream listener writes to whichever container currently holds its `streamId` — the tab if the user is still there, or the archive if they've moved on. When the stream finishes, the archive is dropped (the on-disk JSONL is now authoritative); when the user navigates back, `restoreArchive()` swaps it back into the tab.

The result is that you can fire off three Claude Code requests in three tabs, switch freely between them and the history list, and each one keeps streaming independently with a working stop button.

History rendering reads from `~/.claude/projects/<slug>/<session-id>.jsonl` directly, since Claude Code persists every session there. The `claude_run` command also accepts a `--resume` flag to continue prior conversations.

In production builds, `claude.rs` falls back to a login-shell `which` resolution because macOS GUI apps get a stripped `PATH` — without this, the bundled `.app` can't find any user-installed CLI.

### State, persistence, and IPC

**Per-project state** lives in `<project-root>/.atlas/`:

```
.atlas/
├── knowledge/         markdown notes + subdirectories
├── interactions.jsonl one-line summary per significant event,
│                       fed back to the chat as system-prompt context
├── canvas.json        ReactFlow node/edge state
└── editor.json        which files were open
```

**Global state** lives in `~/.atlas/`:

```
~/.atlas/
├── log/pinned.jsonl   pinned activity-log rows (survive restart)
└── clones/            repos cloned via the GitHub panel
```

**Claude Code state** lives in `~/.claude/projects/<slug>/` and is read directly by Atlas — Atlas does not mirror it.

**IPC** is purely Tauri's `invoke()` for commands and `listen()` for streams. All payloads are JSON. The frontend never touches the filesystem directly.

---

## Project structure

```
atlas/
├── src/                          React 19 frontend
│   ├── App.tsx, main.tsx         entry points
│   ├── features/                 one folder per feature (see above)
│   ├── components/               cross-feature widgets
│   ├── ui/                       shadcn-style primitives (Kbd, etc.)
│   ├── hooks/                    shared React hooks
│   ├── lib/                      utilities (cn, createSelectors, constants)
│   ├── styles/globals.css        Tailwind 4 + design tokens
│   └── types/                    shared TS types (agent.ts, etc.)
│
├── src-tauri/                    Tauri host (Rust)
│   ├── src/
│   │   ├── main.rs               binary entry
│   │   ├── lib.rs                tauri::Builder + invoke_handler
│   │   └── commands/             one .rs per IPC domain
│   ├── icons/                    bundle icons
│   ├── tauri.conf.json           bundle config, CSP, window
│   └── Cargo.toml
│
├── crates/                       Rust workspace crates
│   ├── atlas-terminal            PTY (wired in)
│   ├── atlas-agents              agent abstractions (wired in)
│   └── atlas-{core,git,lsp,...}  scaffolds for future extraction
│
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── postcss.config.js
├── LICENSE
└── README.md
```

---

## Contributing

Contributions are very welcome — Atlas is a one-person project and there's plenty of room for others to make it better.

### Ground rules

1. **Open an issue first** for anything bigger than a small fix. It's easier to align on direction before you write the code.
2. **Match the existing patterns.** Feature folder, Zustand store with `createSelectors`, Tailwind classes via `cn()`, IPC verbs in a single `commands/<domain>.rs` module. If you're adding something that doesn't fit, propose the structure in the issue.
3. **No telemetry, no analytics, no auto-update pings.** Atlas is local-first by design.
4. **No new heavy dependencies without discussion.** The current dep list is intentional.

### Local dev loop

```bash
npm run dev:app       # full app with hot reload
npm run lint          # ESLint
npm run format        # Prettier
cd src-tauri && cargo check     # quick Rust type-check
```

For UI work you can sometimes get away with `npm run dev` (Vite-only, no Tauri commands), but anything that hits `invoke()` needs `dev:app`.

### Pull request checklist

- [ ] `npx tsc --noEmit` passes
- [ ] `cd src-tauri && cargo check` passes
- [ ] You've actually run the app and used the feature in a window (not just compiled it)
- [ ] No commented-out code, no leftover `console.log` debug lines
- [ ] No new top-level dependencies unless discussed in the issue

### Areas where help is especially welcome

- Linux / Windows testing of the production bundle (terminal font, PATH resolution, GUI quirks).
- LSP support — there's an `atlas-lsp` crate scaffold waiting for an implementation.
- MCP server integration — `atlas-mcp` scaffold likewise.
- Non-Claude-Code agent adapters via the `atlas-agents` crate.
- Theme system / additional color palettes.
