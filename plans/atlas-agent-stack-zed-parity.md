# Atlas Agent Stack — Zed-Parity Refactor Plan

**Date:** 2026-07-16 · **Branch baseline:** `0.2.1` · **Status:** PROPOSED (awaiting approval)

**Goal:** Bring the Atlas agent stack (native Cersei, Claude via ACP, Codex via ACP) up to
Zed's level of backend polish — reliability first, UI second. Atlas-unique features are
preserved and integrated into the improved architecture, not removed.

**Evidence base:** six parallel deep-dive audits (2026-07-16, fresh-eyes, no prior-audit
assumptions): Zed session-lifecycle/protocol-edges, Zed streaming/state-management, Zed
cancellation/error-retry/tool-plumbing; Atlas core seam map, Atlas reliability audit, Atlas
feature inventories (memory/RAG, skills/packs, everything else). Every claim below was
verified against source with file:line citations at audit time.

---

## 1. The verdict in one paragraph

Atlas's *architecture* is already Zed-shaped: both are clients of `agent-client-protocol`,
both run a protocol-agnostic connection seam (`AgentConnection` / `AgentBackend`) with a
native in-process agent and external ACP subprocess agents behind it, and Atlas's
`SessionActor` (single FIFO, TurnId, quiescence-gated finalize, panic supervisor) is a sound
single-owner design with real tests. **The gap is not structure — it is roughly a dozen
reliability mechanisms Zed has beneath the structure**: turn-tagged events, awaited
cancellation with settled tool results, retry with error classification, RPC timeouts,
crash→rebind recovery, and history that survives failure. Plus one regression: the streaming
UTF-8 fix fell out of the build.

---

## 2. Zed reference model (what we're porting)

Condensed to the mechanisms that matter. Citations are into `~/Codes/zed`.

### 2.1 Turn identity & supersede
- Every prompt bumps a monotonic `turn_id`; the completion handler checks `is_same_turn`
  before touching status/entries, so a superseded turn's completion can't clobber the new
  turn (`acp_thread.rs:3724-3770`).
- **A new prompt first awaits `cancel()` of the running turn** before sending
  (`acp_thread.rs:3733-3741`). Two prompts can never be in flight for one session.

### 2.2 Cancellation that is a fact, not a promise
- `AcpThread::cancel` flushes partial text, flips every Pending/WaitingForConfirmation/
  InProgress tool call to `Canceled` synchronously, notifies the backend, then **returns the
  old turn's task so callers can await actual completion** (`acp_thread.rs:3891-3904`).
- Native loop: cancellation is an explicit `watch::channel(false)` raced in the turn loop
  against stream events and tool completions (`agent/thread.rs:2801-2835`); on cancel it
  still **drains in-flight tool results**, and `flush_pending_message` synthesizes a
  sentinel `"Tool canceled by user"` result for every orphaned `tool_use`
  (`thread.rs:3889-3923`) — **history stays provider-valid for the next turn**.
- Terminal tool: `select!` over exit/timeout/cancel; on cancel it kills **and re-awaits
  exit**, then returns a real partial result (`tools/terminal_tool.rs:894-938`).
- Post-cancel ACP updates are tolerated and reconciled twice: optimistically at cancel time
  and definitively when `StopReason::Cancelled` lands. `suppress_abort_err` (consumed once
  per prompt) rewrites agent-specific abort errors into a clean `Cancelled` response
  (`agent_servers/acp.rs:1944-1999`).

### 2.3 Retry & error classification (native)
- `retry_strategy_for` (`agent/thread.rs:4371-4474`): 429 → exponential backoff (4
  attempts); overloaded/529/503 → fixed delay (4); 500/read/deserialize → 3; unknown → 2;
  **never** retried: 401/403/413, auth, permission, no-key, prompt-too-large.
- `MAX_RETRY_ATTEMPTS=4`, `BASE_RETRY_DELAY=5s`, delay = `initial * 2^(attempt-1)`;
  backoff timer races the cancel flag. `RetryStatus {last_error, attempt, max_attempts,
  started_at, duration}` is emitted to the UI as a countdown (`thread.rs:3031-3055`).
- **Resume-not-replay:** on retry the loop continues with a `Message::Resume` marker;
  nothing is truncated; a successful tool round resets `attempt=0` (`thread.rs:2989-3022`).
- Errors end turns without losing history: entries are never truncated on error (only on
  user-prompt refusal); partial output is flushed and committed (`acp_thread.rs:3772-3885`).
