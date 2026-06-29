# Blueprint — Atlas Native Agent RAG/Memory Replan (Hybrid)

> **Objective:** Replan and rebuild the RAG/memory system for Atlas's native agent
> (`crates/atlas-cersei`) on a Hybrid architecture: keep **on-device MiniLM** as the
> default embedder, adopt the **Cersei SDK** memory stack (usearch HNSW, Grafeo graph
> memory, session extraction, AutoDream), **decouple indexing from chat turns**, and
> serve all three agents (Claude Code / Codex / Cersei) behind the **unchanged
> `MemorySearchFn` / `SearchMemoryTool`** seam.
>
> **Mode:** direct (no `gh` CLI). Use local `feature/*` branches; PRs raised manually.
> **Source of truth:** this file. Each step is cold-start executable.
> **Companion docs:** `crates/atlas-cersei/ARCHITECTURE.md`, `crates/atlas-cersei/CERSEI_SDK_DOCS.md`.

---

## 0. Why this replan (the problem)

Today's RAG (verified):
- On-device `all-MiniLM-L6-v2` (384-d) + **brute-force O(n) cosine** (`atlas-embed::BruteForce`), flat JSON index `<project>/.atlas/memory-index/index.json`, MIN_SCORE 0.30, 6s timeout.
- **Indexing is coupled to the chat turn** at three `src-tauri/src/commands/agents.rs` call sites:
  - **A** `:55` — per-delta synchronous `memory_delta::ingest` on every streaming delta.
  - **B** `:60` — per-`TurnFinished` `memory_compile::compile_finished_turn` → BYOK round-trip distilling decision/fact/failure/architecture events into `shared-memory/events.jsonl`.
  - **C** `:242` — per-user-turn inline `memory_retrieve::retrieve` (embed query + kNN) before forwarding.
- **The bug:** the vector index is **never rebuilt mid-session**, so knowledge distilled during a session is invisible to vector search until a manual rebuild. Plus per-turn embed + BYOK latency on the hot path.

Target (from the architect design — see `ARCHITECTURE.md` companion and §1 below): a new low crate `atlas-memory` bridging MiniLM into Cersei HNSW + graph + extraction, a single decoupled `MemoryIndexer`, and one RRF-fused `retrieve`.

---

## 1. Target architecture (reference)

```
 TAURI APP LAYER (src-tauri/src/commands/)
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ agents.rs TauriDeltaSink::emit                                            │
 │   A per-delta ingest  → REMOVED from hot path                            │
 │   B TurnFinished      → enqueue ExtractSession job                        │
 │   C inline retrieve   → REMOVED (model pulls via search_memory tool)      │
 │ memory_indexer.rs  MemoryIndexer (Tokio task + debounce + notify watcher) │
 │   queue: IndexCorpus | ExtractSession | Compact   (spawn_blocking worker)  │
 │ register_memory_search(closure) ── injects MemorySearchFn ──┐             │
 └───────────────┬─────────────────────────────────────────────┼────────────┘
        invoke/state                                            │ callback (frozen shape)
                 ▼                                              ▼
 ┌──────────────────────────────┐        ┌────────────────────────────────────┐
 │ crates/atlas-memory (NEW,LOW)│        │ crates/atlas-cersei (LOW, no Tauri) │
 │  MemoryEngine:               │◄───────│  memory.rs: MemorySearchFn / MemDoc │
 │   • MiniLmProvider:          │  uses  │   SearchMemoryTool (UNCHANGED seam) │
 │       EmbeddingProvider      │        └────────────────────────────────────┘
 │   • usearch::Index directly  │
 │     (HNSW save/load/remove)  │        ┌────────────────────────────────────┐
 │   • GraphMemory (Grafeo)     │◄───────│ crates/atlas-embed (MiniLM 384-d)   │
 │   • retrieve(): RRF fuse     │  wraps └────────────────────────────────────┘
 │   • SessionExtractor/AutoDream│
 └──────────────┬───────────────┘
                ▼ reads/writes
   <project>/.atlas/memory/                     ~/.atlas/memory/
     hnsw.usearch   graph.bincode                 global-graph.bincode
     manifest.json (supersedes index.json)        MEMORY.md (AutoDream, <200 lines)
     extracted/*.md
```

