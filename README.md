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
  - [Agent integration (ACP)](#agent-integration-acp)
  - [State, persistence, and IPC](#state-persistence-and-ipc)
- [Project structure](#project-structure)
- [Contributing](#contributing)

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
| **Chat / Agent** | Multi-session, multi-agent chat over [ACP (Agent Client Protocol)](https://github.com/zed-industries/agent-client-protocol). First-class support for Claude Code; the same transport plugs into any other ACP-speaking agent. Stop-button, message queue, permission-mode cycling (⇧⇥), tri-state send button (send / queue / stop), per-tab session sidebar, bash-call history panel, in-chat search (⌘F). |
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
git clone https://github.com/pacifio/atlas
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
│  │  • CodeMirror, xterm,      │    │  • atlas-acp (JSON-RPC)  │  │
│  │    Tiptap, Pixi, TanStack  │    │  • atlas-agents (sessions│  │
│  │  • Tailwind v4             │    │  • atlas-terminal (PTY)  │  │
│  │                            │    │  • spawn_blocking I/O    │  │
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

- `chat/stores/chat-store.ts` — per-tab UI state (queues, draft, scroll). The authoritative session state (messages, tool calls, status) lives in Rust under `atlas-agents`; the store only mirrors deltas streamed over the `atlas:agents` event channel. See [the agent integration section](#agent-integration-acp).
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
| `agents.rs` | ACP agent lifecycle — plugin discovery, spawn/kill, new/load session, send/cancel, model + mode switching, permission responses. Stream deltas reach the frontend via `atlas:agents` Tauri events. |
| `claude.rs` | History readers — lists, reads, and deletes Claude Code session JSONL files in `~/.claude/projects/<slug>/`. Session spawn + streaming go through ACP (`agents.rs`), not this module. |
| `claude_setup.rs` | Detects / installs the Claude Code CLI on the user's PATH. |
| `terminal.rs` | PTY lifecycle (`terminal_create`, `_write`, `_resize`, `_close`) backed by the `atlas-terminal` workspace crate (`portable-pty`). |
| `fs.rs` | Directory listing, file read/write, create/rename/delete/copy/duplicate, reveal-in-Finder, open-in-terminal, gitignore appends. |
| `git.rs` + `git_graph.rs` + `git_watcher.rs` | Status, log, diff, stage/unstage, commit, branch ops, real commit-graph lane assignment, fs-watcher for live refresh. |
| `github.rs` | GitHub search via REST, repo clone via `git clone` into `<project>/.atlas/repos/`. |
| `analysis.rs` | Whole-project file/line/language counts and symbol indexing. |
| `search.rs` | Fast in-files text search. |
| `fileindex.rs` | Cmd+P file-picker index. |
| `mention_search.rs` | Unified `@`-mention search (files, folders, knowledge, symbols, repos, papers, …). |
| `research.rs` + `papers.rs` | arXiv + Semantic Scholar API calls, PDF download, saved-papers index. |
| `knowledge.rs` + `knowledge_meta.rs` + `knowledge_links.rs` + `knowledge_export.rs` | Knowledge notes CRUD, page metadata in `_meta.json`, backlinks/forward-links scanner + graph, exporters (md/html, workspace, self-contained server binary). |
| `canvas.rs` | Read/write `.atlas/canvas.json`. |
| `pomodoro.rs` | Read/write `.atlas/pomodoro.json` for the focus-timer feature. |
| `log.rs` | Append-only pinned log at `~/.atlas/log/pinned.jsonl`. |
| `app_state.rs`, `cli.rs`, `recent_files.rs`, `sessions_watch.rs`, `compose_prompt.rs` | Bootstrap, `atlas <path>` CLI helper, recent files, session JSONL watcher, prompt composition for ACP sends. |

All long-running or blocking operations (`Command::output`, `Command::spawn` + line reads, file I/O on big trees) run inside `tokio::task::spawn_blocking` so the Tauri command runtime never blocks the UI's IPC channel.

Workspace crates under `crates/` (all wired in from `src-tauri/Cargo.toml`):

- **`atlas-acp`** — ACP (Agent Client Protocol) transport. Speaks JSON-RPC to any ACP-speaking agent binary (Claude Code today, others on the way), forwards permission prompts, tool calls, and content blocks.
- **`atlas-agents`** — Per-session runtime: `AgentManager` owns the registry, one `SessionWorker` task per session owns the message log, queue, and stream subscribers. Emits `atlas:agents` deltas to the frontend.
- **`atlas-terminal`** — Wraps `portable-pty` and bridges PTY bytes to Tauri events.
- **`atlas-kb-server`** — Standalone self-contained static-server binary produced by the knowledge-base "Export server" action. Embeds the exported HTML/CSS via `include_dir!` and serves it on `localhost:4747`.

### Agent integration (ACP)

Atlas talks to agents over [ACP — the Agent Client Protocol](https://github.com/zed-industries/agent-client-protocol), the open JSON-RPC protocol that originated in Zed. Any binary that speaks ACP can plug in; the bundled default is the official `claude-code-acp` bridge in front of Anthropic's Claude Code CLI.

The integration is split across two Rust crates and one IPC surface:

**`atlas-acp`** — the transport. It spawns the agent binary, handles the JSON-RPC framing, forwards ACP method calls (`initialize`, `newSession`, `loadSession`, `prompt`, `cancel`, `setSessionMode`, `setSessionModel`, …), and surfaces permission prompts and tool-call updates back to the host.

**`atlas-agents`** — the per-session runtime that sits between ACP and the UI:

- `AgentManager` owns the global registry — which agent plugins are installed, which sessions are running, which one belongs to which UI tab.
- A `SessionWorker` task is spawned per session. It owns the canonical message log, the user's queued prompts, the run status, and the broadcast channel that fans deltas out to subscribers.
- All session state lives here, in Rust. The frontend store is a view-only mirror.

**`commands/agents.rs`** — the Tauri IPC verbs the frontend calls: `agents_list_plugins`, `agents_new_session`, `agents_load_session`, `agents_send`, `agents_cancel`, `agents_set_mode`, `agents_set_model`, `agents_respond_permission`, etc. Deltas come back over a single Tauri event channel: **`atlas:agents`**, payload-typed by `kind` (`message_appended`, `content_block_delta`, `tool_call`, `permission_request`, `status`, `error`, `done`).

Two design properties matter:

**1. The `acpSessionId` is the single source of truth.**
It is both the ACP-protocol session id used on the wire *and* the filename stem under `~/.claude/projects/<slug>/<acpSessionId>.jsonl`. The frontend never splits or rewrites it — UI tabs, history rows, and the on-disk log all key off the same string.

**2. Streams are tab-independent.**
Because `SessionWorker` owns the message log in Rust and broadcasts deltas, you can fire off three concurrent Claude Code prompts in three different tabs, switch freely between them and the history sidebar, and each one keeps streaming. Switching back to a tab just resubscribes to the worker's broadcast — no in-flight state is lost.

**History.** The history sidebar reads session JSONL files directly from `~/.claude/projects/<slug>/`. Resuming a past conversation is a `loadSession` ACP call against the same id.

**PATH resolution.** In production builds, `claude_setup.rs` resolves `claude` via a login-shell `which` because macOS GUI apps get a stripped `PATH`. Without this, the bundled `.app` can't find any user-installed CLI.

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
│   ├── atlas-acp                 ACP (Agent Client Protocol) transport
│   ├── atlas-agents              per-session runtime + AgentManager
│   ├── atlas-terminal            PTY (portable-pty)
│   └── atlas-kb-server           self-contained KB static-server binary
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
- Additional ACP agent plugins beyond Claude Code (Gemini CLI, Codex, etc.) — `atlas-acp` already speaks the wire format; mostly a matter of plugin discovery + auth flow.
- LSP support — would slot into the editor for diagnostics / go-to-definition.
- MCP server integration for tool-call extensibility.
- Theme system / additional color palettes.