- ACP subprocess agents get **no client-side retry** — the client trusts the agent process;
  process-level problems surface as `LoadError::{Exited{status,stderr},
  FailedToInstall, Unsupported, Other}`, distinct from turn errors.

### 2.4 Session lifecycle & crash handling
- Handshake races connection-handle and initialize against child-exit with a 250ms grace to
  prefer a stderr-bearing `LoadError::Exited` (`agent_servers/acp.rs:938-1002`).
- Sessions are ref-counted with a shared pending-load task (dedup concurrent opens;
  close-during-load is well-defined) (`acp.rs:1147-1282, 1798-1862`).
- Replay = ordinary notification path: the thread is registered in the session map **before**
  awaiting `session/load` so streamed replay notifications land (`acp.rs:1209-1223`).
- Both transport directions are tapped into a 2000-entry debug ring buffer; its stderr tail
  feeds exit errors (`acp.rs:152-231`).
- Child killed in `Drop`; no auto-restart — `LoadError` goes to every live session and the
  connection registry owns reconnection (remove entry → next request reconnects)
  (`acp.rs:1509-1515`, `agent_connection_store.rs:127-141`).

### 2.5 Streaming & ordering
- One serialized dispatch queue per connection: wire handlers only enqueue; a single
  foreground task drains strictly in order — per-session ordering equals wire ordering
  (`acp.rs:657-693, 963-970`).
- Adaptive typewriter: 16ms tick, reveal rate recomputed to drain the backlog in 200ms,
  UTF-8-safe boundaries; flushed at every entry push/turn end/error/cancel
  (`acp_thread.rs:2108-2132, 2899-2987`).
- Partial streamed content is **committed, never discarded**, on error and cancel.
- Optimistic user message + echo dedup (`is_optimistic` + chunk containment + message-id
  merge) (`acp_thread.rs:2544-2574`).

### 2.6 Protocol edge cases
- Unknown session: notifications → warn + drop; requests → descriptive error.
- `tool_call` for existing id = merge; `tool_call_update` for unknown id = visible "Tool
  call not found" Failed placeholder — never crash, never silently drop
  (`acp_thread.rs:3113-3141, 3189-3247`).
- Dropped permission oneshot ⇒ `RequestPermissionOutcome::Cancelled` — any abandoned wait
  resolves the agent's request correctly (`acp_thread.rs:3372-3409`).
- MaxTokens → turn error; Refusal → truncate only if the *user prompt* was refused;
  capability checks at every call site with typed "not supported" errors.

### 2.7 Tool plumbing (client-served)
- Zed serves `fs/read_text_file` + `fs/write_text_file` **through open buffers** (dirty
  edits included); writes are diffed and applied as undoable buffer edits, format-on-save
  runs, then save — agent edits appear in the review diff (`acp.rs:4181-4353`).
- `action_log` tracks agent edits per buffer with keep/reject review, and **stale-read
  enforcement**: buffer-version + disk-mtime checks; a failed old_text match errors back to
  the model with "read the file again" (`action_log.rs`, `tools/edit_session.rs:943-1026`).
- Permission rules engine: Deny > Confirm > Allow(all-subcommands) > default; shell inputs
  split into sub-commands; parse failure disables allow-listing (`tool_permissions.rs`).

### 2.8 Features riding on the above
- **Git checkpoints**: snapshot attached to each user message before prompt; "restore"
  appears only if the tree actually changed; restore = cancel → rewind (truncate remote,
  then local, reject unreviewed edits, kill orphaned terminals) → git restore
  (`acp_thread.rs:3678-3691, 3952-4029`).
- **Queued messages + steering** while a turn runs (drain on `Stopped`; steer =
  end-turn-at-next-boundary), **message edit & resend** (truncate-then-send), drafts
  persisted per session.

---

## 3. Atlas audit — ranked findings

Fresh-eyes audit of `crates/atlas-{bus,acp,agentkit,cersei,agents}`,
`src-tauri/src/commands/agents.rs`, `src/features/chat/stores/chat-store.ts`, vendor/.
Paths affected: **N** = native cersei, **C** = Claude ACP, **X** = Codex ACP.

### CRITICAL
- **C1 [N] — UTF-8 SSE fix regressed out of the build.** `src-tauri/Cargo.toml:145`: cersei
  crates come from crates.io (0.2.6), no `[patch.crates-io]`; `vendor/cersei-agent/` holds
  only a `target/` dir. Published `cersei-provider-0.2.6` does
  `String::from_utf8_lossy(&bytes)` on raw chunks in **all three** decoders
  (`anthropic.rs:221`, `openai.rs:331`, `gemini.rs:342`). Any multi-byte char split across
  an HTTP chunk boundary becomes U+FFFD — corrupts streamed text **and tool-call JSON
  arguments** (the historical file-corruption class). *(Verified directly this session.)*