**Corpus routing (Hybrid):**
| Corpus | Path | Why |
|---|---|---|
| Codebase index, Claude/Codex `*.md`, CLAUDE.md/AGENTS.md, session text | **Embedding/HNSW** | semantic recall (the 86.6% / 19×-fewer-tokens sweet spot) |
| Decisions / Constraints / CodePattern + relationships, topic tags | **Graph (Grafeo)** | structure & links (graph substring alone is 2.2% — never the primary recall) |
| Live chat transcripts | **Session extraction → both** | distilled facts flow into HNSW + graph |

---

## 2. Invariants (verify after EVERY step)

1. `cd src-tauri && cargo check` is green; `cargo test` (touched crates) is green.
2. `npx tsc --noEmit` is green (only relevant when a step touches `src/`).
3. **`MemDoc { title, source, text }` and `MemorySearchFn(cwd, query, limit) -> Vec<MemDoc>` signatures are unchanged.** All three agents retrieve via this one callback.
4. **`atlas-cersei` is untouched** — it gains no new dependency (the `MemoryEngine` lives app-side in the Tauri layer behind the existing `MemorySearchFn` callback). `atlas-memory` has **no Tauri** dependency and **never** depends on `atlas-cersei`.
5. The **default** retrieve path performs **no network call** (on-device MiniLM). Remote BYOK embeddings are opt-in only.
6. No legacy data is deleted before its replacement is validated — archive, don't `rm`.
7. **Write-side parity:** memory *capture* must keep working for all three agents. Cersei's native session extraction consumes the Cersei conversation format; Claude Code / Codex stream their own JSONL, so any capture path that replaces call sites A/B must route the external agents' transcripts through a format adapter (see Step 7) — never silently drop their capture.
8. **One engine per project, shared by one indexer.** A cwd-keyed `Arc<RwLock<MemoryEngine>>` registry (Tauri managed `State`) is the single owner; both the `agents.rs:91` retrieve closure and the `MemoryIndexer` look the engine up by `cwd`. Every indexer `Job` carries a `cwd`. The store handle must be `Send + Sync`; reads (3 agents) take the read lock, the indexer takes the write lock (or swaps a fresh snapshot).

---

## 3. Steps

Legend — **Tier:** `strong` = use the strongest model (Opus); `default` = Sonnet.
**Dep:** step ids that must merge first. **∥** = may run in parallel with the listed step.