- **C2 [N,C,X] — Supersede doesn't stop the old turn; two live turns interleave; native
  history silently lost.** `actor.rs:239-302` bumps TurnId and drops the stale `TurnDone`,
  but never cancels the old prompt future; `ActorMsg::Acp` events carry **no TurnId**
  (`actor.rs:70-86`) so a superseded turn's deltas land in the new turn's transcript.
  Native: concurrent `send_prompt`s each clone history (`atlas-cersei/lib.rs:398`) and the
  last finisher wins `*entry.history.lock() = msgs` + save (`lib.rs:575-587`) — the other
  turn's messages vanish. Easy to trigger: Stop flips the UI idle optimistically
  (`chat-panel.tsx:421-444`), so the user can re-send while the old turn winds down.

### HIGH
- **H1 [N] — Native cancel is neither prompt nor guaranteed.** cersei-agent 0.2.6 checks
  the cancel token only between loop turns (`runner.rs:254`) and during provider streaming
  (`runner.rs:400`); `tool.execute().await` (`runner.rs:690-692`) is not raced against the
  token — a running Bash/edit completes **after** Stop. Lost-cancel window: `send_prompt`
  resets `cancelled=false` at `lib.rs:381` and installs the token only at `lib.rs:411`;
  a cancel landing in that window is erased or finds no token, and the turn runs to
  completion merely relabeled "cancelled" (`lib.rs:547-549`).
- **H2 [N,C,X] — Zero retry, zero error classification.** No retry/backoff anywhere in
  atlas-agents/acp/cersei; `AcpError` (`atlas-acp/error.rs:5-23`) has no
  transient/permanent taxonomy; everything flattens to one `TurnFailed`. No 401→auth-flow
  mapping. (Only the anthropic provider has SDK-internal `max_retries: 5`; openai/gemini
  have none.)
- **H3 [C,X] — SetMode/SetModel can wedge the session actor; no RPC timeouts.**
  `actor.rs:201-221` awaits `modes.set()` / `sel.select()` inline in the control loop —
  while pending, the actor processes **no Cancel and no stream events**. No ACP RPC has a
  timeout (`registry.rs:199-374`). A wedged adapter freezes the session permanently; a
  wedged `session/prompt` leaves the turn live forever (no cancel deadline exists;
  `FINALIZE_BACKSTOP` only covers tools after the prompt resolved).
- **H4 [C,X] — Crash recovery is manual and resets the wrong cache.** On
  `AgentDisconnected` the manager synthesizes `TurnFailed` and removes all sessions
  (`manager.rs:508-566`) — good hygiene — but the frontend (`App.tsx:710-727`) calls
  `resetDefaultAgent()` which resets only **claude-code-ts**; a crashed Codex adapter stays
  in `cachedAgents` → every Codex bind reuses the dead agent_id → `UnknownAgent` until app
  restart. No `agent_disconnected` case in the chat-store reducer, so sessions keep stale
  `acpAgentId`/`acpSessionId`.
- **H5 [C,X] — Post-cancel gate is per-session, not per-turn.** `driver.rs:37-46`:
  `turn_epoch` exists but is dead; only the `cancelled` flag gates. Rapid Stop + new Send
  clears the guard (`actor.rs:269` `mark_turn_started`) and late frames from the cancelled
  turn pass the gate into the new turn.
- **H6 [N,C,X] — Stale permission response strands the session in "running".**
  `actor.rs:180-199`: `RespondPermission` swallows errors and emits `Status: Running`
  **unconditionally**. Permission modal outstanding at turn end (never swept — M3) +
  user clicks Allow → Running emitted with the finished turn's seq → permanent spinner.

### MEDIUM
- **M1 [N]** — Failed turn lost entirely: on `TurnStep::Failed`, return happens **before**
  history write + save (`lib.rs:536-543` vs `575-587`); the user message and partial output
  are gone from context and disk. (Claude persists via adapter JSONL; Codex engine-side —
  the three paths silently diverge on what survives failure.)
- **M2 [N]** — Non-atomic session persistence (`store.rs:125` direct `fs::write`, no
  tmp+rename); corrupted JSON silently loads as **empty** (`store.rs:134-137`).
- **M3 [N,C,X]** — Pending permissions never swept at turn end (`actor.rs:363-408`
  finalize doesn't touch them; registry removes only on respond/cancel/kill).
- **M4** — `AcpEvent::TurnFailed` has **no producer**; `pending_turn_error`
  (`session.rs:159-163`) can never be set — dead machinery implying an out-of-band-error
  guarantee no path exercises.
- **M5** — Disconnect fan-out bypasses the actor FIFO (`manager.rs:538-563` emits directly
  from the driver task) — the one ordering hole; terminal deltas can overtake content.
- **M6** — `drop_session` has zero callers (`registry.rs:277-284` documents cleanup that
  never happens); SessionGuards leak for the process lifetime.
- **M7** — App quit doesn't tear down agents (`lib.rs:535-541` RunEvent::Exit only runs the
  updater); SDK `ChildGuard::drop` doesn't run on `process::exit` — wedged adapters orphan.
- **M8** — `spawn.rs:47-83` login-shell resolver leaks a thread+child on 5s timeout, once
  per spawn; `spawn.rs:296-321` mutates env from a background thread post-boot (racy).

### LOW
- **L1** — Late tool_call after idle swept to **Completed** (`actor.rs:318-323`) — should
  be Canceled/Failed for truthfulness.
- **L2** — Cancel result swallowed (`actor.rs:178` `let _ =`) — Stop can silently no-op.
- **L3** — Delegate provider factory `.expect()` panics (`lib.rs:427-431`) — recoverable
  build error becomes whole-turn abort (caught by supervisor, but still).
- **L4** — Broadcast bus (cap 1024) drops for lagging subscribers with no log/metric.
- **L5** — `agents_send` unknown-session fallback produces two different error shapes.

### Already sound — do NOT rebuild
Single-owner `SessionActor` (FIFO + biased control + TurnId stale-terminal guard, tested);
tool-quiescence-gated finalize + `FINALIZE_BACKSTOP`; prompt-task panic supervisor;
`AgentDisconnected` → synthesized `TurnFailed` for busy sessions; `SessionGuard` late-
notification gating + pending-permission oneshot-drop ⇒ Cancelled; spawn forensics
(join-handle error recovery, ENOENT explanations, managed-node preference, shell_quote);
stop-reason tokens pinned by tests; `turn_seq` stamping on terminals + frontend stale-turn
rejection + defensive tool sweep; non-blocking outbound pipeline (bus → window emit first,
memory/telemetry off the hot path); Codex resume rollback + idempotent load caching.

---

## 4. Atlas-unique features — the preserve list

Nothing below may regress. Each item names its coupling into the agent stack; the refactor
must re-attach every coupling to whatever the improved core exposes.