### Step 0 — API spike: verify the Cersei surface · Tier: strong · Dep: —
**Context brief.** `CERSEI_SDK_DOCS.md` was captured via summarization, so some API names may be approximate. The strong steps (2, 6, 7, 9) assume specific APIs — verify them against real types before building on them, so a wrong assumption fails in an afternoon spike, not three steps deep.
**Tasks.**
- In a throwaway branch, add `cersei-embeddings` + `cersei-memory[graph]` to a scratch crate and `cargo doc --open` (or read `~/.cargo` source). Confirm the real signatures of: `EmbeddingProvider` (trait methods + async-ness), `EmbeddingStore<P>` build/**persist/reload** + **incremental add** + **key removal** semantics (is delete hard or soft/tombstone?), `Metric::Cosine`, `SearchHit`; `GraphMemory` (`recall`, `store_memory`, `link_memories`, `revalidate_memory`, decay rate); the **session Memory Extraction** entry point + its gates; `AutoDream::new(...)` + gate fields.
- Record the actual signatures (and any deltas from the docs) inline in this plan's §7 "Verified API notes" before Step 2 starts.
**Verify.** Scratch crate compiles calling each API once.
**Exit.** Every API the plan depends on is confirmed to exist with a known signature, or the plan is amended where the doc was wrong.
**Rollback.** Discard the scratch branch (no production code touched).

### Step 1 — Scaffold `atlas-memory` crate · Tier: default · Dep: 0
**Context brief.** New low crate that will own HNSW + graph + extraction. Workspace is wired from `src-tauri/Cargo.toml`; crates live in `crates/`. No Tauri dep allowed. `atlas-memory` never depends on `atlas-cersei` (the dependency only ever points the other way at the app layer), so there is no cycle to worry about.
**Tasks.**
- `crates/atlas-memory/Cargo.toml`: deps `cersei-embeddings`, `cersei-memory` (feature `graph`), `atlas-embed` (path), `serde`, `serde_json`, `bincode`, `tracing`, `tokio` (no `full` unless needed). Pin `cersei*` to the same versions `atlas-cersei`/`atlas-review` already resolve (check their Cargo.toml first to keep one build).
- `src/lib.rs` with a `MemoryEngine` skeleton (no logic yet) + module stubs `provider`, `store`, `graph`, `retrieve`, `manifest`, `migrate`, `extract`. `MemoryEngine` is constructed per-project (`MemoryEngine::open(project_root)`) and must be `Send + Sync` so it can sit behind an `Arc<RwLock<_>>` shared by the retrieve closure and the indexer.
- Add `atlas-memory` to the workspace members only. **Do not** add it to `atlas-cersei` (Invariant 4) — the Tauri layer is the only consumer.
**Verify.** `cd src-tauri && cargo check` green; crate compiles empty.
**Exit.** `atlas-memory` builds and is a workspace member; zero Tauri deps (`cargo tree -p atlas-memory | grep -i tauri` returns nothing); `atlas-cersei`'s `Cargo.toml` is unchanged.
**Rollback.** Delete the crate dir + workspace entry.

### Step 2 — `MiniLmProvider` + HNSW `EmbeddingStore` + `manifest.json` · Tier: strong · Dep: 1
**Context brief.** The bridge that keeps embeddings on-device while gaining HNSW. **Step 0 found cersei's `EmbeddingStore`/`VectorIndex` are in-memory only (no persist/reload/remove), so persistence is built directly on `usearch 2.25.3`** (`Index::save`/`load`/`remove`; deletes are hard). We keep cersei's `EmbeddingProvider` trait for the MiniLM bridge (and so BYOK remote providers drop in later). `atlas-embed` already produces 384-d MiniLM vectors on CPU. **usearch keys are `u64`** but our doc ids are strings — the manifest carries the id↔key bijection.
**Tasks.**
- `provider.rs`: `MiniLmProvider` impl `cersei_embeddings::EmbeddingProvider` (async, `Send+Sync`) → `name()="atlas-minilm-384"`, `dimensions()=384`, `embed`/`embed_batch` delegate to `atlas-embed` (mean-pool + L2) under `spawn_blocking`.
- `store.rs`: own a `usearch::Index` (HNSW, `MetricKind::Cos`, 384-d) directly. `build`, **persist** via `Index::save(hnsw.usearch)` and **reload** via `Index::load`; incremental `add(key,vec)`; **hard delete** via `Index::remove(key)`. **Key management:** `BiMap<String id, u64 key>` (monotonic counter) persisted in the manifest.
- `manifest.rs`: `Manifest { provider_name, dim, next_key: u64, entries: [{ id, key: u64, content_hash, corpus, mtime }] }` persisted as `manifest.json`; content-hash diff vs. current corpus → `(add, update, delete)` sets, mapped to `u64` keys via the bimap. Atomic write (temp + rename) of HNSW + manifest **together** (write both temps, fsync, rename both) so they never diverge.
- Unit tests (assertions, not log-watching): round-trip persist/reload returns identical top-k; incremental add touches only delta keys; a delete removes the id from results (or tombstones + rebuilds); `provider_name`/`dim` recorded; id↔key map survives reload.
**Verify.** `cargo test -p atlas-memory`; `cd src-tauri && cargo check`.
**Exit.** Given N docs, building → persisting → reloading → `search` returns stable top-k; manifest reflects hashes + keys; a changed doc re-embeds only itself.
**Rollback.** Feature-gate `atlas-memory` consumers off; brute-force path in `atlas-embed` remains the live one until Step 6.

### Step 3 — Legacy index migration · Tier: default · Dep: 2 · ∥ 4
**Context brief.** Existing `<project>/.atlas/memory-index/index.json` already holds 384-d MiniLM vectors (same model) — import directly, no re-embed.
**Tasks.**
- `migrate.rs`: read legacy `StoredIndex { model, dim, docs:[{id,hash,vector}] }`; if `model == all-MiniLM-L6-v2 && dim == 384`, `add_batch` the stored vectors into the HNSW store, assign `u64` keys via the bimap, and write `manifest.json`; archive the old file to `index.json.bak`. If model/dim differ → schedule a full rebuild instead.
- **Run migration as the first action of `MemoryEngine::open`, before the indexer's first `IndexCorpus`** — so there is exactly one manifest writer at cold start (no Step 3/Step 4 race). The first `IndexCorpus` then diffs against the migrated manifest and only embeds genuinely new docs.
- Test with a fixture legacy file.
**Verify.** `cargo test -p atlas-memory`.
**Exit.** A legacy project loads into HNSW with zero re-embedding; archived original present; a subsequent index pass is a near no-op.
**Rollback.** Restore `index.json.bak`; migration is read-only on the original until archive.

### Step 4 — Engine registry + `MemoryIndexer` (decoupled background task) · Tier: strong · Dep: 2 · ∥ 3
**Context brief.** A single owned Tokio task in the Tauri layer does ALL indexing off the hot path, across **all open projects**. The engine is per-project; the indexer and the retrieve closure must both reach the right one by `cwd`. Heavy work in `spawn_blocking`; queue bounded so HNSW persistence never races.
**Tasks.**
- **Engine registry (this is the wiring the retrieve seam depends on):** a `MemoryRegistry { map: DashMap<String /*cwd*/, Arc<RwLock<MemoryEngine>>> }` stored as Tauri managed `State`. `registry.engine_for(cwd)` opens-or-returns the per-project engine (running Step 3 migration on first open) and **enqueues an initial `IndexCorpus{cwd}`** so a freshly opened project is indexed even though the FS watcher hasn't fired. This same registry is captured by the `agents.rs:91` closure (Step 6) and by the indexer.
- `src-tauri/src/commands/memory_indexer.rs`: `MemoryIndexer` with a bounded `mpsc` queue. **Every job carries a cwd:** `enum Job { IndexCorpus{cwd}, ExtractSession{cwd, agent, session}, Compact{cwd} }`. A `notify` FS watcher per open project on `*.md`, `CLAUDE.md`, `AGENTS.md`, `codebase-index/docs.json`; a debounce (≈2s coalesce) so watcher storms collapse to one `IndexCorpus{cwd}`.
- Worker: pull job → `registry.engine_for(cwd)` → take the **write lock** (or build a fresh snapshot and swap it in under the lock) → gather corpus (reuse `agent_memory::collect_corpus`, including the codebase-index `docs.json` feed) → diff via `Manifest` → `embed_batch` + `add_batch` → persist atomically. Retrieve (Step 6) takes the **read lock**, so 3 concurrent agents read while the indexer writes without racing. Confirm the usearch store handle is `Send + Sync` (Step 0); if not, serialize access through the `RwLock` and never hand the raw handle across an await.
- Register the indexer + registry in `lib.rs` builder; expose a `force_reindex(cwd)` `invoke` (replaces the manual Memory Graph trigger).
**Verify.** `cd src-tauri && cargo check`; **unit tests** (not log-watching): debounce coalesces N rapid FS events into 1 job; a job for cwd-A never touches cwd-B's `.atlas/memory/`; opening a project enqueues an initial `IndexCorpus`.
**Exit.** Editing a memory file updates that project's HNSW within a couple seconds with no chat activity; opening a project cold-indexes it; the queue is bounded; all FS/embed work is off the IPC thread; multiple projects stay isolated.
**Rollback.** Leave the indexer dormant (no triggers wired) — the old build path still exists until Step 5.

### Step 5 — Move indexing off the turn; trigger background reindex · Tier: default · Dep: 4 · serialize with 6,7
**Context brief.** **CORRECTED from the original "remove A and C".** Investigation showed: (a) call site **C** (inline `memory_retrieve::retrieve`) is a cheap *read* that **pushes** grounding into the prompt — and the **external ACP agents (Claude Code, Codex) have no `search_memory` pull tool**, so removing C would regress *their* RAG. Only Cersei pulls. (b) The genuine per-turn coupling is the **indexing/write** side: A (per-delta ingest) + B (per-turn BYOK distill), and the *staleness* bug (index never refreshed mid-session) — already fixed structurally by Step 4's background indexer. So Step 5 routes indexing to the background indexer and keeps reads working; **C is rewired (not removed) in Step 6**, B is handled in Step 7. **Steps 5,6,7 all edit `agents.rs` — keep them sequential.**
**Tasks.**
- **A (`agents.rs` `TauriDeltaSink::emit`, ~`:55`)** — inspect `memory_delta::ingest`. If it does only an in-memory shared-memory append, it is cheap — leave it (document why) but ensure no disk/embed work happens synchronously in `emit`. If it does any I/O, make it a non-blocking `try_send` (drop on full queue, never block `emit`).
- **On `TurnFinished` (`agents.rs` ~`:60`, alongside B)** — add a **non-blocking** `indexer.try_send(Job::IndexCorpus{cwd})` so chat-derived corpus (new session content) gets reindexed **in the background** (the FS watcher only watches `*.md`/docs.json, not session files, so turns need an explicit nudge). Fire-and-forget; never block. Leave B's distill itself intact until Step 7.
- **C (`agents.rs` ~`:242`)** — leave functionally in place for THIS step (it still grounds Claude/Codex). Just confirm it does not also trigger indexing. (Step 6 rewires its retrieval to the fresh engine and may skip it for the Cersei agent, which pulls.)
**Verify.** `cd src-tauri && cargo check`; assert `emit` does no blocking embed/disk I/O on the delta path; a finished turn enqueues exactly one `IndexCorpus` (non-blocking); the three agents still receive grounding (Cersei via tool, Claude/Codex via C).
**Exit.** No indexing runs synchronously on a prompt; finished turns trigger a background reindex; no agent loses grounding.
**Rollback.** Revert the `emit`/`TurnFinished` edits (kept in git history); independent of the indexer.

### Step 6 — Fused `retrieve` behind the frozen seam · Tier: strong · Dep: 4 · serialize with 5,7
**Context brief.** One retrieval entry point fusing embedding (primary) + graph (structure), returning the unchanged `MemDoc`. The embedding side is the authoritative recall path (86.6%); the graph (substring recall only 2.2%) contributes **weighted expansion**, not a co-equal rank list. Depends on Step 4's registry for the engine handle.
**Tasks.**
- `retrieve.rs`: `MemoryEngine::retrieve(&self, query, limit) -> Vec<MemDoc>`:
  1. `EmbeddingStore::search(embed(query), k)` → cosine `SearchHit`s; **apply the 0.30 similarity floor HERE, on the raw cosine score** (the floor is a cosine threshold and is meaningless once fused — do not apply it to the RRF score).
  2. `GraphMemory::recall(query, k)` → graph hits as a *secondary, down-weighted* contributor (lower RRF weight, or use only for expansion/linking), never able to outrank a strong embedding hit on its own.
  3. **RRF** fuse the two ranked lists → **Jaccard** dedup near-identical snippets → map to `MemDoc{title,source,text}`.
  4. HyDE / lexical query expansion (the full 183s/Q Hybrid) stays behind an **off-by-default** flag.
- **Wire the handle:** rewire `src-tauri/src/commands/memory_retrieve.rs::retrieve` to look up `registry.engine_for(cwd)` (Step 4), take the **read lock**, and delegate to `MemoryEngine::retrieve`. The `agents.rs:91` closure and the `MemorySearchFn(cwd,query,limit)->Vec<MemDoc>` shape are **unchanged** — only the closure body changes. `atlas-memory` is added as a dep of the **Tauri layer only**; `atlas-cersei` stays untouched (Invariant 4).
- Tests (assertions): cosine floor drops sub-0.30 *before* fusion; RRF ordering with a known fixture; graph hit cannot outrank a strong embedding hit; Jaccard dedup; output is byte-shape-identical `MemDoc`.
**Verify.** `cargo test -p atlas-memory`; `cd src-tauri && cargo check`; all three agents (Claude Code/Codex/Cersei) get hits via the same callback (smoke).
**Exit.** `search_memory` returns fused, deduped, cosine-floored results; HNSW replaces brute-force as the live path; no network on default path; `MemDoc` shape unchanged.
**Rollback.** Flip a feature flag back to the legacy `BruteForce` `memory_retrieve` path (kept until this step is validated).

### Step 7 — Native session extraction replaces call site B (all 3 agents) · Tier: strong · Dep: 4, 6 · serialize with 5,6
**Context brief.** **Move** the per-turn BYOK distill off the hot path and behind Cersei's gates — Step 0 confirmed the SDK supplies only `should_extract` (gates) + `extraction_prompt()` + `parse_extraction_output`; **you still make the BYOK LLM call yourself** (this step relocates+gates it, it does not remove it). Call site B runs for **all three** agents, and the extractor input must be a **format-neutral transcript** (Cersei native / Claude JSONL / Codex), or the external agents lose capture (the CRITICAL parity gap).
**Tasks.**
- `extract.rs` in `atlas-memory`: neutral `TranscriptTurn { role, text, tool_calls }`; an adapter converts each agent's transcript into it (reuse readers in `agent_memory`/`transcript.rs`). Gate with `cersei_agent::session_memory::should_extract` (≥20 msgs / ≥3 tool calls / no pending tool_use); on pass, build the prompt via `extraction_prompt()`, make ONE BYOK call (off hot path), `parse_extraction_output` → `MemoryCategory` items. Map `MemoryCategory`→`MemoryType` (lossy: UserPreference→User, ProjectFact/CodePattern/Decision/Constraint→Project) and **carry the real category as a topic tag** (Step 0 finding). Write to `extracted/*.md` (memdir) + `GraphMemory.store_memory`/`tag_memory`/`link_memories`; the same worker pass embeds them into HNSW.
- `agents.rs:60`: replace the `compile_finished_turn` spawn with `indexer.enqueue(Job::ExtractSession{cwd, agent, session})` — for every agent, not just Cersei.
- **A/B flag:** run new extraction alongside `memory_compile` behind a flag; compare outputs on a few real sessions per agent; only then remove `memory_compile`'s BYOK round-trip.
**Verify.** `cd src-tauri && cargo check`; `cargo test -p atlas-memory` (adapter produces neutral turns for all three transcript formats; gates fire correctly); a finished turn on **each** agent yields extracted memories that are immediately retrievable (no manual rebuild).
**Exit.** No per-turn BYOK call; all three agents capture memory off the hot path; distilled knowledge is searchable within one indexer pass; the "invisible until manual rebuild" bug is gone; no write-side parity regression.
**Rollback.** Flag back to `memory_compile`; extraction is additive until the flag flips.

### Step 8 — Fold legacy shared-memory into the graph · Tier: default · Dep: 7
**Context brief.** Existing `<project>/.atlas/shared-memory/events.jsonl` (decisions/failures/architecture/facts) should become graph nodes; retire the per-delta append path.
**Tasks.**
- One-time importer: read `events.jsonl` → `GraphMemory` Decision/Constraint nodes with `link_memories`; keep the file readable (archived) for one release for rollback.
- Remove `memory_compile.rs` BYOK distill once Step 7's flag is permanently on.
**Verify.** `cargo test -p atlas-memory`; `cd src-tauri && cargo check`.
**Exit.** Shared-memory knowledge is in the graph and retrievable via fused recall; no new per-delta writes.
**Rollback.** Re-enable the append path; archived JSONL intact.

### Step 9a — AutoDream consolidation + graph decay · Tier: strong · Dep: 7
**Context brief.** Idle-time consolidation of per-project memory. Step 0 confirmed `AutoDream::new(PathBuf,PathBuf)` provides **gates/state/lock only** (`AutoDreamConfig{min_hours=24,min_sessions=5}`, stale-lock 3600s) — **the consolidation logic is ours**. Also: Grafeo `revalidate_memory` is a **no-op** and decay is never applied on recall (cosmetic) — so we implement our OWN prune, not relying on the SDK's decay.
**Tasks.**
- Wire the `Compact{cwd}` job → use `AutoDream` for gates + `.consolidation_lock`/`.consolidation_state.json`; implement the Orient→Gather→Consolidate→Prune logic ourselves.
- Our own prune: drop graph nodes below a confidence floor and re-summarize, computing recency ourselves (don't trust Grafeo decay). Keep per-project memory bounded.
**Verify.** `cargo test -p atlas-memory`; forced `Compact` consolidates + prunes; lock prevents concurrent runs.
**Exit.** Idle-time consolidation runs entirely off the hot path; gates respected; no double-run.
**Rollback.** Disable the `Compact` trigger; per-project memory unaffected.

### Step 9b — Global cross-project memory · Tier: strong · Dep: 9a
**Context brief.** A global store under `~/.atlas/memory/` (`global-graph.bincode`, `MEMORY.md` kept < 200 lines) that outlives any one project. The **promotion rule must be decided up front** (do not leave it TBD): start with an explicit, conservative rule — promote a memory to global only when it is a `UserPreference` or a `Constraint` with confidence ≥ 0.8 that has been re-validated in ≥2 distinct projects. Everything else stays project-local.
**Tasks.**
- Implement the global graph + `MEMORY.md` writer (AutoDream Prune target, < 200 lines).
- Implement the promotion rule above; make the thresholds constants so they're easy to tune.
- Fused retrieve (Step 6) optionally blends global hits at a low weight when a project has sparse local memory.
**Verify.** `cargo test -p atlas-memory`: only qualifying memories promote; `MEMORY.md` stays bounded.
**Exit.** Global memory persists across projects under a deterministic, documented promotion rule.
**Rollback.** Disable promotion; global store is additive and ignorable.

### Step 10 — 3-agent parity + perf + docs · Tier: default · Dep: 6, 7, 8, 9a, 9b
**Context brief.** Final hardening. The frozen `MemDoc`/`MemorySearchFn` must serve all three agents identically; HNSW should beat brute-force on a realistic corpus.
**Tasks.**
- Integration test: Claude Code, Codex, Cersei each retrieve via `search_memory` and get well-formed `MemDoc`s.
- Micro-benchmark HNSW vs the old `BruteForce` on a few-thousand-doc corpus (latency + recall sanity).
- Update `crates/atlas-cersei/ARCHITECTURE.md` §RAG to point at the new engine; note migration + flags in a short `MIGRATION.md`.
- Remove dead code (old `memory_graph` brute-force build, legacy flags) once everything is green.
**Verify.** `cd src-tauri && cargo check && cargo test`; `npx tsc --noEmit`; all three agents smoke-pass.
**Exit.** Full pipeline green, docs current, no dead legacy paths, no regressions for the other two agents.
**Rollback.** N/A (cleanup step); revert individual commits if a regression appears.

---

## 4. Dependency graph & parallelism

```
0 ─▶ 1 ─▶ 2 ─┬─▶ 3 ───────────────────────────┐
             └─▶ 4 ─▶ [ 5 ─▶ 6 ─▶ 7 ] ─▶ 8 ─▶ 9a ─▶ 9b ─▶ 10
                       └ serialized: all edit agents.rs ┘
   (3 ∥ 4: both depend only on 2, different files)
```
- **Parallelizable:** Step 3 ∥ Step 4 (both depend only on 2, touch different files: `migrate.rs` vs `memory_indexer.rs`).
- **NOT parallelizable (reviewer fix):** Steps **5, 6, 7 all edit `agents.rs`** (`:55`, `:91`, `:60`/`:242`) — run them sequentially on one branch lineage. The earlier "6 ∥ 5" claim was wrong.
- **Critical path:** 0 → 1 → 2 → 4 → 5 → 6 → 7 → 8 → 9a → 9b → 10.
- **Strong-model steps:** 0, 2, 4, 6, 7, 9a, 9b (core correctness + API verification). Default: 1, 3, 5, 8, 10.

## 5. Git workflow (direct mode — no `gh`)

- Branch per step from `0.1.18` (or current integration branch): `feature/rag-<n>-<slug>`.
- `cargo check` + `cargo test` green before each merge; squash-merge locally.
- Push targets are **explicit** (`fork` is yours, `origin` is pacifio/atlas) — never push without naming the remote. Do **not** add an AI co-author trailer.
- Open PRs manually (gh CLI unavailable).

## 6. Top risks (carry into every step)

1. **Provider/dim mismatch on BYOK switch** → guard via `manifest.provider_name`; force full rebuild when it changes (can't mix 384-d and 1536-d).
2. **Extraction quality regression** vs the old BYOK distill → A/B behind a flag (Step 7) before deleting `memory_compile`.
3. **FS-watcher storms** during big rebuilds → debounce + coalesce + bounded queue + batch cap.
4. **usearch persistence corruption** → atomic temp+rename; rebuild-on-load-failure fallback.
5. **3-agent regression** → `MemDoc`/`MemorySearchFn` shapes frozen; integration-test all three before each merge that touches retrieval.
6. **Cersei SDK maturity** (graph substring weak; extraction is SDK-gated) → graph is structure-only, never the primary recall; keep embedding path authoritative.

## 7. Verified API notes (filled in by Step 0)

> **VERIFIED by Step 0 spike** against real crate source (crates.io): `cersei-embeddings 0.1.9`,
> `cersei-memory 0.1.9` (feature `graph` ✓), `cersei-agent 0.1.9` (already a dep), `usearch 2.25.3`,
> `grafeo 0.5.42`. Four doc errors corrected below — design amended accordingly.

| API | Used in | Verified | Real signature / note |
|---|---|---|---|
| `EmbeddingProvider{name,dimensions,embed,embed_batch}` | 2 | ☑ | `#[async_trait] trait EmbeddingProvider: Send+Sync`; `embed`/`embed_batch` async; object-safe (`&dyn` ok). Custom MiniLM provider compiles. **KEEP this.** |
| `EmbeddingStore<P>` / `VectorIndex` persist + remove | 2 | ⚠ **NO** | In-memory only: `new`, `add_batch(&[(u64,String)])`, `search(&str,k)`. **No persist, no reload, no remove** (`inner` private). → **Build persistence on `usearch 2.25.3` directly** (`save`/`load`/`remove`, hard deletes). |
| store handles `Send + Sync` | 2,4,6 | ☑ | `EmbeddingStore`, `VectorIndex`, `GraphMemory`, `AutoDream` all `Send+Sync`. |
| `GraphMemory` open/store/recall/link | 6,7,9a | ☑ | `open(&Path)`, `open_in_memory()`, `store_memory(&str,MemoryType,f32)->Result<String>`, `link_memories`, `tag_memory`, `recall(&str,usize)->Vec<String>` (substring CONTAINS), `recall_top_k->Vec<(String,f32)>` (word-overlap, **not semantic**), `by_type`. |
| `MemoryType` enum | 7,8 | ⚠ | `{User, Feedback, Project, Reference}` — **NOT** Decision/Constraint/CodePattern. Richer `MemoryCategory{UserPreference,ProjectFact,CodePattern,Decision,Constraint}` lives only in extraction → map lossily to `MemoryType` + carry the real category as a **topic tag**. |
| `revalidate_memory` / decay 0.01/day | 9a | ⚠ **cosmetic** | `revalidate_memory` is a **no-op** (Grafeo lacks SET); decay computed but never applied on recall. Treat as non-functional — do not rely on it. |
| Session extraction entry + gates | 7 | ☑ | `cersei_agent::session_memory`: `should_extract(&[Message],&SessionMemoryState)->bool` (gates **≥20 msgs / ≥3 tool calls / no pending tool_use** confirmed), `extraction_prompt()`, `parse_extraction_output`, `persist_memories`. **Still needs a BYOK LLM call you make** — SDK = prompt+parser+gates only. |
| `AutoDream::new(memory_dir, conversations_dir)` | 9a | ☑ | `new(PathBuf,PathBuf)`; `AutoDreamConfig{min_hours=24,min_sessions=5}`, lock stale 3600s, `.consolidation_state.json`/`.consolidation_lock`. **Provides gates/state/lock only — consolidation logic is ours.** |