| # | Feature | Coupling into the agent stack | Refactor risk |
|---|---------|-------------------------------|---------------|
| P1 | **Memory/RAG push injection** | `agents_send` prepends working-memory block + RAG index block + first-send bootstrap under an 8s budget; gated by `MemorySharingState`; bare-send fallback on miss/disabled (`commands/agents.rs:348-492`) | HIGH — silent no-op degradation if accessors move |
| P2 | **Memory ingest/extract/reindex** | `MemoryIngestMiddleware` on the delta sink: every delta → `memory_delta::ingest`; `TurnFinished` → extract job (env-gated) + `enqueue_index` nudge (`agents.rs:130-197`) | HIGH — hooks the turn lifecycle directly |
| P3 | **`search_memory` pull tool** | `register_memory_search` closure at startup; frozen `MemDoc` seam (`atlas-cersei/memory.rs:32`) | MED |
| P4 | **Skills/packs/rules/hooks** | Two live paths: native `AtlasSkillTool` (tool name **"Skill"** is load-bearing for cersei's auto system-prompt guidance; reads `.atlas/agent-skills` only) and `#`-mention `compose_prompt` inline blocks for ALL agents; disk-is-state symlink projection + two ledgers | HIGH — dual-path, per-agent gating from projection ledgers |
| P5 | **Mention rail / compose_prompt** | Frontend composes `# Atlas context` block (files/symbols/knowledge/skills/components/papers/branches) before `agents_send` — distinct from P1 | MED |
| P6 | **Plans capture** | ExitPlanMode permission payload → `capturePlanIfPresent` → `plans_append`; native TodoWrite → `PlanUpdated` delta (live plan cards) | MED — rides the permission flow |
| P7 | **Delegate sub-agents (native)** | `DelegateTool` in main-turn toolset; provider/toolset factories; children get `atlas_coding` only, no Skill/memory/MCP, depth-capped | MED |
| P8 | **BYOK** | `byok-keys.json` read directly by the cersei crate (bypasses commands); review.rs also calls `byok_get` Rust-side | MED — file contract |
| P9 | **MCP bridge (native)** | `mcp-servers.json` → cersei MCP proxy tools, cached per app session. Config UI is dead-to-UI (decide: wire or drop commands; keep file contract) | LOW |
| P10 | **Code review** | Own Cersei-SDK runtime + own `atlas:review` channel; `atlas_review::complete()` consumed by codebase_index; needs explicit `.model()` | MED |
| P11 | **Canvas AI + Model-Chat riders** | Canvas calls `memory_chat_retrieve` + `modelchat_stream`; commit-flow message-gen and review model list also ride Model-Chat | MED |
| P12 | **Knowledge base** | Pull-only: `MentionSpec::Knowledge` inlining; agent runtime never touches `.atlas/knowledge/` | LOW |
| P13 | **Chat UX on SessionDelta** | context gauge (`context_usage`), usage/cost pill, compaction display, turn-summary cards (tool upserts bracketed by status/turn_finished), next-step chips (prompt directive + parse on finish), commit flow | HIGH — exact variant names/fields |
| P14 | **Session sidebar / resume** | Claude JSONL watcher (`atlas:sessions-changed`) + poll-refresh for Codex/Cersei; resume via `agents_load_session` + snapshot hydration (byte-identical two paths) | MED |
| P15 | **Auth flows** | `agents_run_auth_method` streaming `atlas:auth-run:progress/done`; Codex `agents_authenticate`; setup gates (claude_setup, node_setup) | MED |
| P16 | **Editor reconciliation** | fs-watcher based (`atlas:explorer:changed`, `atlas:git-changed`); dirty-buffer "Disk changed · Reload" banner; agents write disk directly (no ACP fs capabilities advertised — `driver.rs:406` `ClientCapabilities::default()`) | MED — watchers must keep firing on agent writes |

**Wire contracts frozen unless a phase explicitly versions them:** `SessionDelta` /
`SessionDeltaEnvelope` JSON (kind-tagged, snake_case, 18 variants) on the single
`atlas:agents` channel; `AcpEvent`/`EventSink`; `AgentBackend` op set + snake_case
stop-reason tokens; `turn_seq` monotonicity; config-dir file contracts (`byok-keys.json`,
`cersei-sessions/`, `mcp-servers.json`, `.atlas/plans.json`, `.atlas/agent-skills`).
New delta variants must be **additive** (frontend reducer ignores unknown kinds).

**Confirmed absent (gap vs Zed, nothing to lose):** checkpoints/rewind — no turn↔git
coupling exists anywhere in Atlas today.

---

## 5. Refactor plan — ordered by impact, backend-first

Each phase is independently shippable, ends green (`cargo check/clippy/test` on all agent
crates + `tsc`), and ends with the **three-path verification matrix** (§6). Phases 0–3 fix
"the app lies to you"; 4–5 fix "the app gives up"; 6–7 fix "the app forgets"; 8 is
feature parity, opt-in after reliability.

### Phase 0 — Restore streaming integrity (C1) — smallest, most urgent
1. Vendor `cersei-provider` 0.2.6 source into `vendor/cersei-provider/` and add
   `[patch.crates-io]`; replace `from_utf8_lossy` in all three decoders with an
   incremental UTF-8 decoder that carries partial bytes across chunks. (Alternative:
   upstream the fix and pin the released version — do the vendor patch now, upstream in
   parallel.)
2. Regression test: feed a stream whose chunk boundary splits a multi-byte char (CJK,
   emoji) through each decoder; assert lossless output. Add a CI-visible guard that fails
   if `Cargo.lock` resolves cersei-provider without the patch (e.g., a build-script or
   test asserting the patched marker symbol), so this cannot silently regress a third time.
- **Files:** `vendor/cersei-provider/*`, `src-tauri/Cargo.toml`, `Cargo.lock`.
- **Verify:** native streaming with emoji/CJK-heavy output; tool calls writing files with
  multi-byte content.

### Phase 1 — Turn identity end-to-end (C2, H5, L1)
The single highest-leverage structural change: **every event knows its producing turn, and
supersede awaits cancellation** (Zed §2.1).
1. Tag events with turn identity: add `turn: TurnId` (or epoch) to `ActorMsg::Acp` and
   stamp it at the emission source — driver stamps per-session current epoch
   (`driver.rs`: make the existing dead `turn_epoch` live, incremented on prompt start,
   gate **per-turn** not per-session); `CerseiRuntime::send_prompt` stamps its own turn id
   on every translated event.
2. `SessionActor`: drop any `ActorMsg::Acp` whose turn ≠ live turn (superseded or
   cancelled) — same policy as the existing stale-`TurnDone` drop. Late tool events for a
   dead turn sweep to **Canceled**, not Completed (fixes L1).
3. Supersede = cancel-then-send: `start_turn` on a busy session first runs the full cancel
   path (Phase 2's awaited cancel) and only then dispatches the new prompt. The actor
   queues the incoming Send meanwhile (control channel already FIFO); UI keeps showing
   "stopping…" until the old turn's terminal lands (chat-store: don't flip idle
   optimistically on Stop — flip on the terminal delta; see Phase 2.5).
4. Native double-turn hole: `CerseiRuntime::send_prompt` rejects/queues a second concurrent
   prompt per session (busy flag on `SessionEntry`) so history clone/write races (C2's
   data-loss) become impossible even if a caller misbehaves.
- **Files:** `atlas-acp/src/driver.rs`, `atlas-agents/src/actor.rs`,
  `atlas-cersei/src/lib.rs`, `atlas-agents/src/events.rs` (internal msg only — **no wire
  change**), `chat-store.ts` (stop-button state only).
- **Tests:** actor unit tests — late event from old turn dropped; supersede while tools
  in flight; cancelled-turn straggler after immediate re-send (the H5 scenario).

### Phase 2 — Truthful cancellation (H1, H6, M3, L2)
Port Zed's cancel contract (§2.2): cancel is awaited, tools settle, history stays valid.
1. **Native token race (H1b):** install the cancel token in `SessionEntry` *before* any
   await in `send_prompt` and make the reset-and-install atomic (one lock scope); a cancel
   arriving at any point after `agents_cancel` returns must interrupt the turn.
2. **Native tool cancellation (H1a):** vendor `cersei-agent` (same `[patch.crates-io]`
   mechanism as Phase 0) and race `tool.execute()` against the cancel token in
   `runner.rs`; on cancellation, synthesize paired cancelled `ToolResult`s for orphaned
   `tool_use` blocks (Zed's sentinel pattern, §2.2) so provider history stays valid.
   Bash tool: kill child process group, await exit, return partial output as a real result.
3. **Awaited cancel with deadline:** `SessionActor` cancel path waits for the turn's
   terminal with a `CANCEL_GRACE` deadline (5s); on expiry, force-finalize the turn
   (synthesize `TurnFinished{stop_reason: cancelled}`), sweep tools to Canceled, and for
   ACP mark the session epoch so any later frames from that turn are dropped (Phase 1
   makes this safe). Log — don't swallow — cancel RPC errors (L2).
4. **Permission hygiene:** finalize sweeps pending permissions — resolve outstanding
   permission requests as `Cancelled` (registry + native), emit `PermissionResolved`,
   and clear frontend modals on any terminal. `RespondPermission` becomes turn-aware:
   a response for a non-live turn is dropped with a log, and `Status: Running` is only
   emitted when the respond actually applied to the live turn (fixes H6, M3).
5. **Frontend truthfulness:** Stop button → "stopping…" state; idle only on the terminal
   delta. Since Phase 2 gives a bounded cancel (grace deadline), the UI is never stuck.
- **Files:** `atlas-cersei/src/lib.rs`, `vendor/cersei-agent/*`, `atlas-agents/src/actor.rs`,
  `atlas-acp/src/registry.rs`, `chat-store.ts`, `chat-panel.tsx`, `permission-modal.tsx`.
- **Tests:** cancel during tool exec (native) — no writes land after terminal; cancel
  during provider stream; cancel with modal open; wedged-adapter force-finalize at 5s;
  double-Stop idempotent.

### Phase 3 — Actor liveness: timeouts on every RPC (H3)
1. Wrap every ACP RPC in `registry.rs` with a timeout (`new_session`/`load_session`/
   `authenticate`: 30s; `set_mode`/`set_config_option`: 10s; `prompt` excluded — governed
   by cancel machinery). Timeout → typed `AcpError::Timeout` (feeds Phase 4 taxonomy).
2. Move `SetMode`/`SetModel`/`SetEffort` off the actor's inline control path: spawn the RPC,
   apply **optimistic update with rollback on error** (Zed §2.4 pattern for
   modes/config-options), deliver the result back through the actor's stream channel so
   state mutation stays single-owner. The control loop must never block on the network —
   Cancel is never starved again.
- **Files:** `atlas-acp/src/registry.rs`, `atlas-agents/src/actor.rs`,
  `atlas-agents/src/backend.rs`.
- **Tests:** actor test with a never-resolving `SessionModes::set` — Cancel still
  processed; mode rollback on RPC error reflected in `ModeChanged` deltas.

### Phase 4 — Error classification + retry (H2)
Port Zed's taxonomy and native retry (§2.3); ACP paths get classification + display, not
client-side in-turn retry (matching Zed).
1. New error taxonomy in `atlas-acp/src/error.rs` + a shared classifier:
   `Transient{retry_after}` (429/529/503/overloaded/timeout/read/deserialize) ·
   `Auth` (401/403, provider auth failures) · `Fatal` (400/413/prompt-too-large/no-key) ·
   `ProcessDead` (adapter exit). Map cersei provider errors and ACP RPC errors into it.
2. Native retry loop in `CerseiRuntime::send_prompt` (or vendored runner): Zed's table —
   max 4 attempts, `5s * 2^(n-1)` exponential for 429, fixed `retry_after||5s` for
   overloaded, 3 for 5xx/stream errors, none for Auth/Fatal; backoff races the cancel
   token; **resume-not-replay** (keep accumulated history; continue). Reset attempts on a
   successful tool round.
3. New **additive** `SessionDelta::RetryStatus {attempt, max_attempts, delay_ms,
   last_error}`; frontend renders a countdown pill (chat-store + a small component).
4. `Auth` errors → `TurnFailed{kind: auth}` and frontend routes to the existing auth flow
   (P15) for that agent instead of a generic red banner.
5. ACP: classify prompt errors for display; `ProcessDead` becomes the Phase-5 disconnect
   path, never a bare turn error.
- **Files:** `atlas-acp/src/error.rs`, `atlas-cersei/src/lib.rs` (+vendored runner),
  `atlas-agents/src/{events,apply,actor}.rs`, `chat-store.ts`, chat components.
- **Tests:** classifier table-driven tests; injected 429 stream → retry → success with
  history intact; auth error → no retry + auth-flow signal; cancel during backoff.

### Phase 5 — Process resilience (H4, M6, M7, M8)
1. **Correct crash rebind (H4):** the `AgentDisconnected` envelope carries `agent_id` →
   frontend resets the spawn cache **for that plugin** (`resetAgent(pluginId)`), adds an
   `agent_disconnected` reducer case clearing stale `acpAgentId`/`acpSessionId` on affected
   chat sessions, and shows a "restart agent" affordance. Next send lazily respawns +
   `load_session`-resumes where the transcript kind supports it (Claude JSONL, Codex
   engine-side). No silent auto-restart loops (Zed's policy, §2.4).
2. Enrich the disconnect: manager includes exit status + trailing stderr (tap stderr into a
   small ring buffer at spawn, Zed §2.4) in the `AgentDisconnected`/`TurnFailed` payload so
   the user sees *why* it died.
3. **Quit sweep (M7):** on `RunEvent::ExitRequested/Exit`, `AgentRegistry::kill_all()` +
   cersei cancel-all with a 2s bound before exit.
4. **Session teardown (M6):** wire `drop_session` — frontend session close/project switch
   calls a new `agents_drop_session`; manager drops the actor + registry guard. Fixes the
   guard leak and makes the documented late-traffic gating real.
5. **Spawn hygiene (M8):** login-shell PATH resolution moves to a once-per-app cached
   lookup with owned timeout (kill the probe child on timeout); stop mutating process env
   from background threads — pass env per-Command instead.
- **Files:** `atlas-agents/src/manager.rs`, `atlas-acp/src/{registry,spawn}.rs`,
  `src-tauri/src/lib.rs`, `src-tauri/src/commands/agents.rs`, `agents-api.ts`,
  `chat-store.ts`, `App.tsx`.
- **Tests:** kill -9 the adapter mid-turn (each of C/X): busy session gets TurnFailed with
  stderr, sidebar intact, next send respawns and resumes; app quit leaves no orphan node
  processes (`pgrep`).

### Phase 6 — History integrity (M1, M2)
1. **Persist failed turns (M1):** on `TurnStep::Failed`, write history (user message +
   partial assistant + settled tool results) and save *before* returning the error; record
   `turn_error` on the session meta so resume shows the failed turn. With Phase 2's
   sentinel settlement, saved history is always provider-valid.
2. **Atomic persistence (M2):** `store::save` → tmp file + fsync + rename. On load-parse
   failure: back up the corrupt file (`.corrupt-<ts>`), surface a
   `TurnFailed`-style notice ("session damaged, started fresh"), never silently empty.
3. **Incremental native saves:** save at message boundaries during the turn (post-assistant
   flush, post-tool-round), not only at turn end — matches Claude JSONL crash behavior so
   all three paths survive an app crash mid-turn equivalently.
- **Files:** `atlas-cersei/src/{lib,store}.rs`.
- **Tests:** failed turn survives reload with error marker; kill app mid-turn → partial
  history present; corrupt file → backed up + surfaced.

### Phase 7 — Consistency & dead-code cleanup (M4, M5, L3, L4, L5)
1. **M4:** make `AcpEvent::TurnFailed` real — driver emits it for out-of-band failures
   (transport errors mid-turn), or delete the `pending_turn_error` machinery. Decide by
   Phase 4's taxonomy needs (likely: keep and produce from the disconnect/timeout paths).
2. **M5:** route disconnect fan-out through each session's actor FIFO (send a control
   `Disconnect` message) instead of emitting from the driver task — closes the last
   ordering hole.
3. **L3:** delegate factory returns `Result` → tool error, not panic. **L4:** log+count bus
   lag drops. **L5:** unify unknown-session error shape in `agents_send`.
4. Re-audit the frozen contracts (§4) — one pass over `chat-store.ts` reducer vs
   `events.rs` to confirm variant parity including the new `RetryStatus`.
- **Files:** `atlas-acp/src/driver.rs`, `atlas-agents/src/{manager,actor}.rs`,
  `atlas-cersei/src/lib.rs`, `atlas-bus/src/bus.rs`, `commands/agents.rs`.

### Phase 8 — Zed-parity features (opt-in, after 0–7 are verified)
Ordered by user value; each is its own mini-plan when picked up:
1. **Checkpoints/rewind:** git snapshot attached per user message (Zed §2.8 —
   `git stash create`-style ephemeral commit, show "restore" only when the tree changed);
   restore = cancel → truncate (native supports truncate; ACP agents lack it — restore
   working tree only + start a fresh turn) → git restore. Atlas has zero existing
   turn↔git coupling, so this is greenfield; integrate with turn-summary cards (P13).
2. **Queued messages + steering:** UI-side queue draining on terminal delta (Zed keeps
   this out of the thread model — copy that); steer = native end-turn-at-next-boundary.
3. **Message edit & resend** (truncate-then-send; native-only where truncate exists).
4. **Adaptive streaming smoothing:** Rust-side 16ms/200ms typewriter buffering before
   `atlas:agents` emission (frontend RAF batching already exists; measure first).
5. **MCP config UI** (P9 decision) and dead-to-UI command cleanup.

---

## 6. Verification protocol (every phase)

**Gates:** `cargo check` + `clippy` + `cargo test -p atlas-acp -p atlas-agents
-p atlas-cersei -p atlas-agentkit -p atlas-bus` + `tsc --noEmit`. Gates are necessary,
not sufficient — each phase also runs the live matrix below in the running app, because
green gates have repeatedly mispredicted live behavior in this codebase (webview dialog
primitives, event timing).

**Three-path matrix** (native cersei · Claude ACP · Codex ACP — behavior must be
indistinguishable from the user's perspective):

| Scenario | Expected (all three paths) |
|----------|---------------------------|
| Send → stream → finish | ordered deltas, turn_finished with usage; multi-byte text lossless |
| Stop mid-text | "stopping…" → terminal ≤5s; partial text kept; no post-stop mutations |
| Stop mid-tool (file write / bash) | tool settles as Canceled; **no writes land after terminal**; history valid for next turn |
| Send while running | old turn cancelled+awaited, then new turn; no interleaved deltas; no history loss |
| Permission allow/deny | resolves; Running only while actually live |
| Stop with modal open | modal cleared, permission resolved Cancelled, no stuck spinner |
| Adapter/provider transient error | classified; native retries with countdown; history intact |
| Auth error | routed to auth flow, not generic banner |
| Kill agent process mid-turn | TurnFailed with stderr; rebind + resume on next send (C/X) |
| App quit mid-turn | no orphan processes; native partial history survives reload |
| Resume session | transcript byte-identical to sidebar hydration path |
| Mode/model switch during idle + during turn | applied or rolled back; Cancel never starved |

**Feature-preservation spot checks each phase:** memory injection block present on send
(P1); TurnFinished still triggers ingest/reindex (P2); `#skill:` mention inlines (P4);
plan captured from ExitPlanMode (P6); turn-summary card + commit flow (P13); review run
completes (P10).

---

## 7. Explicit non-goals
- No rewrite of the actor/manager/backend seam — the architecture stays.
- No wire-contract breaks: `SessionDelta` changes are additive only.
- No removal of any §4 feature; MCP-UI decision deferred to Phase 8.
- No auto-restart loops for crashed agents (match Zed: surface, rebind on demand).
