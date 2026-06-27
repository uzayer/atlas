# Cersei Agent SDK — Documentation

> Mirror of the official Cersei SDK docs at <https://cersei.tryatlas.cc/docs>, compiled
> into a single reference. Cersei is the agent SDK that powers Atlas's native in-process
> agent (`crates/atlas-cersei/`). For how Atlas wraps this SDK, see `ARCHITECTURE.md`.
>
> **Fidelity note:** these pages were captured via an HTML-fetch + summarization step,
> so prose is faithful to the documented facts but some code blocks / signatures may not
> be character-for-character verbatim. Treat the live site as the source of truth for
> exact API signatures. Pages that returned fully verbatim content are the API
> reference, primitives, compression, VMs, sessions/system-prompts, and the cookbooks.

## Table of Contents

1. Getting Started — overview, quick start, installation
2. AgentRL — overview, API, template, cookbook
3. Workflows — overview, API, cookbook
4. API Reference — providers, types, provider, tools, agent, memory, hooks, MCP
5. Built-in Tools & Code Intelligence
6. Primitives — primitives, API, cookbook
7. Embeddings — overview, API, cookbook
8. Compression (RTK) — overview, benchmarks
9. VMs (Sandboxes) — overview, API, cookbook
10. Runtime — sessions, background tasks, system prompts
11. Architecture — architecture, crate map, data flow
12. Examples & Cookbooks — custom tools, deployment, embedding, ML/research/general agents, graph memory
13. Comparisons, Abstract & Benchmarks — comparisons, abstract, benchmarks, changelog

---

# Getting Started

## Overview  (/docs)

# Cersei: Complete Rust SDK for Coding Agents

Cersei is "The complete Rust SDK for building coding agents." It provides composable library functions for production coding agent components including tool execution, LLM streaming, sub-agent orchestration, persistent memory with an embedded graph database, skills, and MCP integration.

### Key Differentiators

The documentation contrasts Cersei with Claude Code and OpenCode by noting these competitors are "closed, monolithic CLI apps" that cannot be embedded or customized. Cersei offers these capabilities as decomposable library functions instead.

### Performance Highlights

- Startup times: Cersei's Abstract CLI at 22ms versus Claude Code at 266ms (12x faster).
- Peak memory usage: 4.7 MB for Abstract versus 333 MB for Claude Code (71x more efficient).
- Memory recall: "Cersei's embedded graph database does indexed lookups in 98 microseconds — no LLM call, no API cost," compared to 7545ms for Claude Code and 5751ms for Codex CLI.

### Architecture Components

The SDK includes six major feature areas: AgentRL for self-evolving agents, 34 built-in tools, multi-provider LLM support, graph memory, an agent runtime with builder pattern configuration, and sub-agent orchestration capabilities.

### Installation

Cersei is available on crates.io. For the complete Abstract CLI, users can install via cargo or use a one-line installation script for macOS/Linux without requiring an existing Rust toolchain.

## Quick Start  (/docs/quick-start)

# Cersei Quick Start

### Installation

The framework requires adding dependencies to your Rust project's `Cargo.toml`. Core dependencies include `cersei`, `tokio` with full features, and `anyhow`. For graph-based memory functionality, developers should add the `cersei-memory` crate with the "graph" feature enabled.

### System Requirements

Getting started requires "Rust 1.75+ (edition 2021)" and an API key from either Anthropic or OpenAI. The Grep tool component prefers `rg` (ripgrep) but includes fallback support for standard `grep`.

### Basic Agent Implementation

A minimal agent uses the builder pattern to configure a provider, add tools, set permissions, and execute a query. The example demonstrates using Anthropic's provider with coding tools and an AllowAll permission policy to list directory contents.

### Streaming Results

For real-time output, agents support streaming via `run_stream()`. This approach yields events including text deltas, tool invocation notifications, and completion signals that applications can process incrementally.

### Alternative Providers

The framework supports OpenAI through straightforward provider substitution, specifying model selection like "gpt-4o". Custom endpoints (such as local Ollama instances) are configurable through the provider builder, allowing base URL and model specification without relying on hosted services.

## Installation  (/docs/installation)

# Installation

The Cersei installation guide covers multiple setup approaches for this Rust-based agent SDK.

### Primary Installation Method

Users can add Cersei to their project via crates.io using either TOML configuration or CLI commands. The basic setup requires three dependencies: the main `cersei` crate, `tokio` with full features enabled, and `anyhow` for error handling.

### Modular Architecture

The framework offers granular crate selection, allowing developers to install only needed components. Available packages include type definitions, LLM provider integrations, tool systems, agent runtime, memory backends, hooks/middleware, MCP and LSP clients, embeddings functionality, compression utilities, skills registry, and VM isolation capabilities.

### Additional Installation Options

A reference CLI implementation called `abstract-cli` is available for installation. For those without a Rust toolchain, a shell script installer detects the operating system, manages Rust installation if necessary, and places the executable in the system PATH.

### Configuration Requirements

The setup requires at least one API key from supported providers. Users can set `ANTHROPIC_API_KEY` for Claude models or `OPENAI_API_KEY` for GPT variants, with simultaneous configuration supported.

### Technical Prerequisites

"Rust 1.75+ (edition 2021)" is required as the minimum version. Ripgrep (`rg`) is optional but recommended for enhanced grep functionality. The framework supports macOS, Linux, and Windows environments.


---

# AgentRL

## AgentRL Overview  (/docs/agentrl-overview)

### Core Concept

AgentRL transforms Cersei into a self-improving agent system. When tasks fail, the system traces the failure, generates repair proposals through a planner, tests them in isolated sandboxes, and promotes successful solutions as reusable tools. Future similar tasks leverage these cached tools for faster resolution.

### Key Components

**ExecutionGraph** — A directed acyclic graph of agent turns and tool calls that generates a `FailureTrace` on failure, providing the planner with specific guidance on what needs fixing.

**GeneralAgent / PlannerAgent** — Standard `Agent` instances configured with different prompts and toolsets for their respective roles.

**Sandboxes** — Isolated working directories (or `cersei-vms` environments) where parallel proposals execute without interference.

**ToolRegistry** — A persistent, searchable database of agent-created tools supporting lookup-before-build and register-on-win workflows.

**Verifier** — Independent validation (scripts, tests, commands) that determines success; immune to agent manipulation.

### Why It Matters

The system delivers three benefits: "Solved problems become `DynamicTool`s in a registry. Similar future tasks are solved by recall, not re-derivation"; recovery attempts run in isolated, disposable sandboxes; and "Failures aren't retried blindly. The `ExecutionGraph` extracts a scrubbed, ordered failure trace."

### Installation

Enable via feature flag:

```toml
[dependencies]
cersei = { version = "0.1", features = ["agentrl"] }
tokio = { version = "1", features = ["full"] }
anyhow = "1"
```

This unlocks `cersei::agentrl` and `cersei::agentlang` modules plus sandbox support.

### Observable Outcomes

Three resolution paths occur: direct solving without recovery, solving via newly-created tools after failure recovery, or solving via previously-cached tools on subsequent similar tasks.

## AgentRL API  (/docs/agentrl-api)

The AgentRL API documentation describes a reinforcement learning orchestration system for agents. Here are the key components:

### Core Components

**Orchestrator** manages a "run → fail → plan → sandbox → promote → register loop" that is generic over an `AgentRlRunner`. It can be configured with memory, custom settings, and ID generation functions.

**AgentRlRunner** is a trait defining the mechanism behind the loop, with methods for running general agents, planning proposals, executing proposals, and promoting winners. The documentation notes: "It separates the loop (deterministic, unit-testable) from the runtime (LLM calls, sandboxes)."

**CerseiRunner** provides a batteries-included implementation that drives real agents with actual providers, supporting model configuration, turn budgets, and customizable toolsets.

### Supporting Systems

**ExecutionGraph** creates a DAG of agent runs populated by `GraphReporter`. It tracks nodes, edges, and failure traces while scrubbing secrets throughout.

**ToolRegistry** persists agent-built tools in a searchable, keyword-ranked database that supports registration, lookup, and success tracking.

**DynamicTool** and **RegistrySearchTool** make registered solutions callable within agent runs, enabling tool reuse and discovery.

**Verifier** determines task success through independent validation—the documentation emphasizes verifiers should be "independent of anything the agent writes" to prevent agents from gaming tests.

**Memory Bridge** records solutions for future recall, automatically triggered when memory is configured.

## AgentRL Template  (/docs/agentrl-template)

### Overview

AgentTemplate is described as "a tiny functional language that agents and LLMs write, and the Cersei runtime executes." It enables safe composition of file, network, and agent operations without requiring runtime modifications.

### Key Features

The language supports:
- **Variables** prefixed with `$` for data storage
- **Method chaining** where results flow between operations
- **Inter-agent communication** via the `agent.send()` primitive
- **Permission queries** for capability requests

### Core Grammar

The syntax follows a straightforward structure: statements can be assignments (`$x = expr`) or expressions. Expressions support method chaining and function calls with both named and positional arguments.

### Builtin Operations

The documentation lists 13 primary operations spanning:
- **File I/O**: reading, writing, editing, globbing, grepping, deletion
- **Network**: HTTP requests and search queries
- **Agent Communication**: messaging, tool discovery, tool registration
- **Key-Value Storage**: get/set operations
- **Permissions**: capability requests

Each builtin is "permission-gated" before execution, preventing unauthorized operations.

### Safety Mechanisms

Three protective layers are documented:
1. Operations consult a `PermissionPolicy` before running
2. A configurable step budget prevents infinite loops
3. No eval/exec primitive exists—host access only through mapped tools

### Integration

The language integrates into Cersei through the `RunAgentTemplateTool`, allowing agents to author executable programs. Error messages include precise line/column information for model self-correction.

## AgentRL Cookbook  (/docs/agentrl-cookbook)

The AgentRL Cookbook provides practical recipes for building self-improving agents. Here's the complete content:

### Overview

The cookbook requires the `agentrl` feature in your Cersei dependency and presents seven distinct patterns for agent development.

### Recipe 1: Self-Improving Coding Agent

This pattern demonstrates creating an agent that solves tasks, registers solutions, and reuses them. It combines a `ToolRegistry`, a `CommandVerifier` for independent validation, and a provider factory. The example guides an agent to create a GCD implementation in Python, verifying correctness through shell commands rather than agent-written tests.

### Recipe 2: Recovery Loop via Restricted Tools

By intentionally limiting the `GeneralAgent` to read-only operations, developers can trigger the recovery pathway: failed verification → planning → sandboxed proposals → registration. The example shows configuring `OrchestratorConfig` with parameters like `max_rl_rounds` and `num_proposals`.

### Recipe 3: Cache Hit Pattern

Once registered, similar tasks leverage the cached tool through registry search, bypassing planner and sandbox execution. Results indicate solutions via `Solved::ByCachedTool`.

### Recipe 4: Custom Verifier

Any implementation of the `Verifier` trait works—the example demonstrates `CargoTestVerifier` running test suites and capturing stderr output for verification decisions.

### Recipe 5: Custom Runner

The orchestrator accepts any `AgentRlRunner` implementation, enabling custom agent stacks and proposal strategies through async methods like `run_general`, `plan`, and `run_proposal`.

### Recipe 6: Container Isolation

Proposals run in isolated sandboxes using `cersei-vms`, with docker or local process runtimes. Winners snapshot and restore for promotion.

### Recipe 7: AgentTemplate Programs

Models can write AgentTemplate DSL programs using `RunAgentTemplateTool`, combining provider, tool registry, and system prompts teaching the DSL specification.


---

# Workflows

## Workflows Overview (/docs/workflows-overview)

Workflows let you define a multi-step pipeline as an explicit graph of **steps** instead of leaning on a single agent's reasoning to manage the entire plan. The defining characteristic is that the entire workflow is serializable data as a `WorkflowDef` — a flat list of nodes and edges that converts losslessly to and from JSON.

### When to Use a Workflow

Employ workflows when the steps are known up front and the order matters — you want fine-grained control over data flow. Use a plain `Agent` instead when the path is open-ended and you want the model to decide what to do next.

### The Shape of a Workflow

Workflows support several node types:

- **Step** — runs a registered `Step` by id
- **Parallel / Join** — fan out to multiple branches concurrently
- **Branch** — evaluate conditions; first match wins
- **Loop** — `dowhile` / `dountil` / `foreach`
- **Map** — JSON reshape between steps

### Core Pieces

**WorkflowDef (the IR)**: A serializable graph containing nodes, edges, and entry point. The single source of truth from builder and UI alike.

**Step trait**: Shaped exactly like a `Tool`: an id, input/output JSON schemas, and an async `execute`.

**StepRegistry**: Maps step-ids to executable implementations. The UI carries only references; the host supplies code.

**WorkflowEvent / Stream**: A serializable event stream for live graph updates over SSE or WebSocket.

### Getting Started

Register steps, author the graph using `WorkflowBuilder`, compile against the registry, then run with your input data.

### Round-tripping Through the UI

Because `WorkflowDef` is plain serde data, the same workflow is just JSON. The visual builder emits JSON that deserializes identically to programmatically-built definitions.

### Live Status

Call `stream()` to receive a `WorkflowStream` of `WorkflowEvent`s. Every event is `Serialize`, so you can forward them straight to a browser over SSE/WebSocket.

### Enable the Feature

Add workflows support via Cargo:

```toml
[dependencies]
cersei = { version = "0.2.1", features = ["workflows"] }
```

Then import with `use cersei::workflows::prelude::*;`

## Workflows API (/docs/workflows-api)

### Overview

The Workflows API is organized within `cersei-workflows`. Import common types via:

```rust
use cersei::workflows::prelude::*;
// or: use cersei_workflows::prelude::*;
```

### Core Components

**Step** represents a unit of work, similar to a Tool. It requires an id, optional description, JSON schemas for input/output, and an async execute method:

```rust
#[async_trait]
pub trait Step: Send + Sync {
    fn id(&self) -> &str;
    fn description(&self) -> &str { "" }
    fn input_schema(&self) -> serde_json::Value { Value::Null }
    fn output_schema(&self) -> serde_json::Value { Value::Null }
    async fn execute(&self, input: Value, ctx: &StepContext) -> Result<StepOutcome>;
}
```

**StepOutcome** indicates completion or suspension:

```rust
pub enum StepOutcome {
    Done(Value),
    Suspended { resume_schema: Value, payload: Value },
}
```

**StepContext** provides execution context including run identification, shared mutable state, event emission, extensions, and resume data when applicable.

### First-Party Steps

| Type | Purpose |
|------|---------|
| FnStep | Wraps async closures |
| AgentStep | Wraps cersei_agent::Agent |
| ToolStep | Wraps cersei_tools::Tool |
| WorkflowStep | Runs nested workflows |

### Workflow IR — WorkflowDef

The serializable workflow graph contains nodes and edges with an entry point. Node types include Step, Map, Parallel, Join, Branch, and Loop operations. Edges define sequential flow, forks, merges, conditions, and loop-back relationships.

### Conditions

Branch predicates evaluate the run scope (input, state, step outputs, current data) using JSON Pointers. Supported operators include equality, comparison, existence checks, truthiness, and logical combinations.

### Execution

**WorkflowBuilder** programmatically constructs workflows with fluent methods for sequential steps, parallel branches, conditionals, and loops.

**Workflow** compiles definitions against a StepRegistry, validating structural integrity before execution. Methods include:
- `start()` — begins execution
- `stream()` — returns event stream
- `resume()` — continues suspended runs

### Events & Results

**WorkflowEvent** variants cover workflow lifecycle events (started, step completed/failed/suspended), branching decisions, state updates, and nested activity. Events are serializable for browser delivery.

**WorkflowResult** contains run metadata, step results with status and timing, terminal output, shared state, and suspension points.

### Persistence

**RunStore** manages suspend/resume via snapshots. The current MVP uses in-memory storage, with plans for durable backends supporting restart resilience.

## Workflows Cookbook (/docs/workflows-cookbook)

### Overview

The Workflows Cookbook provides practical recipes for `cersei-workflows`, each self-contained and requiring these dependencies:

```toml
[dependencies]
cersei = { version = "0.2.1", features = ["workflows"] }
tokio = { version = "1", features = ["full"] }
serde_json = "1"
```

### Key Patterns

**Sequential Pipeline**: Three steps execute in order, with each receiving output from the previous step. The example transforms "hello world" through uppercase conversion and emphasis addition.

**Parallel Execution**: Multiple independent steps run concurrently using `JoinStrategy` (either `AllOrFail` to abort on first error, or `AllSettled` to collect all results).

**Conditional Branching**: The `branch` method evaluates conditions against run scope using JSON Pointer paths. The first matching `Condition` wins, and the other arms never run.

**Shared State**: `StepContext` provides mutable state across steps via `setState`/`getState` methods, with results included in `WorkflowResult.state`.

**Data Reshaping**: `Map` nodes perform pure JSON transforms using JSON-pointer paths—particularly useful after parallel joins to restructure array outputs into named objects.

**Agent Integration**: `AgentStep` wraps agents, rendering node input into prompt templates and returning `{ text, turns, stop_reason }`.

**Tool Integration**: `ToolStep` wraps any `Tool`, dispatching input directly and producing `{ content, is_error, metadata }`.

**Workflow Nesting**: Child workflows embed as `WorkflowStep`, executing to completion and contributing final results.

**Human-in-the-Loop**: Steps return `StepOutcome::Suspended` to pause execution. The `Workflow::resume` method replays completed steps from snapshot and continues with injected resume data.

**Streaming Events**: The `stream()` method returns serializable `WorkflowEvent` objects for real-time UI updates.

**Visual Builder Integration**: Compile `WorkflowDef` JSON from UI builders; validation occurs at compile-time, rejecting unknown steps and malformed graphs before execution begins.


---

# API Reference

## Providers  (/docs/providers)

Cersei supports 13 providers out of the box. Most use the OpenAI-compatible API format, which means adding a provider is just an env var — no new code.

### Model String Format

```
provider/model
```

Pass this to the Agent builder or the Abstract CLI:

```rust
Agent::builder()
    .provider(cersei_provider::from_model_string("groq/llama-3.1-70b-versatile")?.0)
```

```bash
abstract "fix the tests" --model groq/llama-3.1-70b-versatile
```

Bare model names auto-detect the provider from known prefixes:

```bash
abstract "fix the tests" --model gpt-4o          # → openai
abstract "fix the tests" --model claude-sonnet-4-6  # → anthropic
abstract "fix the tests" --model gemini-2.0-flash   # → google
```

### Model Router

```rust
use cersei_provider::from_model_string;

// Explicit: provider/model
let (provider, model) = from_model_string("openai/gpt-4o")?;

// Auto-detect from prefix
let (provider, model) = from_model_string("gpt-4o")?;

// List providers with valid auth
let available = cersei_provider::router::available_providers();

// List all known providers
let all = cersei_provider::router::all_providers();
```

**API Functions:**

- `from_model_string(model)` → `Result<(Box<dyn Provider>, String)>`: Parse a model string, construct the provider, return (provider, resolved_model_name).
- `available_providers()` → `Vec<&'static ProviderEntry>`: Providers with valid auth configured in the environment.
- `all_providers()` → `&'static [ProviderEntry]`: All 13 known providers regardless of auth.

---

### Anthropic

Claude models. Uses Anthropic's native API format (different from OpenAI).

| Property      | Value                      |
| ------------- | -------------------------- |
| API Base      | `https://api.anthropic.com` |
| Env Var       | `ANTHROPIC_API_KEY` or `ANTHROPIC_KEY` |
| Format        | Anthropic (native)         |
| Default Model | `claude-sonnet-4-6`        |

**Models:**

| Model               | Context Window | Vision | Thinking | Tool Use |
| ------------------- | -------------- | ------ | -------- | -------- |
| `claude-opus-4-6`   | 200K           | Yes    | Yes      | Yes      |
| `claude-sonnet-4-6` | 200K           | Yes    | Yes      | Yes      |
| `claude-haiku-4-5`  | 200K           | Yes    | No       | Yes      |

```bash
export ANTHROPIC_API_KEY=sk-ant-...
abstract "fix the tests" --model anthropic/claude-sonnet-4-6
abstract "fix the tests" --model sonnet   # alias
```

```rust
let (provider, model) = from_model_string("anthropic/claude-sonnet-4-6")?;
```

---

### OpenAI

GPT and o-series models.

| Property      | Value                       |
| ------------- | --------------------------- |
| API Base      | `https://api.openai.com/v1` |
| Env Var       | `OPENAI_API_KEY`            |
| Format        | OpenAI-compatible           |
| Default Model | `gpt-4o`                    |

**Models:**

| Model         | Context Window |
| ------------- | -------------- |
| `gpt-4o`      | 128K           |
| `gpt-4-turbo` | 128K           |
| `o1`          | 200K           |
| `o3`          | 200K           |

```bash
export OPENAI_API_KEY=sk-...
abstract "fix the tests" --model openai/gpt-4o
abstract "fix the tests" --model 4o   # alias
```

---

### Google

Gemini models via the OpenAI-compatible endpoint.

| Property      | Value                                                           |
| ------------- | --------------------------------------------------------------- |
| API Base      | `https://generativelanguage.googleapis.com/v1beta/openai`      |
| Env Var       | `GOOGLE_API_KEY` or `GEMINI_API_KEY`                           |
| Format        | OpenAI-compatible                                               |
| Default Model | `gemini-3.1-pro-preview`                                        |

**Models:**

| Model                    | Context Window |
| ------------------------ | -------------- |
| `gemini-3.1-pro-preview` | 2M             |
| `gemini-3.0-flash`       | 1M             |
| `gemini-2.0-flash`       | 1M             |
| `gemini-2.0-pro`         | 1M             |
| `gemini-1.5-pro`         | 2M             |

```bash
export GOOGLE_API_KEY=AIza...
abstract "fix the tests" --model google/gemini-2.0-flash
abstract "fix the tests" --model gemini   # alias
```

---

### Mistral

Mistral and Codestral models.

| Property      | Value                       |
| ------------- | --------------------------- |
| API Base      | `https://api.mistral.ai/v1` |
| Env Var       | `MISTRAL_API_KEY`           |
| Format        | OpenAI-compatible           |
| Default Model | `mistral-large-latest`      |

**Models:**

| Model                  | Context Window |
| ---------------------- | -------------- |
| `mistral-large-latest` | 128K           |
| `codestral-latest`     | 256K           |

```bash
export MISTRAL_API_KEY=...
abstract "fix the tests" --model mistral/mistral-large-latest
abstract "fix the tests" --model mistral   # alias
```

---

### Groq

Llama, Mixtral, and other open models on Groq's inference hardware.

| Property      | Value                                |
| ------------- | ------------------------------------ |
| API Base      | `https://api.groq.com/openai/v1`    |
| Env Var       | `GROQ_API_KEY`                      |
| Format        | OpenAI-compatible                   |
| Default Model | `llama-3.1-70b-versatile`           |

**Models:**

| Model                     | Context Window |
| ------------------------- | -------------- |
| `llama-3.1-70b-versatile` | 128K           |
| `llama-3.1-8b-instant`    | 128K           |
| `mixtral-8x7b-32768`      | 32K            |

```bash
export GROQ_API_KEY=gsk_...
abstract "fix the tests" --model groq/llama-3.1-70b-versatile
abstract "fix the tests" --model llama   # alias
```

---

### DeepSeek

DeepSeek Chat, Reasoner, and Coder models via DeepSeek's native endpoint.

| Property      | Value                                  |
| ------------- | -------------------------------------- |
| API Base      | `https://api.deepseek.com/v1`          |
| Env Var       | `DEEPSEEK_API_KEY` (the only variable required) |
| Format        | OpenAI-compatible                      |
| Default Model | `deepseek-chat`                        |

**Models:**

| Model               | Context Window |
| ------------------- | -------------- |
| `deepseek-chat`     | 64K            |
| `deepseek-reasoner` | 64K            |
| `deepseek-coder`    | 64K            |

Minimal working example:

```bash
export DEEPSEEK_API_KEY=sk-...
abstract --provider deepseek --model deepseek-chat
abstract --provider deepseek --model deepseek-reasoner

# Equivalent model-string forms:
abstract "fix the tests" --model deepseek/deepseek-chat
abstract "fix the tests" --model deepseek            # alias → deepseek/deepseek-chat
```

Selecting `--provider deepseek` (or any `deepseek-*` model name) always resolves `DEEPSEEK_API_KEY` and the native DeepSeek base URL — it never falls back to the OpenAI endpoint. To point DeepSeek at a proxy/gateway instead, set `DEEPSEEK_BASE_URL`.

---

### xAI

Grok models.

| Property      | Value                 |
| ------------- | --------------------- |
| API Base      | `https://api.x.ai/v1` |
| Env Var       | `XAI_API_KEY`         |
| Format        | OpenAI-compatible     |
| Default Model | `grok-2`              |

```bash
export XAI_API_KEY=xai-...
abstract "fix the tests" --model xai/grok-2
abstract "fix the tests" --model grok   # alias
```

---

### Together

Open-source models hosted by Together AI.

| Property      | Value                                                |
| ------------- | ---------------------------------------------------- |
| API Base      | `https://api.together.xyz/v1`                       |
| Env Var       | `TOGETHER_API_KEY`                                  |
| Format        | OpenAI-compatible                                   |
| Default Model | `meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo`     |

```bash
export TOGETHER_API_KEY=...
abstract "fix the tests" --model together/meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo
```

---

### Fireworks

Fast inference for open models.

| Property      | Value                                          |
| ------------- | ---------------------------------------------- |
| API Base      | `https://api.fireworks.ai/inference/v1`       |
| Env Var       | `FIREWORKS_API_KEY`                           |
| Format        | OpenAI-compatible                              |
| Default Model | `accounts/fireworks/models/llama-v3p1-70b-instruct` |

```bash
export FIREWORKS_API_KEY=fw_...
abstract "fix the tests" --model fireworks/accounts/fireworks/models/llama-v3p1-70b-instruct
```

---

### Perplexity

Search-augmented models.

| Property      | Value                           |
| ------------- | ------------------------------- |
| API Base      | `https://api.perplexity.ai`     |
| Env Var       | `PERPLEXITY_API_KEY`            |
| Format        | OpenAI-compatible               |
| Default Model | `llama-3.1-sonar-large-128k-online` |

```bash
export PERPLEXITY_API_KEY=pplx-...
abstract "fix the tests" --model perplexity/llama-3.1-sonar-large-128k-online
```

---

### Cerebras

Wafer-scale inference.

| Property      | Value                        |
| ------------- | ---------------------------- |
| API Base      | `https://api.cerebras.ai/v1` |
| Env Var       | `CEREBRAS_API_KEY`           |
| Format        | OpenAI-compatible            |
| Default Model | `llama3.1-70b`               |

```bash
export CEREBRAS_API_KEY=csk-...
abstract "fix the tests" --model cerebras/llama3.1-70b
```

---

### Ollama

Local models. No API key needed.

| Property      | Value                       |
| ------------- | --------------------------- |
| API Base      | `http://localhost:11434/v1` |
| Env Var       | (none)                      |
| Format        | OpenAI-compatible           |
| Default Model | `llama3.1`                  |

```bash
ollama pull llama3.1
abstract "fix the tests" --model ollama/llama3.1
```

Ollama must be running locally on port 11434. No API key is required.

---

### OpenRouter

Aggregator that proxies to multiple providers with a single key.

| Property      | Value                              |
| ------------- | ---------------------------------- |
| API Base      | `https://openrouter.ai/api/v1`    |
| Env Var       | `OPENROUTER_API_KEY`              |
| Format        | OpenAI-compatible                  |
| Default Model | `anthropic/claude-3.5-sonnet`     |

```bash
export OPENROUTER_API_KEY=sk-or-...
abstract "fix the tests" --model openrouter/anthropic/claude-3.5-sonnet
```

---

### Auto-Detection

When you pass a bare model name (no `/`), the router auto-detects the provider:

| Prefix                     | Provider                                                 |
| -------------------------- | -------------------------------------------------------- |
| `claude-*`                 | anthropic                                                |
| `gpt-*`, `o1*`, `o3*`      | openai                                                   |
| `gemini-*`                 | google                                                   |
| `mistral-*`, `codestral-*` | mistral                                                  |
| `deepseek-*`               | deepseek                                                 |
| `grok-*`                   | xai                                                      |
| `llama*`                   | groq (if `GROQ_API_KEY` set), else together, else ollama |

If no prefix matches, the router picks the first provider with a valid API key in the environment.

### Aliases

The Abstract CLI supports short aliases:

| Alias         | Resolves To                     |
| ------------- | ------------------------------- |
| `opus`        | `anthropic/claude-opus-4-6`     |
| `sonnet`      | `anthropic/claude-sonnet-4-6`   |
| `haiku`       | `anthropic/claude-haiku-4-5`    |
| `4o`, `gpt4o` | `openai/gpt-4o`                 |
| `gemini`      | `google/gemini-3.1-pro-preview` |
| `llama`       | `groq/llama-3.1-70b-versatile`  |
| `deepseek`    | `deepseek/deepseek-chat`        |
| `grok`        | `xai/grok-2`                    |
| `mistral`     | `mistral/mistral-large-latest`  |

---

### Adding Custom Providers

Any OpenAI-compatible endpoint works with the OpenAI provider directly:

```rust
let provider = OpenAi::builder()
    .base_url("https://my-custom-api.com/v1")
    .api_key("my-key")
    .model("my-model")
    .build()?;

let output = Agent::builder()
    .provider(provider)
    .tools(cersei::tools::coding())
    .run_with("fix the tests")
    .await?;
```

For the CLI, any OpenAI-compatible provider's base URL can be overridden with a `<PROVIDER>_BASE_URL` environment variable. The provider id is upper-cased, so:

| Provider                        | Override variable                                   |
| ------------------------------- | --------------------------------------------------- |
| `openai`                        | `OPENAI_BASE_URL` (legacy alias: `OPENAI_API_BASE`) |
| `deepseek`                      | `DEEPSEEK_BASE_URL`                                 |
| `openrouter`                    | `OPENROUTER_BASE_URL`                               |
| …any OpenAI-compatible provider | `<ID>_BASE_URL`                                     |

```bash
# Route the OpenAI provider at any OpenAI-compatible gateway:
OPENAI_API_KEY=my-key OPENAI_BASE_URL=https://my-custom-api.com/v1 \
  abstract "fix the tests" --provider openai --model my-model
```

When an override is in effect, Abstract prints a redacted target line before the first request — e.g. `provider=openai host=my-custom-api.com model=my-model key_present=true` — so a misrouted endpoint is obvious instead of surfacing as an opaque `401`. If you intend to talk to DeepSeek, prefer `--provider deepseek` with `DEEPSEEK_API_KEY`; only use the `openai` provider + `OPENAI_BASE_URL` route for endpoints without a dedicated provider entry.

---

## API: Types  (/docs/api-types)

cersei-types provides "provider-agnostic types shared across all Cersei crates."

### Message

The `Message` struct contains a role, content, and optional metadata. Roles include User, Assistant, and System variants. Helper constructors are available:

```rust
Message::user("Hello")
Message::assistant("Hi there!")
Message::system("You are helpful.")
message.get_text()  // -> Option<&str>
```

### ContentBlock

This enum represents different content types within messages:

```rust
pub enum ContentBlock {
    Text { text: String },
    Image { source: ImageSource, media_type: String },
    ToolUse { id: String, name: String, input: Value },
    ToolResult { tool_use_id: String, content: String, is_error: bool },
    Thinking { thinking: String },
    Document { source: String, media_type: String },
    Opaque(Value),
}
```

### Usage

Token usage information is tracked via:

```rust
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_input_tokens: u64,
    pub cache_read_input_tokens: u64,
    pub cost_usd: Option<f64>,
}
```

The struct supports merging: `usage.merge(&other_usage);`

### StopReason

Completion termination reasons are represented by four variants: EndTurn, MaxTokens, ToolUse, and StopSequence.

### StreamEvent

Events emitted during streaming include MessageStart, ContentBlockStart, TextDelta, InputJsonDelta, ThinkingDelta, ContentBlockStop, MessageDelta, MessageStop, Ping, and Error variants.

### CerseiError

Error types include Auth, Provider, Tool, Memory, Http, Json, Io, Cancelled, and Other variants. All implement the standard Error trait.

---

## API: Provider  (/docs/api-provider)

### cersei-provider

"Abstraction over LLM backends. Every provider implements streaming completion, token counting, and capability discovery."

### Provider Trait

```rust
#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &str;
    fn context_window(&self, model: &str) -> u64;
    fn capabilities(&self, model: &str) -> ProviderCapabilities;
    async fn complete(&self, request: CompletionRequest) -> Result<CompletionStream>;
    async fn complete_blocking(&self, request: CompletionRequest) -> Result<CompletionResponse>;
    async fn count_tokens(&self, messages: &[Message], model: &str) -> Result<u64>;
}
```

### Anthropic

```rust
// From environment variable
let provider = Anthropic::from_env()?;

// With explicit key
let provider = Anthropic::new(Auth::ApiKey("sk-ant-...".into()));

// Builder
let provider = Anthropic::builder()
    .api_key("sk-ant-...")
    .model("claude-sonnet-4-6")
    .thinking(8192)
    .build()?;
```

"Default model: `claude-sonnet-4-6`. Context window: 200,000 tokens." Supports streaming, tool use, vision, extended thinking, and prompt caching capabilities.

### OpenAI

```rust
// From environment variable
let provider = OpenAi::from_env()?;

// Builder (Ollama, Azure, vLLM, etc.)
let provider = OpenAi::builder()
    .base_url("http://localhost:11434/v1")
    .model("llama3.1:70b")
    .api_key("ollama")
    .build()?;
```

"Compatible with any OpenAI-format API. Default model: `gpt-4o`."

### Auth

```rust
pub enum Auth {
    ApiKey(String),
    Bearer(String),
    OAuth { client_id: String, token: OAuthToken },
    Custom(Arc<dyn AuthProvider>),
}
```

### CompletionRequest

```rust
pub struct CompletionRequest {
    pub model: String,
    pub messages: Vec<Message>,
    pub system: Option<String>,
    pub tools: Vec<ToolDefinition>,
    pub max_tokens: u32,
    pub temperature: Option<f32>,
    pub stop_sequences: Vec<String>,
    pub options: ProviderOptions,
}
```

### Custom Provider

"Implement `Provider` for any LLM backend:"

```rust
struct MyProvider;

#[async_trait]
impl Provider for MyProvider {
    fn name(&self) -> &str { "my-llm" }
    fn context_window(&self, _model: &str) -> u64 { 128_000 }
    fn capabilities(&self, _model: &str) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            tool_use: true,
            ..Default::default()
        }
    }
    async fn complete(&self, request: CompletionRequest) -> Result<CompletionStream> {
        // Your implementation here
    }
}
```

---

## API: Tools  (/docs/api-tools)

cersei-tools is a "tool execution system with 34 built-in tools, a granular permission model, a bash command safety classifier, and skill discovery."

### Tool Trait

Every tool implements a standard interface. The `#[derive(Tool)]` macro generates boilerplate code automatically.

```rust
#[async_trait]
pub trait Tool: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> &str;
    fn input_schema(&self) -> Value;
    fn permission_level(&self) -> PermissionLevel { PermissionLevel::None }
    fn category(&self) -> ToolCategory { ToolCategory::Custom }
    async fn execute(&self, input: Value, ctx: &ToolContext) -> ToolResult;
}
```

### ToolResult

Results are reported via three primary methods:

- `ToolResult::success(content)` — Successful execution returned to the model
- `ToolResult::error(content)` — Execution failure; model can retry or adapt
- `.with_metadata(value)` — Attach structured metadata for event tracking

### ToolContext

Passed to every tool execution, providing:

- `working_dir` — Current working directory for file operations
- `session_id` — Active session identifier
- `permissions` — Permission checker for access control
- `cost_tracker` — Token and cost tracking
- `mcp_manager` — Optional MCP server connections
- `extensions` — Type-map for injecting custom data

### Built-in Tool Sets

Convenience functions return pre-configured collections:

| Function | Count | Contents |
|----------|-------|----------|
| `cersei::tools::all()` | 34 | Everything |
| `cersei::tools::coding()` | 10 | Filesystem, shell, web |
| `cersei::tools::filesystem()` | 6 | File operations |
| `cersei::tools::shell()` | 2 | Bash, PowerShell |
| `cersei::tools::web()` | 2 | Fetch, search |
| `cersei::tools::planning()` | 3 | Planning utilities |
| `cersei::tools::scheduling()` | 5 | Cron and timers |
| `cersei::tools::orchestration()` | 9 | Task management |
| `cersei::tools::none()` | 0 | Empty collection |

### Tool Catalog

**Filesystem:** FileReadTool, FileWriteTool, FileEditTool, GlobTool, GrepTool, NotebookEditTool

**Shell:** BashTool (persistent state), PowerShellTool

**Web:** WebFetchTool, WebSearchTool (requires `CERSEI_SEARCH_API_KEY`)

**Planning:** EnterPlanModeTool, ExitPlanModeTool, TodoWriteTool

**Scheduling:** CronCreateTool, CronListTool, CronDeleteTool, SleepTool, RemoteTriggerTool

**Orchestration:** SendMessageTool, TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool, TaskStopTool, TaskOutputTool, EnterWorktreeTool, ExitWorktreeTool

### Custom Tools

#### With Derive Macro

The fastest approach uses `#[derive(Tool)]` with a `ToolExecute` implementation:

```rust
#[derive(Tool)]
#[tool(name = "search", description = "Search docs", permission = "read_only")]
struct SearchTool;

#[async_trait]
impl ToolExecute for SearchTool {
    type Input = SearchInput;
    async fn run(&self, input: SearchInput, ctx: &ToolContext) -> ToolResult {
        // Implementation here
    }
}

#[derive(Deserialize, JsonSchema)]
struct SearchInput {
    query: String,
    #[serde(default = "default_limit")]
    limit: usize,
}
```

Supported derive attributes: `name`, `description`, `permission` (none/read_only/write/execute/dangerous).

#### Manual Implementation

For full control, implement `Tool` directly without the macro.

### Registration

```rust
let agent = Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::coding())
    .tool(SearchTool)
    .tool(ManualTool)
    .build()?;
```

### Permission Levels

Six permission levels exist:

- **None** — Always allowed (planning, sleep)
- **ReadOnly** — File reads, searches, no side effects
- **Write** — File creation, reversible changes
- **Execute** — Shell commands, task creation
- **Dangerous** — Destructive operations requiring approval
- **Forbidden** — Never allowed

### Built-in Policies

- `AllowAll` — Permit everything
- `AllowReadOnly` — Only None and ReadOnly tools
- `DenyAll` — Block all access
- `RuleBased::new(rules)` — Custom matching rules
- `InteractivePolicy::new(handler)` — Callback-based decisions

### Bash Classifier

The `BashTool` automatically classifies shell commands:

- Safe reads: `ls`, `cat`, `head` → ReadOnly
- Safe writes: `echo`, `cp`, `mv` → Write
- Builds: `npm install`, `cargo build` → Execute
- Destructive: `rm -rf`, `dd`, `mkfs` → Dangerous
- Forbidden: `shutdown`, `reboot` → Forbidden

### Skills Discovery

The `SkillTool` discovers prompt templates from:

- `.claude/commands/*.md` (Claude Code format)
- `.claude/skills/*/SKILL.md` (OpenCode format)
- `~/.claude/commands/*.md` (user-level global)
- Bundled skills: simplify, debug, commit, verify, stuck, remember, loop

Skills support `$ARGUMENTS` template expansion.

### Shell State Persistence

`BashTool` and `PowerShellTool` maintain working directory and environment variables across invocations within a session. Call `clear_session_shell_state(id)` to reset.

---

## API: Agent  (/docs/api-agent)

### Overview

The cersei-agent crate provides a high-level Agent API with builder pattern configuration, an agentic loop for tool dispatch and multi-turn conversations, a 26-variant event system, and automatic context management.

### Agent Builder

Every agent begins with a builder, requiring only a `.provider()` method:

```rust
let agent = Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::coding())
    .system_prompt("You are a coding assistant.")
    .model("claude-sonnet-4-6")
    .max_turns(10)
    .max_tokens(16384)
    .permission_policy(AllowAll)
    .build()?;
```

#### Key Builder Methods

- `.provider(p)` — LLM backend (required)
- `.tool(t)` / `.tools(vec)` — Register tools
- `.system_prompt(s)` — Static cached prompt
- `.append_system_prompt(s)` — Dynamic per-turn additions
- `.model(s)` — Model identifier
- `.max_turns(n)` — Loop iteration limit (default: 5)
- `.max_tokens(n)` — Output tokens per call (default: 16384)
- `.temperature(t)` — Sampling temperature
- `.thinking_budget(n)` — Extended thinking tokens
- `.working_dir(p)` — File/shell command directory
- `.permission_policy(p)` — Tool execution controls
- `.memory(m)` — Session persistence backend
- `.session_id(s)` — Session identifier
- `.hook(h)` — Lifecycle middleware
- `.on_event(f)` — Synchronous event callback
- `.enable_broadcast(cap)` — Enable broadcast channel
- `.auto_compact(b)` — Context summarization
- `.compact_threshold(f)` — Compaction trigger point (default: 0.9)
- `.tool_result_budget(n)` — Truncate old results
- `.cancel_token(t)` — External cancellation signal
- `.mcp_server(cfg)` — MCP server connection

### Execution Modes

#### One-Shot (Shorthand)

```rust
let output = Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::coding())
    .run_with("Fix the failing tests")
    .await?;

println!("{}", output.text());
println!("Turns: {}, Tool calls: {}", output.turns, output.tool_calls.len());
```

#### Blocking (Reusable Agent)

```rust
let agent = Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::coding())
    .build()?;

let output1 = agent.run("What files are in src/?").await?;
let output2 = agent.run("Now fix the bug in main.rs").await?;
```

#### Streaming (Real-Time Events)

```rust
let mut stream = agent.run_stream("Deploy the application");

while let Some(event) = stream.next().await {
    match event {
        AgentEvent::TextDelta(t) => print!("{t}"),
        AgentEvent::ThinkingDelta(t) => { /* thinking */ }
        AgentEvent::ToolStart { name, input, .. } => {
            eprintln!("\n[Tool: {name}]");
        }
        AgentEvent::ToolEnd { name, duration, is_error, .. } => {
            let status = if is_error { "FAIL" } else { "OK" };
            eprintln!("[{name}: {status} in {}ms]", duration.as_millis());
        }
        AgentEvent::PermissionRequired(req) => {
            stream.respond_permission(req.id, PermissionDecision::Allow);
        }
        AgentEvent::Complete(output) => {
            eprintln!("\nDone: {} turns", output.turns);
            break;
        }
        AgentEvent::Error(msg) => {
            eprintln!("Error: {msg}");
            break;
        }
        _ => {}
    }
}
```

### AgentOutput

Returned by execution methods:

```rust
pub struct AgentOutput {
    pub message: Message,
    pub usage: Usage,
    pub stop_reason: StopReason,
    pub turns: u32,
    pub tool_calls: Vec<ToolCallRecord>,
}
```

Access results:
```rust
let text = output.text();

for call in &output.tool_calls {
    println!("{}: {}ms (error: {})", call.name, call.duration.as_millis(), call.is_error);
}
```

### AgentEvent Variants

#### Content Events

- `TextDelta(String)` — Text token streamed from model
- `ThinkingDelta(String)` — Thinking token from extended thinking

#### Tool Events

- `ToolStart { name, id, input }` — Tool dispatch begins
- `ToolEnd { name, id, result, is_error, duration }` — Tool execution completes

#### Lifecycle Events

- `TurnComplete { turn, usage }` — Model call + tool cycle finishes
- `TokenWarning { pct_used, state }` — Context window approaching limit
- `CompactStart { reason }` — Compaction begins
- `CompactEnd { messages_after, tokens_freed }` — Compaction finishes
- `SessionLoaded { session_id, message_count }` — Session resumed from memory

#### Control Events

- `PermissionRequired(PermissionRequest)` — Tool needs approval
- `CostUpdate { ... }` — Token counts after model call
- `SubAgentSpawned { agent_id, prompt }` — Sub-agent created
- `SubAgentComplete { agent_id, result }` — Sub-agent finished

#### Terminal Events

- `Status(String)` — Informational update
- `Error(String)` — Unrecoverable error
- `Complete(AgentOutput)` — Agent loop finished

### AgentStream Methods

- `next()` — Receive next event
- `respond_permission(request_id, decision)` — Answer permission request
- `cancel()` — Signal agent to stop after current turn
- `inject_message(message)` — Insert user message mid-stream
- `collect()` — Consume all events and return final output
- `collect_text()` — Return concatenated text deltas

### Effort Levels

Control thinking and temperature via single setting:

```rust
use cersei_agent::effort::EffortLevel;

let effort = EffortLevel::from_str("max");
let budget = effort.thinking_budget_tokens();  // 32768
let temp = effort.temperature();               // Some(1.0)
```

Levels:
- **Low**: 1024 tokens, temp 0.3
- **Medium**: Default temp (general-purpose, default setting)
- **High**: 8192 tokens, default temp
- **Max**: 32768 tokens, temp 1.0

### Auto-Compact

Automatically summarizes older messages when approaching context limits:

```rust
Agent::builder()
    .auto_compact(true)
    .compact_threshold(0.9)
    .tool_result_budget(50_000)
```

Pipeline:
1. Count conversation tokens
2. Group old messages by topic if above threshold
3. Summarize each group via LLM
4. Replace originals with summaries
5. Truncate tool results above budget

Emits: `CompactStart`, `CompactEnd` events

### System Prompt Caching

The system prompt splits at `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`:

```rust
Agent::builder()
    .system_prompt("You are a coding assistant. Always use Rust.")
    .append_system_prompt("Current time: 2024-01-01")
```

Static section (before boundary) is cached by providers; dynamic section rebuilds per turn. Anthropic's prompt caching reduces tokens and latency on multi-turn conversations.

---

## API: Memory  (/docs/api-memory)

### Overview

cersei-memory is a "three-tier memory system designed to outperform Claude Code's file-based approach." The system combines graph-based recall with traditional flat file storage and hierarchical instruction loading.

### Core Architecture

The system operates across three tiers:

1. **Graph Memory (Grafeo)** — Relationship-aware indexed recall operating at microsecond speeds
2. **Flat Files (memdir)** — Compatible with Claude Code's markdown-based memory format
3. **CLAUDE.md Hierarchy** — Multi-level instruction loading with session transcripts

### MemoryManager Interface

The `MemoryManager` provides unified access to all three tiers. Key constructor options include `.with_graph()` for persistent storage, `.with_graph_in_memory()` for testing, and path overrides for memory and session directories.

Primary methods include:
- `build_context()` — Generates complete system prompt section
- `recall(query, limit)` — Query-based retrieval with graph-first approach
- `by_type()` and `by_topic()` — Filtered retrieval operations
- `store_memory()`, `tag_memory()`, `link_memories()` — Graph write operations

### Performance Characteristics

Graph-based recall achieves "92.5% faster" performance than text-matching alternatives. Indexed queries complete in approximately 98 microseconds, while bulk node storage averages 86 microseconds per node.

### Memory Types

The system supports four categorized memory types: User (role/preferences), Feedback (guidance), Project (deadlines/facts), and Reference (external system pointers).

### Session and Consolidation Features

Sessions store append-only JSONL transcripts with support for messages, summaries, and soft-delete markers. The Auto-Dream system performs background consolidation based on time elapsed, session count, and lock availability. Memory extraction from conversations triggers automatically after 20+ messages with 3+ tool calls.

---

## API: Hooks  (/docs/api-hooks)

Hooks intercept agent lifecycle events — pre/post tool use, model turns, and custom events.

### Hook Trait

```rust
#[async_trait]
pub trait Hook: Send + Sync {
    fn name(&self) -> &str;
    fn events(&self) -> &[HookEvent];
    async fn on_event(&self, ctx: &HookContext) -> HookAction;
}
```

### HookEvent

```rust
pub enum HookEvent {
    PreToolUse,
    PostToolUse,
    PreModelTurn,
    PostModelTurn,
}
```

### HookAction

```rust
pub enum HookAction {
    Continue,
    Block(String),
    ModifyInput(Value),
}
```

### Examples

#### Cost Guard

```rust
pub struct CostGuard { pub max_usd: f64 }

#[async_trait]
impl Hook for CostGuard {
    fn name(&self) -> &str { "cost-guard" }
    fn events(&self) -> &[HookEvent] { &[HookEvent::PostToolUse] }

    async fn on_event(&self, ctx: &HookContext) -> HookAction {
        if ctx.cumulative_cost_usd() > self.max_usd {
            HookAction::Block(format!("Cost limit ${:.2} exceeded", self.max_usd))
        } else {
            HookAction::Continue
        }
    }
}
```

#### Audit Logger

```rust
pub struct AuditLogger;

#[async_trait]
impl Hook for AuditLogger {
    fn name(&self) -> &str { "audit" }
    fn events(&self) -> &[HookEvent] { &[HookEvent::PreToolUse, HookEvent::PostToolUse] }

    async fn on_event(&self, ctx: &HookContext) -> HookAction {
        eprintln!("[audit] {} tool={}", ctx.event, ctx.tool_name.as_deref().unwrap_or("?"));
        HookAction::Continue
    }
}
```

#### Tool Blocker

```rust
pub struct BlockDangerous;

#[async_trait]
impl Hook for BlockDangerous {
    fn name(&self) -> &str { "block-dangerous" }
    fn events(&self) -> &[HookEvent] { &[HookEvent::PreToolUse] }

    async fn on_event(&self, ctx: &HookContext) -> HookAction {
        if ctx.tool_name.as_deref() == Some("Bash") {
            if let Some(cmd) = ctx.tool_input.get("command").and_then(|v| v.as_str()) {
                if cmd.contains("rm -rf") {
                    return HookAction::Block("Destructive command blocked".into());
                }
            }
        }
        HookAction::Continue
    }
}
```

#### Shell Hooks

Execute shell commands at hook points:

```rust
use cersei_hooks::ShellHook;

let hook = ShellHook::new("notify", HookEvent::PostToolUse, "echo 'Tool used'");
```

### Registration

```rust
Agent::builder()
    .hook(CostGuard { max_usd: 5.0 })
    .hook(AuditLogger)
    .hook(BlockDangerous)
    .build()?;
```

"Hooks fire in registration order. A Block action stops the pipeline."

---

## API: MCP  (/docs/api-mcp)

MCP (Model Context Protocol) client for connecting to external tool servers.

### McpServerConfig

```rust
// Stdio transport
let config = McpServerConfig::stdio("db", "npx", &["-y", "@my/db-mcp"]);

// With environment variables
let mut config = McpServerConfig::stdio("github", "npx", &["@modelcontextprotocol/server-github"]);
config.env.insert("GITHUB_TOKEN".into(), "ghp_...".into());
```

### McpManager

```rust
let mcp = McpManager::connect(&[
    McpServerConfig::stdio("db", "npx", &["-y", "@my/db-mcp"]),
    McpServerConfig::stdio("docs", "npx", &["-y", "@my/docs-mcp"]),
]).await?;

// Get tool definitions for the agent
let tools = mcp.tool_definitions().await;

// Use with agent
Agent::builder()
    .tools(tools)
    .mcp_server(McpServerConfig::stdio("db", "npx", &["-y", "@my/db-mcp"]))
    .build()?;
```

### Protocol

* JSON-RPC 2.0 over stdio (stdin/stdout)
* Tool discovery via `tools/list`
* Tool execution via `tools/call`
* Resource enumeration via `resources/list`
* Environment variable expansion in server configs

### Integration with Agent

```rust
Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::coding())
    .mcp_server(McpServerConfig::stdio("db", "npx", &["-y", "@my/db-mcp"]))
    .build()?;
```

MCP tools are merged with built-in tools. The agent can invoke both interchangeably.


---

# Built-in Tools & Code Intelligence

## Built-in Tools (/docs/built-in-tools)

# Built-in Tools Reference

35 tools across 6 categories. Each tool is available via the composition functions in `cersei::tools`.

```rust
cersei::tools::all()           // all 35
cersei::tools::coding()        // filesystem + shell + web (11)
cersei::tools::filesystem()    // 6 tools
cersei::tools::shell()         // 2 tools
cersei::tools::web()           // 3 tools
cersei::tools::planning()      // 3 tools
cersei::tools::scheduling()    // 5 tools
cersei::tools::orchestration() // 9 tools
```

### Filesystem

#### Read

Read a file with optional line offset and limit. Returns content with line numbers.

**Permission:** ReadOnly

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| file_path | string | Absolute path to the file. | Yes |
| offset | integer | Line number to start reading from (0-based). | No |
| limit | integer | Number of lines to read. (Default: 2000) | No |

#### Write

Write content to a file, creating parent directories if they don't exist.

**Permission:** Write

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| file_path | string | Absolute path to the file. | Yes |
| content | string | Content to write. | Yes |

#### Edit

Exact string replacement in a file. Fails if the old string is not unique (unless `replace_all` is true).

**Permission:** Write

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| file_path | string | Absolute path to the file. | Yes |
| old_string | string | The text to find and replace. | Yes |
| new_string | string | The replacement text. | Yes |
| replace_all | boolean | Replace all occurrences instead of requiring uniqueness. (Default: false) | No |

#### Glob

Find files matching a glob pattern, sorted by path.

**Permission:** ReadOnly

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| pattern | string | Glob pattern (e.g., "**/*.rs", "src/**/*.ts"). | Yes |
| path | string | Directory to search in. (Default: working directory) | No |

#### Grep

Search file contents using regex. Uses ripgrep if available, falls back to system grep.

**Permission:** ReadOnly

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| pattern | string | Regex pattern to search for. | Yes |
| path | string | File or directory to search in. (Default: working directory) | No |
| glob | string | Glob pattern to filter files (e.g., "*.rs"). | No |

#### NotebookEdit

Edit a Jupyter notebook cell by index.

**Permission:** Write

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| file_path | string | Path to .ipynb file. | Yes |
| cell_index | integer | 0-based cell index to edit. | Yes |
| new_source | string | New cell source content. | Yes |
| cell_type | string | Cell type: "code" or "markdown". | No |

### Shell

#### Bash

Execute a shell command. Working directory and environment variables persist across calls within a session.

**Permission:** Execute

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| command | string | The bash command to execute. | Yes |
| timeout | integer | Timeout in milliseconds. (Default: 120000, max 600000) | No |

The bash classifier automatically analyzes commands for risk level. Destructive commands (`rm -rf /`, `dd`, fork bombs) are blocked regardless of permission policy.

#### PowerShell

Execute a PowerShell command. Uses `pwsh` on macOS/Linux.

**Permission:** Execute

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| command | string | PowerShell command to execute. | Yes |
| timeout | integer | Timeout in milliseconds. (Default: 120000) | No |

### Web

#### WebFetch

Fetch a URL and return readable text. HTML is converted to plain text via `html2text`.

**Permission:** ReadOnly

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| url | string | The URL to fetch. | Yes |
| max_chars | integer | Maximum characters to return. (Default: 50000) | No |

#### WebSearch

Search the web via an API (Brave Search by default). Requires `CERSEI_SEARCH_API_KEY`.

**Permission:** ReadOnly

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| query | string | Search query. | Yes |
| num_results | integer | Number of results to return. (Default: 8, max 20) | No |

#### ExaSearch

AI-powered web search using Exa. Returns structured results with optional text content, highlights, and summaries. Requires `EXA_API_KEY`.

**Permission:** ReadOnly

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| query | string | Search query. | Yes |
| search_type | "auto" \| "neural" \| "fast" | Search method. (Default: auto) | No |
| num_results | integer | Number of results to return. (Default: 10, max 100) | No |
| category | string | Focus category: company, research paper, news, personal site, financial report, people. | No |
| content_mode | "text" \| "highlights" \| "summary" \| "all" | Content to retrieve with results. (Default: highlights) | No |
| max_characters | integer | Max characters for text/highlight content per result. | No |
| include_domains | string[] | Only include results from these domains. | No |
| exclude_domains | string[] | Exclude results from these domains. | No |
| start_published_date | string | Earliest publication date (ISO 8601). | No |
| end_published_date | string | Latest publication date (ISO 8601). | No |
| user_location | string | Two-letter ISO country code for location bias. | No |

### Planning

#### EnterPlanMode

Switch to plan mode — restricts the agent to read-only tools for safe exploration.

**Permission:** None. No input required.

#### ExitPlanMode

Exit plan mode and return to full tool access.

**Permission:** None. No input required.

#### TodoWrite

Create and manage a structured task list with status tracking.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| todos | array | The complete updated todo list. | Yes |
| todos[].content | string | Task description in imperative form (e.g., "Fix the tests"). | Yes |
| todos[].status | "pending" \| "in_progress" \| "completed" | Current task state. | Yes |
| todos[].activeForm | string | Present continuous form (e.g., "Fixing the tests"). | Yes |

### Scheduling

#### CronCreate

Schedule a recurring or one-shot prompt.

**Permission:** Execute

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| schedule | string | Cron expression (e.g., "*/5 * * * *") or one-shot (e.g., "once:30s"). | Yes |
| prompt | string | The prompt to execute on each trigger. | Yes |

#### CronList

List all scheduled jobs with run counts.

**Permission:** None. No input required.

#### CronDelete

Delete a scheduled job by ID.

**Permission:** Execute

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| id | string | Cron job ID to delete. | Yes |

#### Sleep

Pause execution for a duration.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| duration_ms | integer | Milliseconds to sleep. (Default: max 60000) | Yes |

#### RemoteTrigger

Send an event to another session or agent.

**Permission:** Execute

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| target_session | string | Target session ID. | Yes |
| event_type | string | Event type identifier. | Yes |
| payload | any | Event payload (any valid JSON). | No |

### Orchestration

#### SendMessage

Send a message to another agent or session.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| to | string | Target session or agent ID. | Yes |
| content | string | Message content. | Yes |

#### TaskCreate

Create a new task for tracking work.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| description | string | What this task does. | Yes |
| prompt | string | Optional prompt for a sub-agent. | No |

#### TaskGet

Get a task's current status, description, and output.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| id | string | Task ID. | Yes |

#### TaskUpdate

Update a task's status and/or output.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| id | string | Task ID. | Yes |
| status | "pending" \| "running" \| "completed" \| "failed" \| "stopped" | New status. | No |
| output | string | Task result text. | No |

#### TaskList

List all tasks with their status.

**Permission:** None. No input required.

#### TaskStop

Stop a running task.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| id | string | Task ID to stop. | Yes |

#### TaskOutput

Get the full output of a completed task.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| id | string | Task ID. | Yes |

#### EnterWorktree

Create an isolated git worktree for parallel branch work.

**Permission:** Write

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| branch | string | Branch name to create and check out. | Yes |
| path | string | Directory for the worktree. (Default: /tmp/cersei-wt-{branch}) | No |

#### ExitWorktree

Remove a git worktree and return to the original working directory.

**Permission:** Write

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| path | string | Worktree directory to remove. | Yes |

### Other

#### AskUserQuestion

Ask the user a question and wait for their response.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| question | string | The question to ask. | Yes |

#### SyntheticOutput

Return structured JSON for programmatic consumption. Used by coordinator mode and SDK integrations.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| data | any | Structured data to return (any valid JSON). | Yes |

#### Config

Read or modify session-scoped configuration values.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| action | "get" \| "set" \| "list" | Action to perform. | Yes |
| key | string | Config key (for get/set). | No |
| value | any | Value to set. | No |

#### Skill

Load and execute a skill (prompt template) from `.claude/commands/`, `.claude/skills/`, or bundled skills.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| skill | string | Skill name, or "list" to show available skills. | Yes |
| args | string | Arguments passed to the skill (replaces $ARGUMENTS in template). | No |

#### ToolSearch

Search for available tools by keyword.

**Permission:** None

| Parameter | Type | Description | Required |
|-----------|------|-------------|----------|
| query | string | Search query (matches tool names and descriptions). | Yes |

### Permission Summary

| Level | Tools |
|-------|-------|
| **None** (18) | EnterPlanMode, ExitPlanMode, TodoWrite, CronList, Sleep, SendMessage, TaskCreate, TaskGet, TaskUpdate, TaskList, TaskStop, TaskOutput, AskUserQuestion, SyntheticOutput, Config, Skill, ToolSearch |
| **ReadOnly** (7) | Read, Glob, Grep, WebFetch, WebSearch, ExaSearch |
| **Write** (5) | Write, Edit, NotebookEdit, EnterWorktree, ExitWorktree |
| **Execute** (5) | Bash, PowerShell, CronCreate, CronDelete, RemoteTrigger |

## Code Intelligence (/docs/code-intelligence)

# Code & AST Intelligence

Cersei provides two layers of code intelligence available as both SDK library APIs and agent tools:

* **`cersei-lsp`** — Language Server Protocol client for semantic operations (hover, definitions, references, symbols, diagnostics)
* **Tree-sitter modules** in `cersei-tools` — AST-based import extraction, symbol discovery, dependency ranking, and bash command safety analysis

Both are used by Abstract CLI to give the agent deep understanding of codebases without reading every file.

---

### `cersei-lsp` Crate

A standalone LSP client crate with on-demand server management. Spawns language servers lazily on first file access, communicates via JSON-RPC 2.0 over stdio.

#### Installation

```toml
[dependencies]
cersei-lsp = "0.1.6"
```

#### Architecture

```
LspManager (multi-server registry)
├── LspClient (rust-analyzer) ── JSON-RPC ── rust-analyzer process
├── LspClient (pyright) ── JSON-RPC ── pyright-langserver process
└── LspClient (gopls) ── JSON-RPC ── gopls process
```

* **`LspManager`** routes files to the correct server by extension
* **`LspClient`** manages a single server process with async I/O
* Servers start on first file access and persist for the session
* 13 built-in server configs, extensible with custom configs

#### Quick Start

```rust
use cersei_lsp::{LspManager, LspServerConfig};
use std::path::Path;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut mgr = LspManager::new("/path/to/project");
    mgr.register_builtins(); // Register 13 built-in servers

    // Hover: get type info at a position
    let hover = mgr.hover(Path::new("src/main.rs"), 10, 5).await?;
    println!("Hover: {:?}", hover);

    // Go-to-definition
    let defs = mgr.definition(Path::new("src/lib.rs"), 25, 12).await?;
    for loc in &defs {
        println!("Defined at: {loc}");
    }

    // Find all references
    let refs = mgr.references(Path::new("src/lib.rs"), 25, 12).await?;
    println!("Found {} references", refs.len());

    // Document symbols (file outline)
    let symbols = mgr.document_symbols(Path::new("src/lib.rs")).await?;
    for sym in &symbols {
        print!("{}", sym.format(0)); // Indented tree output
    }

    // Diagnostics (compiler errors/warnings)
    let diags = mgr.diagnostics(Path::new("src/main.rs")).await?;
    println!("{}", LspManager::format_diagnostics(&diags));

    mgr.shutdown_all().await;
    Ok(())
}
```

#### API Reference

##### `LspServerConfig`

| Field | Description | Type | Default |
|-------|-------------|------|---------|
| name | Display name (e.g. "rust-analyzer") | String | |
| command | Binary to spawn | String | |
| args | CLI arguments | Vec<String> | [] |
| file_patterns | Glob patterns this server handles | Vec<String> | |
| extension_to_language | Map file ext to LSP language ID | HashMap<String, String> | |
| env | Extra environment variables | HashMap<String, String> | {} |
| initialization_options | Options sent during LSP initialize | Option<Value> | None |

##### `LspManager`

| Method | Signature | Description |
|--------|-----------|-------------|
| `new` | `fn new(working_dir: impl Into<PathBuf>) -> Self` | Create manager for a project |
| `register_builtins` | `fn register_builtins(&mut self)` | Register 13 built-in servers |
| `register_server` | `fn register_server(&mut self, config: LspServerConfig)` | Add a custom server |
| `has_server_for` | `fn has_server_for(&self, path: &Path) -> bool` | Check if a server handles this file type |
| `hover` | `async fn hover(&mut self, path, line, col) -> LspResult<Option<String>>` | Get hover info (0-based) |
| `definition` | `async fn definition(&mut self, path, line, col) -> LspResult<Vec<String>>` | Go-to-definition locations |
| `references` | `async fn references(&mut self, path, line, col) -> LspResult<Vec<String>>` | Find all references |
| `document_symbols` | `async fn document_symbols(&mut self, path) -> LspResult<Vec<SymbolInfo>>` | File outline |
| `diagnostics` | `async fn diagnostics(&mut self, path) -> LspResult<Vec<LspDiagnostic>>` | Compiler errors/warnings |
| `shutdown_all` | `async fn shutdown_all(&self)` | Gracefully stop all servers |

##### `LspClient`

Low-level client for a single server. Usually accessed through `LspManager`, but available for direct use:

```rust
use cersei_lsp::{LspClient, LspServerConfig};

let config = LspServerConfig::new(
    "rust-analyzer", "rust-analyzer",
    &["*.rs"], &[(".rs", "rust")]
);
let client = LspClient::new(config);
client.start(Path::new("/project")).await?;
client.initialize().await?;
client.open_document(Path::new("/project/src/main.rs")).await?;

let hover = client.hover(Path::new("/project/src/main.rs"), 10, 5).await?;
client.shutdown().await?;
```

#### Types

```rust
// Symbol from document_symbols()
pub struct SymbolInfo {
    pub name: String,      // e.g. "Config"
    pub kind: String,      // e.g. "struct", "function", "class"
    pub range: Range,      // Start/end position
    pub children: Vec<SymbolInfo>, // Nested symbols (methods, fields)
}

// Diagnostic from diagnostics()
pub struct LspDiagnostic {
    pub file: String,
    pub line: u32,          // 0-based
    pub col: u32,           // 0-based
    pub severity: DiagnosticSeverity, // Error, Warning, Information, Hint
    pub message: String,
    pub source: Option<String>,  // e.g. "rustc", "clippy"
    pub code: Option<String>,    // e.g. "E0308"
}
```

#### Built-in Server Configs

| Server | Command | Extensions | Language ID |
|--------|---------|-----------|-------------|
| rust-analyzer | `rust-analyzer` | `.rs` | rust |
| pyright | `pyright-langserver` | `.py`, `.pyi` | python |
| typescript-language-server | `typescript-language-server --stdio` | `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs` | typescript, javascript |
| gopls | `gopls` | `.go` | go |
| clangd | `clangd` | `.c`, `.h`, `.cpp`, `.hpp`, `.cc`, `.cxx` | c, cpp |
| ruby-lsp | `ruby-lsp --stdio` | `.rb` | ruby |
| phpactor | `phpactor language-server` | `.php` | php |
| lua-language-server | `lua-language-server --stdio` | `.lua` | lua |
| bash-language-server | `bash-language-server start` | `.sh`, `.bash` | shellscript |
| sourcekit-lsp | `sourcekit-lsp` | `.swift` | swift |
| omnisharp | `OmniSharp -lsp` | `.cs` | csharp |
| jdtls | `jdtls` | `.java` | java |
| zls | `zls` | `.zig` | zig |

#### Custom Server Example

```rust
use cersei_lsp::{LspManager, LspServerConfig};

let mut mgr = LspManager::new("/project");

// Add Elixir support
let mut elixir = LspServerConfig::new(
    "elixir-ls", "elixir-ls",
    &["*.ex", "*.exs"],
    &[(".ex", "elixir"), (".exs", "elixir")],
);
elixir.args = vec!["--stdio".to_string()];
mgr.register_server(elixir);

mgr.register_builtins(); // Also load defaults
```

#### Global Singleton

For long-running applications (like Abstract CLI), use the global manager:

```rust
use cersei_lsp::global_lsp_manager;

let mgr = global_lsp_manager(Path::new("/project"));
let mut guard = mgr.lock().await;
guard.register_builtins();
let symbols = guard.document_symbols(Path::new("src/lib.rs")).await?;
```

---

### Tree-sitter Code Intelligence

Located in `cersei_tools::tool_primitives::code_intel`. Parses source files using native tree-sitter grammars to extract imports and symbols without running a language server.

#### Supported Languages

| Language | Grammar Crate | Import Nodes | Symbol Nodes |
|----------|---------------|--------------|--------------|
| Rust | `tree-sitter-rust` | `use_declaration` | `function_item`, `struct_item`, `enum_item`, `mod_item`, `trait_item`, `type_item` |
| TypeScript/JS | `tree-sitter-typescript` | `import_statement` (source field) | `function_declaration`, `class_declaration`, `interface_declaration`, `type_alias_declaration`, `enum_declaration` |
| Python | `tree-sitter-python` | `import_statement`, `import_from_statement` | `function_definition`, `class_definition` |
| Go | `tree-sitter-go` | `import_declaration` | `function_declaration`, `method_declaration`, `type_spec` (struct/interface) |

#### Analyzing a Single File

```rust
use cersei_tools::tool_primitives::code_intel::{analyze_file, Language};
use std::path::Path;

let source = r#"
use std::collections::HashMap;
use serde::Serialize;

pub struct Config {
    pub name: String,
}

pub fn load_config() -> Config {
    Config { name: "test".into() }
}
"#;

let intel = analyze_file(Path::new("config.rs"), source).unwrap();
assert_eq!(intel.language, Language::Rust);
assert_eq!(intel.imports.len(), 2);       // HashMap, Serialize
assert!(intel.symbols.iter().any(|s| s.name == "Config"));
assert!(intel.symbols.iter().any(|s| s.name == "load_config"));

for sym in &intel.symbols {
    println!("  {} {} (line {})", sym.kind.label(), sym.name, sym.line);
}
// Output:
//   struct Config (line 5)
//   fn load_config (line 9)
```

#### Scanning a Project

`scan_project()` discovers all source files, parses them, and returns the most important ones ranked by a dependency score:

```rust
use cersei_tools::tool_primitives::code_intel::{scan_project, format_project_intel};
use std::path::Path;

let intels = scan_project(Path::new("/path/to/project"), 20);

// Print ranked file summaries
println!("{}", format_project_intel(&intels));
// Output:
// - src/main.rs — fn main | imports: use crate::config, use std::sync::Arc
// - src/config.rs — struct Config, fn load_config | imports: use serde::Serialize
// - src/lib.rs — mod config, mod server, mod routes
```

#### Scoring Algorithm

Files are ranked by importance score:

| Factor | Points | Description |
|--------|--------|-------------|
| Entry point filename | +100 | `main.rs`, `lib.rs`, `App.tsx`, `index.ts`, `main.py`, etc. |
| Config filename | +80 | `package.json`, `Cargo.toml`, `tsconfig.json`, etc. |
| Store/state path | +60 | Path contains "store", "state", "context", "reducer" |
| Type definition path | +40 | Path contains "types", "interfaces", or `.d.ts` extension |
| Import frequency | +5 per import | Files imported by many others score higher |
| Symbol count | +3 per symbol | Files with more definitions are more architecturally important |

#### API Reference

| Function | Description | Return Type |
|----------|-------------|-------------|
| `analyze_file(path, source)` | Parse a single file, extract imports + symbols | Option<FileIntel> |
| `scan_project(root, max_files)` | Scan project, return top N files by importance | Vec<FileIntel> |
| `format_project_intel(intels)` | Format file intel as compact text summary | String |

#### `FileIntel`

| Field | Description | Type |
|-------|-------------|------|
| path | Absolute file path | PathBuf |
| language | Detected language | Language |
| imports | Import/use statements found | Vec<String> |
| symbols | Symbols defined in the file | Vec<Symbol> |

#### `Symbol`

| Field | Description | Type |
|-------|-------------|------|
| name | Symbol name (e.g. "Config") | String |
| kind | Symbol type | SymbolKind |
| line | 1-based line number | usize |

`SymbolKind`: `Function`, `Struct`, `Class`, `Interface`, `Enum`, `Module`, `Type`, `Constant`

---

### Bash Command Safety Analysis

Located in `cersei_tools::tool_primitives::bash_safety`. Uses tree-sitter to parse bash commands into ASTs and classify them by risk level.

#### Usage

```rust
use cersei_tools::tool_primitives::bash_safety::{analyze_command, is_safe, is_forbidden};

// Safe commands
assert!(is_safe("ls -la"));
assert!(is_safe("grep -r 'TODO' src/"));
assert!(is_safe("git status"));

// Dangerous commands
assert!(is_forbidden("sudo rm -rf /"));
assert!(is_forbidden("dd if=/dev/zero of=/dev/sda"));

// Detailed analysis
let analysis = analyze_command("git push origin main && rm temp.txt");
println!("Risk: {:?}", analysis.risk);        // High
println!("Reasons: {:?}", analysis.reasons);   // ["git push", "file deletion (rm)"]
println!("Commands: {:?}", analysis.commands);  // ["git", "rm"]
println!("Write paths: {:?}", analysis.write_paths); // ["temp.txt"]
```

#### Risk Levels

| Level | Description | Example Commands |
|-------|-------------|------------------|
| **Safe** | Read-only, navigation, inspection | `ls`, `cat`, `grep`, `pwd`, `git status`, `echo` |
| **Moderate** | Writes files, runs builds | `mkdir`, `cp`, `cargo build`, `npm install`, `git add` |
| **High** | Destructive, network, permissions | `rm`, `chmod`, `curl`, `ssh`, `git push` |
| **Forbidden** | Never auto-approve | `sudo`, `rm -rf /`, `dd`, `mkfs` |

#### Detected Constructs

The analyzer detects these AST patterns:

| Construct | Detection | Risk Impact |
|-----------|-----------|-------------|
| Command substitution `$(...)` | `command_substitution` node | Moderate |
| Process substitution `<(...)` | `process_substitution` node | Moderate |
| File redirection `> file` | `file_redirect` node | Moderate (extracts target path) |
| Pipeline `cmd1 \| cmd2` | `pipeline` node | Moderate |
| Privilege escalation `sudo` | command name check | Forbidden |
| Destructive flags `-rf /` | argument inspection | Forbidden |

#### API Reference

| Function | Description | Return Type |
|----------|-------------|-------------|
| `analyze_command(source)` | Full safety analysis | BashAnalysis |
| `parse_bash(source)` | Parse bash into tree-sitter AST | Option<Tree> |
| `is_safe(source)` | Quick check: risk <= Safe | bool |
| `is_forbidden(source)` | Quick check: risk >= Forbidden | bool |

#### `BashAnalysis`

| Field | Description | Type |
|-------|-------------|------|
| risk | Overall risk level | BashRiskLevel |
| reasons | Human-readable explanations | Vec<String> |
| read_paths | File paths the command reads | Vec<String> |
| write_paths | File paths the command writes | Vec<String> |
| commands | Command names detected | Vec<String> |

---

### LSP Tool (Agent-Facing)

The `LSP` tool is automatically registered in Abstract CLI and available to any agent built with `cersei-tools`. It exposes all 5 LSP operations to the model.

#### Tool Schema

```json
{
  "action": "hover | definition | references | symbols | diagnostics",
  "file": "/path/to/file.rs",
  "line": 10,
  "column": 5
}
```

* `line` and `column` are **1-based** (converted to 0-based internally)
* `file` can be absolute or relative to working directory
* `line`/`column` are required for hover, definition, references; optional for symbols and diagnostics

#### Example Agent Interaction

```
User: What type is the `config` variable on line 15 of src/main.rs?

Agent: [calls LSP tool with action=hover, file=src/main.rs, line=15, column=10]
       The `config` variable is of type `AppConfig` (defined in src/config.rs:17).
```

---

### Integration in Abstract CLI

Abstract automatically leverages both systems:

1. **At startup**: `scan_project()` runs tree-sitter analysis on top 20 files, injects dependency-ranked summaries into the system prompt as `project_intel`
2. **During exploration**: The agent calls the `LSP` tool for semantic queries (hover, definitions, references)
3. **Before bash execution**: `analyze_command()` classifies risk level for the permission system
4. **In the TUI**: `/graph` overlay can visualize which LSP servers are available for the project


---

# Primitives

## Tool Primitives (/docs/primitives)

The 34 built-in tools are thin wrappers over a set of async primitives. These primitives are the actual building blocks — file reads, process spawning, HTTP fetching, regex search, git operations, text diffing. They return structured types instead of strings, have no JSON schema overhead, and work outside the Tool trait.

Use them directly when building custom tools, data pipelines, DevOps automation, or anything that needs fine-grained control over I/O.

```rust
use cersei_tools::tool_primitives::{fs, diff, process, http, search, git};
```

> Tool primitives are pure async functions and structs. No Tool trait, no JSON serialization, no model-facing API. They're designed for developers, not models.

***

### At a Glance

- **diff** (`/docs/primitives-api#diff`) — Unified diffs, structured line diffs, and patch application. Pure functions, no I/O. Built on the `similar` crate.
- **fs** (`/docs/primitives-api#fs`) — Async file read/write/edit with structured returns. Diff a file against proposed changes. Apply patches. Check metadata.
- **process** (`/docs/primitives-api#process`) — Async command execution with shell selection (Sh, Bash, Zsh, PowerShell, Cmd). Stateless — no persistent cwd. Streaming output via channel.
- **http** (`/docs/primitives-api#http`) — GET, POST, and HTML-to-text fetching. Configurable timeout, headers, user agent. Built on reqwest.
- **search** (`/docs/primitives-api#search`) — Structured regex search (ripgrep with grep fallback) and glob pattern matching. Returns file paths, line numbers, and matched content.
- **git** (`/docs/primitives-api#git`) — Async git CLI operations — status, diff, log, branch detection. Structured types for everything. No libgit2 dependency.

***

### Quick Examples

#### Read a file with line numbers

```rust
use cersei_tools::tool_primitives::fs;

let content = fs::read_file(Path::new("src/main.rs"), 0, 50).await?;
println!("Lines: {}, returned: {}", content.total_lines, content.lines_returned);
println!("{}", content.content); // 1-based line numbers, cat -n style
```

#### Produce a unified diff

```rust
use cersei_tools::tool_primitives::diff;

let old = "fn main() {\n    println!(\"hello\");\n}\n";
let new = "fn main() {\n    println!(\"world\");\n}\n";

let patch = diff::unified_diff(old, new, 3);
// @@ -1,3 +1,3 @@
//  fn main() {
// -    println!("hello");
// +    println!("world");
//  }
```

#### Execute a command

```rust
use cersei_tools::tool_primitives::process::{exec, ExecOptions, Shell};

let output = exec("cargo test", ExecOptions {
    cwd: Some("/my/project".into()),
    timeout: Some(Duration::from_secs(60)),
    shell: Shell::Bash,
    ..Default::default()
}).await?;

if output.exit_code == 0 {
    println!("Tests passed: {}", output.stdout);
} else {
    eprintln!("Tests failed (exit {}): {}", output.exit_code, output.stderr);
}
```

#### Search files with grep

```rust
use cersei_tools::tool_primitives::search;

let matches = search::grep("TODO", Path::new("src/"), search::GrepOptions {
    glob_filter: Some("*.rs".into()),
    max_results: Some(50),
    ..Default::default()
}).await?;

for m in &matches {
    println!("{}:{}: {}", m.file.display(), m.line_number, m.line_content);
}
```

#### Check git status

```rust
use cersei_tools::tool_primitives::git;

if git::is_repo(Path::new(".")).await {
    let status = git::status(Path::new(".")).await?;
    println!("Branch: {:?}", status.branch);
    for file in &status.files {
        println!("  {} {}", file.status, file.path);
    }
}
```

#### Fetch a URL

```rust
use cersei_tools::tool_primitives::http;

let text = http::fetch_html("https://example.com", 50_000, Default::default()).await?;
println!("{}", text); // HTML converted to readable plain text
```

***

### Primitives vs Tools

|             | Tool (model-facing)          | Primitive (developer-facing)                          |
| ----------- | ---------------------------- | ----------------------------------------------------- |
| Input       | `serde_json::Value`          | Typed Rust arguments                                  |
| Output      | `ToolResult` (String)        | Structured types (`FileContent`, `SearchMatch`, etc.) |
| Schema      | JSON Schema for the model    | No schema                                             |
| Permissions | Checked by the agent runtime | None — caller's responsibility                        |
| Async       | Yes                          | Yes                                                   |
| Use case    | Model calls it via tool\_use | Developer calls it from Rust                          |

The built-in tools call primitives internally:

```
Model → ToolUse("Read", {file_path: "src/main.rs"})
    → FileReadTool.execute(input, ctx)
        → tool_primitives::fs::read_file(path, offset, limit)  ← this is the primitive
            → Returns FileContent { content, total_lines, ... }
        → ToolResult::success(content.content)                  ← formatted for the model
```

***

### Next Steps

* [API Reference](/docs/primitives-api) — every function, struct, enum, and field
* [Cookbook](/docs/primitives-cookbook) — build a DiffTool, a deploy verifier, a research agent

***

## Primitives: API Reference (/docs/primitives-api)

Every public function, struct, and enum across the 6 tool primitive modules.

```rust
use cersei_tools::tool_primitives::{diff, fs, process, http, search, git};
```

***

### diff

Pure text diffing functions. No I/O, no async. Built on the `similar` crate.

#### unified_diff

```rust
pub fn unified_diff(old: &str, new: &str, context_lines: usize) -> String
```

Produces a standard unified diff with `@@` hunk headers. `context_lines` controls how many unchanged lines surround each hunk.

#### line_diff

```rust
pub fn line_diff(old: &str, new: &str) -> Vec<DiffLine>
```

Returns a structured per-line diff with old/new line numbers and change tags.

**DiffLine** struct:
- `tag` (ChangeTag): Added, Removed, or Unchanged.
- `line_number_old` (Option<usize>): Line number in the old text (None for added lines).
- `line_number_new` (Option<usize>): Line number in the new text (None for removed lines).
- `content` (String): The line content.

#### apply_patch

```rust
pub fn apply_patch(original: &str, patch: &str) -> Result<String, PatchError>
```

Applies a unified diff patch to `original`. Returns the patched text or an error if the patch doesn't apply cleanly.

***

### fs

Async file operations. All functions use `tokio::fs`.

#### read_file

```rust
pub async fn read_file(path: &Path, offset: usize, limit: usize) -> Result<FileContent, io::Error>
```

Read a file with optional line offset and limit. Returns content with 1-based line numbers.

**FileContent** struct:
- `path` (String): File path.
- `content` (String): File content formatted with line numbers (cat -n style).
- `total_lines` (usize): Total number of lines in the file.
- `offset` (usize): 0-based offset that was applied.
- `lines_returned` (usize): Number of lines actually returned.

#### write_file

```rust
pub async fn write_file(path: &Path, content: &str) -> Result<(), io::Error>
```

Write content to a file. Creates parent directories automatically.

#### edit_file

```rust
pub async fn edit_file(
    path: &Path, old_text: &str, new_text: &str, replace_all: bool
) -> Result<EditResult, EditError>
```

String replacement in a file. Returns the number of replacements made.

**Errors:**
- `EditError::NotFound` — `old_text` not present in the file
- `EditError::AmbiguousMatch { count }` — `old_text` appears multiple times and `replace_all` is false
- `EditError::Io(e)` — file I/O failure

#### diff_file

```rust
pub async fn diff_file(path: &Path, new_content: &str, context_lines: usize) -> Result<String, io::Error>
```

Produce a unified diff between the file's current content and proposed new content.

#### patch_file

```rust
pub async fn patch_file(path: &Path, patch: &str) -> Result<(), PatchFileError>
```

Apply a unified diff patch to a file, writing the result back.

#### file_exists / file_size / file_metadata

```rust
pub async fn file_exists(path: &Path) -> bool
pub async fn file_size(path: &Path) -> Result<u64, io::Error>
pub async fn file_metadata(path: &Path) -> Result<FileMetadata, io::Error>
```

**FileMetadata** struct:
- `size_bytes` (u64): File size in bytes.
- `is_file` (bool): Whether the path is a regular file.
- `is_dir` (bool): Whether the path is a directory.
- `is_symlink` (bool): Whether the path is a symbolic link.
- `modified` (Option<u64>): Last modified time as Unix epoch seconds.
- `readonly` (bool): Whether the file is read-only.

***

### process

Async command execution. Stateless — no persistent cwd or env.

#### exec

```rust
pub async fn exec(command: &str, opts: ExecOptions) -> Result<ExecOutput, io::Error>
```

Execute a command through a shell. Returns when the command completes or times out.

**ExecOutput** struct:
- `stdout` (String): Standard output.
- `stderr` (String): Standard error.
- `exit_code` (i32): Process exit code. -1 on timeout or signal.
- `timed_out` (bool): Whether the command was killed due to timeout.

#### ExecOptions

**ExecOptions** struct:
- `cwd` (Option<PathBuf>): Working directory for the command.
- `env` (HashMap<String, String>): Environment variables to set. Default: empty.
- `timeout` (Option<Duration>): Maximum execution time. Default: 120s.
- `shell` (Shell): Which shell to use: Sh, Bash, Zsh, PowerShell, Cmd, or Custom. Default: Shell::Sh.

#### exec_streaming

```rust
pub fn exec_streaming(
    command: &str, opts: ExecOptions
) -> Result<(Receiver<OutputLine>, JoinHandle<ExecOutput>), io::Error>
```

Execute a command and stream output lines through a channel. The `JoinHandle` resolves to `ExecOutput` when the command finishes. `OutputLine` is either `Stdout(String)` or `Stderr(String)`.

***

### http

Async HTTP client built on reqwest.

#### get

```rust
pub async fn get(url: &str, opts: HttpOptions) -> Result<HttpResponse, HttpError>
```

#### post

```rust
pub async fn post(url: &str, body: &str, opts: HttpOptions) -> Result<HttpResponse, HttpError>
```

#### fetch_html

```rust
pub async fn fetch_html(url: &str, max_chars: usize, opts: HttpOptions) -> Result<String, HttpError>
```

Fetch a URL and convert HTML to readable plain text using `html2text`. Non-HTML content returned as-is. Truncated to `max_chars`.

#### HttpResponse

**HttpResponse** struct:
- `status` (u16): HTTP status code.
- `headers` (HashMap<String, String>): Response headers.
- `body` (String): Response body as text.
- `content_type` (Option<String>): Content-Type header value.

#### HttpOptions

**HttpOptions** struct:
- `headers` (HashMap<String, String>): Custom request headers. Default: empty.
- `timeout` (Option<Duration>): Request timeout. Default: 30s.
- `user_agent` (Option<String>): User-Agent header. Default: "Cersei-Agent/0.1".

#### HttpError

- `RequestFailed(String)` — network or protocol error
- `Timeout` — request timed out
- `ClientBuild(String)` — failed to construct the HTTP client

***

### search

Structured file search — grep and glob.

#### grep

```rust
pub async fn grep(
    pattern: &str, path: &Path, opts: GrepOptions
) -> Result<Vec<SearchMatch>, SearchError>
```

Search file contents using a regex pattern. Uses ripgrep if available, falls back to system grep. Returns structured matches.

**SearchMatch** struct:
- `file` (PathBuf): Path to the file containing the match.
- `line_number` (usize): 1-based line number of the match.
- `line_content` (String): Content of the matching line.

#### GrepOptions

**GrepOptions** struct:
- `glob_filter` (Option<String>): Glob pattern to filter files (e.g., "*.rs").
- `max_results` (Option<usize>): Maximum number of matches to return.
- `case_insensitive` (bool): Case-insensitive matching. Default: false.

#### glob

```rust
pub async fn glob(pattern: &str, base_dir: &Path) -> Result<Vec<PathBuf>, SearchError>
```

Find files matching a glob pattern. Returns sorted paths.

***

### git

Async git CLI operations. All functions use `tokio::process::Command`.

#### Repository detection

```rust
pub async fn is_repo(path: &Path) -> bool
pub async fn repo_root(path: &Path) -> Option<PathBuf>
pub async fn current_branch(path: &Path) -> Option<String>
```

#### status

```rust
pub async fn status(path: &Path) -> Result<GitStatus, GitError>
```

**GitStatus** struct:
- `branch` (Option<String>): Current branch name (None if detached HEAD).
- `files` (Vec<GitFileStatus>): Changed files with their status codes ("M", "A", "D", "??", etc.).

#### diff

```rust
pub async fn diff(path: &Path, staged: bool) -> Result<String, GitError>
```

Get unified diff output. `staged = true` shows staged changes (`--cached`), `false` shows unstaged.

#### log

```rust
pub async fn log(path: &Path, n: usize) -> Result<Vec<GitLogEntry>, GitError>
```

**GitLogEntry** struct:
- `hash` (String): Abbreviated commit hash.
- `message` (String): First line of the commit message.

#### diff_file_content / list_modified_files

```rust
pub async fn diff_file_content(path: &Path, file: &str) -> Result<String, GitError>
pub async fn list_modified_files(path: &Path) -> Result<Vec<String>, GitError>
```

#### GitError

- `NotARepo` — path is not inside a git repository
- `CommandFailed(String)` — git command returned an error
- `IoError(io::Error)` — process spawn failure

***

## Primitives: Cookbook (/docs/primitives-cookbook)

Practical examples of building agent tools using `tool_primitives` directly instead of inline I/O.

***

### DiffTool — Show Changes Before Writing

An agent tool that shows the unified diff before applying changes, giving the model (or user) a chance to review.

```rust
use cersei::prelude::*;
use cersei_tools::tool_primitives::{fs, diff};
use std::path::Path;

#[derive(Tool)]
#[tool(name = "diff_preview", description = "Show a diff before editing a file", permission = "read_only")]
struct DiffPreviewTool;

#[async_trait]
impl ToolExecute for DiffPreviewTool {
    type Input = DiffInput;

    async fn run(&self, input: DiffInput, _ctx: &ToolContext) -> ToolResult {
        let path = Path::new(&input.file_path);

        if !fs::file_exists(path).await {
            return ToolResult::error(format!("File not found: {}", input.file_path));
        }

        let diff_output = fs::diff_file(path, &input.new_content, 3).await
            .map_err(|e| format!("Diff failed: {e}"))?;

        if diff_output.is_empty() {
            ToolResult::success("No changes — file content is identical.")
        } else {
            ToolResult::success(format!(
                "Proposed changes to {}:\n\n{}",
                input.file_path, diff_output
            ))
        }
    }
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct DiffInput {
    file_path: String,
    new_content: String,
}
```

***

### Deploy and Verify

A tool that runs a deploy script, waits, then checks a health endpoint. Combines `process` and `http` primitives.

```rust
use cersei_tools::tool_primitives::{process, http};
use std::time::Duration;

async fn deploy_and_verify(
    deploy_cmd: &str,
    health_url: &str,
    retries: u32,
) -> Result<String, String> {
    // Run the deploy
    let output = process::exec(deploy_cmd, process::ExecOptions {
        timeout: Some(Duration::from_secs(300)),
        shell: process::Shell::Bash,
        ..Default::default()
    }).await.map_err(|e| format!("Deploy failed to start: {e}"))?;

    if output.exit_code != 0 {
        return Err(format!("Deploy failed (exit {}): {}", output.exit_code, output.stderr));
    }

    // Poll health endpoint
    for attempt in 1..=retries {
        tokio::time::sleep(Duration::from_secs(5)).await;

        match http::get(health_url, http::HttpOptions {
            timeout: Some(Duration::from_secs(5)),
            ..Default::default()
        }).await {
            Ok(resp) if resp.status == 200 => {
                return Ok(format!("Deploy succeeded. Health check passed on attempt {}.", attempt));
            }
            Ok(resp) => {
                eprintln!("Health check attempt {}: HTTP {}", attempt, resp.status);
            }
            Err(e) => {
                eprintln!("Health check attempt {}: {}", attempt, e);
            }
        }
    }

    Err(format!("Deploy completed but health check failed after {} attempts", retries))
}
```

***

### Research Agent — Fetch and Summarize

Combine `http` and `search` to build a tool that fetches documentation and searches local files for related code.

```rust
use cersei_tools::tool_primitives::{http, search};
use std::path::Path;

async fn research(topic: &str, project_dir: &Path) -> String {
    let mut report = String::new();

    // Search local codebase for related code
    let matches = search::grep(topic, project_dir, search::GrepOptions {
        glob_filter: Some("*.rs".into()),
        max_results: Some(10),
        ..Default::default()
    }).await.unwrap_or_default();

    if !matches.is_empty() {
        report.push_str(&format!("## Local references ({} matches)\n\n", matches.len()));
        for m in &matches {
            report.push_str(&format!("- `{}:{}` — {}\n", m.file.display(), m.line_number, m.line_content.trim()));
        }
        report.push('\n');
    }

    // Fetch external documentation
    let urls = vec![
        format!("https://docs.rs/{topic}/latest"),
        format!("https://crates.io/crates/{topic}"),
    ];

    for url in &urls {
        match http::fetch_html(url, 10_000, Default::default()).await {
            Ok(text) => {
                report.push_str(&format!("## {url}\n\n{}\n\n", &text[..text.len().min(2000)]));
            }
            Err(_) => {
                report.push_str(&format!("## {url}\n\n(fetch failed)\n\n"));
            }
        }
    }

    report
}
```

***

### Git-Aware Code Reviewer

A tool that reads the current diff, finds the modified files, and checks each one for common issues.

```rust
use cersei_tools::tool_primitives::{git, fs, search};
use std::path::Path;

async fn review_changes(repo: &Path) -> Result<String, String> {
    if !git::is_repo(repo).await {
        return Err("Not a git repository".into());
    }

    let status = git::status(repo).await.map_err(|e| e.to_string())?;
    let branch = status.branch.as_deref().unwrap_or("detached");

    let mut report = format!("## Code Review — branch `{branch}`\n\n");
    report.push_str(&format!("{} files changed\n\n", status.files.len()));

    for file in &status.files {
        report.push_str(&format!("### {} ({})\n\n", file.path, file.status));

        // Show the diff for this file
        match git::diff_file_content(repo, &file.path).await {
            Ok(diff) if !diff.is_empty() => {
                let added = diff.lines().filter(|l| l.starts_with('+')).count();
                let removed = diff.lines().filter(|l| l.starts_with('-')).count();
                report.push_str(&format!("+{added} -{removed} lines\n\n"));
            }
            _ => {}
        }

        // Check for TODOs in modified files
        let file_path = repo.join(&file.path);
        if let Ok(todos) = search::grep("TODO|FIXME|HACK", &file_path, search::GrepOptions {
            max_results: Some(5),
            case_insensitive: true,
            ..Default::default()
        }).await {
            if !todos.is_empty() {
                report.push_str("**Markers found:**\n");
                for t in &todos {
                    report.push_str(&format!("  - line {}: {}\n", t.line_number, t.line_content.trim()));
                }
                report.push('\n');
            }
        }
    }

    Ok(report)
}
```

***

### Structured File Analysis

Combine `fs` and `diff` to build a function that analyzes how a file has changed between two versions.

```rust
use cersei_tools::tool_primitives::{fs, diff};
use std::path::Path;

async fn analyze_change(path: &Path, proposed: &str) -> String {
    let meta = fs::file_metadata(path).await.ok();
    let size_str = meta.as_ref()
        .map(|m| format!("{}KB", m.size_bytes / 1024))
        .unwrap_or_else(|| "new file".into());

    let lines = diff::line_diff(
        &tokio::fs::read_to_string(path).await.unwrap_or_default(),
        proposed,
    );

    let added = lines.iter().filter(|l| l.tag == diff::ChangeTag::Added).count();
    let removed = lines.iter().filter(|l| l.tag == diff::ChangeTag::Removed).count();
    let unchanged = lines.iter().filter(|l| l.tag == diff::ChangeTag::Unchanged).count();

    format!(
        "{} ({}) — +{} -{} ~{} lines",
        path.display(), size_str, added, removed, unchanged
    )
}
```

***

### Composing Primitives Into a Tool

Wrap any primitive-based function as a model-facing tool:

```rust
#[derive(Tool)]
#[tool(name = "code_review", description = "Review uncommitted changes", permission = "read_only")]
struct CodeReviewTool;

#[async_trait]
impl ToolExecute for CodeReviewTool {
    type Input = CodeReviewInput;

    async fn run(&self, input: CodeReviewInput, ctx: &ToolContext) -> ToolResult {
        match review_changes(&ctx.working_dir).await {
            Ok(report) => ToolResult::success(report),
            Err(e) => ToolResult::error(e),
        }
    }
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
struct CodeReviewInput {} // no input needed — uses working_dir from context
```

Register it alongside built-in tools:

```rust
let agent = Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::coding())
    .tool(CodeReviewTool)
    .build()?;
```


---

# Embeddings

## Embeddings Overview (/docs/embeddings-overview)

### cersei-embeddings

The `cersei-embeddings` crate combines a pluggable `EmbeddingProvider` trait with a **`usearch`-backed HNSW vector index**. It powers CodeSearch's hybrid BM25 + vector capabilities and is available as a standalone SDK for building RAG systems, semantic search, or clustering applications without depending on other Cersei components.

The crate operates as a leaf dependency with no reliance on cersei-types or other Cersei packages.

### When to reach for it

Consider this crate when you need:

* Semantic search across documents, code, or notes
* RAG pipelines grounding LLM responses in relevant text snippets
* Deduplication or clustering based on nearest-neighbor distance
* Custom reranking layers on top of keyword or BM25 search

For BM25-only code search, use `CodeSearchTool::new()` directly. Adopt `cersei-embeddings` when you require query-intent understanding or cross-file semantic similarity.

### What ships in the box

| Component            | Purpose                                                      |
| -------------------- | ------------------------------------------------------------ |
| `EmbeddingProvider`  | Base trait for backend implementations                       |
| `GeminiEmbeddings`   | Google text-embedding-004 (768-d) provider                  |
| `OpenAiEmbeddings`   | OpenAI text-embedding-3-small (1536-d) with URL override    |
| `VectorIndex`        | HNSW wrapper providing core operations                       |
| `EmbeddingStore<P>`  | Bundled provider and index                                   |
| `auto_from_model`    | Provider factory from LLM model strings                      |
| `Metric`             | Distance options: Cosine, L2, InnerProduct                  |
| `SearchHit`          | Result containing key, distance, similarity                 |

### Add it to your project

```toml
[dependencies]
cersei-embeddings = "0.1.6-patch.2"
```

### 5-line quick start

**OpenAI example:**
```rust
use cersei_embeddings::{OpenAiEmbeddings, EmbeddingStore, Metric};

let provider = OpenAiEmbeddings::from_env()?;
let store = EmbeddingStore::new(provider, Metric::Cosine)?;

store.add_batch(&[
    (1, "Rust is a systems programming language".into()),
    (2, "Pasta is best served al dente".into()),
]).await?;

let hits = store.search("compiled languages", 2).await?;
assert_eq!(hits[0].key, 1);
```

**Gemini example:**
```rust
use cersei_embeddings::{GeminiEmbeddings, EmbeddingStore, Metric};

let provider = GeminiEmbeddings::from_env()?;
let store = EmbeddingStore::new(provider, Metric::Cosine)?;

store.add_batch(&[
    (1, "Rust is a systems programming language".into()),
    (2, "Pasta is best served al dente".into()),
]).await?;

let hits = store.search("compiled languages", 2).await?;
```

**Auto-detect example:**
```rust
use cersei_embeddings::{auto_from_model, EmbeddingStore, Metric};

let provider = auto_from_model("openai/gpt-4o")?;
let dim = provider.dimensions();
println!("{} ({}-d)", provider.name(), dim);
```

### How Abstract uses it

CodeSearchTool in cersei-tools integrates this crate. When the `--embedding-api` flag activates, Abstract invokes `auto_from_model(resolved_model)` and passes the provider to `CodeSearchTool::with_embeddings()`. The tool maintains BM25 for exact-term matching while blending vector results at 40% weight for semantic coverage.

### Keep reading

* API Reference — full type and method documentation
* Cookbook — examples including RAG agents, custom providers, semantic markdown search

## Embeddings API (/docs/embeddings-api)

### Overview

The cersei-embeddings API provides a trait-based system for embedding text and searching vectors. All public items are re-exported from the crate root.

### Core Trait: `EmbeddingProvider`

`EmbeddingProvider` is an async trait that every embedding backend must implement, with four key methods:

- `name()` returns a short identifier useful for logging
- `dimensions()` specifies the vector width for HNSW graph sizing
- `embed(text)` embeds a single string via the default batch implementation
- `embed_batch(texts)` handles multiple embeddings with provider-specific limits

Custom providers require approximately 30 lines of code.

### Concrete Implementations

#### `GeminiEmbeddings`

Google's Gemini embeddings using the `text-embedding-004` model (768 dimensions). Features include 100-per-batch chunking and 2000-character text truncation.

**Construction methods:**
- `new(api_key)` — explicit key initialization
- `from_env()` — reads `GOOGLE_API_KEY` or `GEMINI_API_KEY`
- `with_model(model)` — override the embedding model
- `with_dimensions(dims)` — declare vector dimensionality
- `with_truncate_chars(chars)` — configure text truncation

#### `OpenAiEmbeddings`

OpenAI-compatible embeddings defaulting to `text-embedding-3-small` (1536 dimensions). Supports Azure, Ollama, and other compatible endpoints.

**Construction methods:**
- `new(api_key)` — explicit key initialization
- `from_env()` — reads `OPENAI_API_KEY`
- `with_model(model)` — override the embedding model
- `with_dimensions(dims)` — declare vector dimensionality
- `with_truncate_chars(chars)` — configure text truncation
- `with_base_url(url)` — point to alternative endpoints

### Vector Search: `VectorIndex`

A thin wrapper around `usearch::Index` providing HNSW approximate nearest-neighbor search with configurable metrics.

**Key methods:**
- `new(dimensions, metric)` — build an empty index
- `from_vectors(&[Vec<f32>], Metric)` — construct and populate in one call
- `reserve(n)` — pre-allocate capacity
- `add(key, vector)` — insert a vector with a u64 key
- `search(query, k)` — execute k-NN search returning up to k hits
- `len()`, `dimensions()`, `metric()` — query index properties

#### Similarity Metrics

Three metrics are available:

| Metric | Formula |
|--------|---------|
| Cosine | `1.0 - distance` |
| L2 | `1.0 / (1.0 + distance)` |
| InnerProduct | `distance` (pre-computed similarity) |

#### `SearchHit`

Results contain three fields: `key` (u64), `distance` (f32), and `similarity` (f32).

### High-Level API: `EmbeddingStore<P>`

Bundles provider and index together for the common workflow: add text → search by text.

**Methods:**
- `new(provider, metric)` — build an empty store with inferred dimensionality
- `add_batch(&[(u64, String)])` — embed and insert items
- `search(query, k)` — embed query and run k-NN search
- `provider()`, `index()` — access underlying components

### Convenience Functions

#### `auto_from_model`

Automatically selects a provider based on LLM model string patterns:
- Model contains `gpt`, `o1`, `o3`, or `openai` → `OpenAiEmbeddings`
- Model contains `gemini` or `google` → `GeminiEmbeddings`
- Default fallback → `OpenAiEmbeddings`

Requires the corresponding API key environment variable.

### Error Handling: `EmbeddingError`

Encompasses four error categories: `Http` (transport failures), `Api` (non-2xx responses), `Parse` (malformed responses), `Index` (usearch operations), and `Config` (missing configuration).

## Embeddings Cookbook (/docs/embeddings-cookbook)

Practical patterns built on `cersei-embeddings`.

### Semantic search over a folder of Markdown

A self-contained program that indexes every `.md` file in a directory and answers queries semantically.

```rust
use cersei_embeddings::{EmbeddingStore, Metric, OpenAiEmbeddings};
use walkdir::WalkDir;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let provider = OpenAiEmbeddings::from_env()?;
    let store = EmbeddingStore::new(provider, Metric::Cosine)?;

    // Collect every .md file under ./notes and remember the path for each key.
    let mut paths: Vec<String> = Vec::new();
    let mut items: Vec<(u64, String)> = Vec::new();

    for entry in WalkDir::new("./notes").into_iter().filter_map(|e| e.ok()) {
        if entry.path().extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let text = std::fs::read_to_string(entry.path())?;
        let key = paths.len() as u64;
        paths.push(entry.path().display().to_string());
        items.push((key, text));
    }

    store.add_batch(&items).await?;

    let hits = store.search("how do I set up CI for rust?", 5).await?;
    for hit in hits {
        println!("{:.3}  {}", hit.similarity, paths[hit.key as usize]);
    }
    Ok(())
}
```

### Minimal RAG agent

Combine `cersei-embeddings` (retrieval) with `cersei` (LLM) to ground the model's answer in the most relevant snippets.

```rust
use cersei::prelude::*;
use cersei_embeddings::{EmbeddingStore, Metric, OpenAiEmbeddings};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // 1. Build a corpus store.
    let store = EmbeddingStore::new(OpenAiEmbeddings::from_env()?, Metric::Cosine)?;
    let docs = load_docs(); // Vec<(u64, String)>
    store.add_batch(&docs).await?;

    // 2. Retrieve the top-K snippets.
    let question = "Why does the scheduler reject long-running jobs?";
    let hits = store.search(question, 4).await?;
    let context = hits
        .iter()
        .map(|h| docs[h.key as usize].1.clone())
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");

    // 3. Ask the LLM with retrieved context injected.
    let prompt = format!(
        "Context:\n{context}\n\nQuestion: {question}\n\nAnswer using only the context above."
    );

    let output = Agent::builder()
        .provider(OpenAi::from_env()?)
        .system_prompt("You are a precise technical assistant.")
        .run_with(&prompt)
        .await?;

    println!("{}", output.text());
    Ok(())
}

fn load_docs() -> Vec<(u64, String)> {
    // your loader — reads files, DB rows, API responses, etc.
    vec![]
}
```

> Note: For production RAG systems, implement document chunking (~200–500 tokens), persist indexes to disk between sessions, and maintain chunk metadata for proper attribution.

### Wrapping retrieval in a custom `Tool`

If you want the agent itself to decide when to retrieve, expose the store as a Cersei `Tool`.

```rust
use async_trait::async_trait;
use cersei::prelude::*;
use cersei_embeddings::{EmbeddingStore, OpenAiEmbeddings};
use std::sync::Arc;

pub struct RetrieverTool {
    store: Arc<EmbeddingStore<OpenAiEmbeddings>>,
    docs:  Arc<Vec<(u64, String)>>,
}

#[async_trait]
impl Tool for RetrieverTool {
    fn name(&self) -> &str { "Retrieve" }

    fn description(&self) -> &str {
        "Retrieve the top 4 most relevant snippets from the internal corpus for a natural-language query."
    }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": { "query": { "type": "string" } },
            "required": ["query"]
        })
    }

    async fn execute(&self, input: serde_json::Value, _ctx: &ToolContext) -> ToolResult {
        let query = match input.get("query").and_then(|v| v.as_str()) {
            Some(q) => q,
            None => return ToolResult::error("missing query"),
        };
        let hits = match self.store.search(query, 4).await {
            Ok(h) => h,
            Err(e) => return ToolResult::error(format!("retrieve failed: {e}")),
        };
        let snippets = hits.iter()
            .filter_map(|h| self.docs.get(h.key as usize).map(|(_, t)| t.clone()))
            .collect::<Vec<_>>()
            .join("\n---\n");
        ToolResult::success(snippets)
    }
}
```

Plug it into your agent:

```rust
let retriever = RetrieverTool { store: store.clone(), docs: docs.clone() };
let mut tools = cersei::tools::all();
tools.push(Box::new(retriever));

let agent = Agent::builder()
    .provider(OpenAi::from_env()?)
    .tools(tools)
    .build()?;
```

### Writing a custom provider

Implement the trait for any other API — here is Cohere as an example.

```rust
use async_trait::async_trait;
use cersei_embeddings::{EmbeddingError, EmbeddingProvider};
use serde::Deserialize;

pub struct CohereEmbeddings {
    api_key: String,
    model: String,
    client: reqwest::Client,
}

impl CohereEmbeddings {
    pub fn from_env() -> Result<Self, EmbeddingError> {
        let api_key = std::env::var("COHERE_API_KEY")
            .map_err(|_| EmbeddingError::Config("COHERE_API_KEY missing".into()))?;
        Ok(Self {
            api_key,
            model: "embed-english-v3.0".into(),
            client: reqwest::Client::new(),
        })
    }
}

#[async_trait]
impl EmbeddingProvider for CohereEmbeddings {
    fn name(&self) -> &str { "cohere" }
    fn dimensions(&self) -> usize { 1024 }

    async fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, EmbeddingError> {
        let resp = self.client.post("https://api.cohere.com/v1/embed")
            .header("Authorization", format!("Bearer {}", self.api_key))
            .json(&serde_json::json!({
                "model": self.model,
                "texts": texts,
                "input_type": "search_document",
            }))
            .send().await?;

        if !resp.status().is_success() {
            let body = resp.text().await.unwrap_or_default();
            return Err(EmbeddingError::Api(format!("cohere: {body}")));
        }

        #[derive(Deserialize)]
        struct R { embeddings: Vec<Vec<f32>> }
        let parsed: R = resp.json().await.map_err(|e| EmbeddingError::Parse(e.to_string()))?;
        Ok(parsed.embeddings)
    }
}
```

The moment your type implements `EmbeddingProvider`, it composes with `VectorIndex` and `EmbeddingStore` just like the built-in providers.

### Tuning tips

* **Metric choice.** Use `Cosine` for text (length-invariant) — the default in Abstract's `CodeSearch`. Use `L2` when magnitude matters. Use `InnerProduct` when you need raw dot-product scoring (e.g., your embeddings are already normalized and you want speed).
* **Batch size.** Gemini caps at 100 per request (handled automatically). OpenAI has no hard per-request cap but accepts far more throughput when you keep each request under ~2048 inputs.
* **Truncation.** The built-in providers truncate each text to 2000 chars by default. If your content is long, chunk before embedding rather than letting truncation silently drop material.
* **Index reuse.** `VectorIndex` is cheap to query but expensive to build. For Abstract's `CodeSearch` this is handled by an in-memory cache keyed on working directory. For your own app, save the vectors to disk (e.g., via `bincode`) and reload on startup.


---

# Compression (RTK)

## Compression Overview (/docs/compression-overview)

### cersei-compression

The `cersei-compression` tool filters tool outputs by removing ANSI codes, blank lines, compilation progress messages, boilerplate comments, and unmodified function bodies. Real-world testing showed measurable savings: "gpt-4o-mini billed us 29.1% fewer input tokens on a `cargo test` turn."

The rule engine and code filtering derive from Patrick Szymkowiak's rtk project, properly credited in the codebase.

### Levels

Three compression modes are available:

- **Off**: No changes; the default for backward compatibility
- **Minimal**: Removes ANSI sequences, collapses blank lines, strips non-documentation comments in source files; safe for data formats
- **Aggressive**: Minimal features plus function body stubbing (preserving signatures and imports), with command-specific rules for git, cargo, npm, pnpm, pytest, and docker

### How it decides what to do

The system routes dispatch by tool name and the first command word for shell-like tools:

| Tool Name | Input Hint | Strategy |
|-----------|-----------|----------|
| Bash, Exec | first word of command | TOML rules DSL |
| Read, ReadFile | file extension | language-aware code filter |
| Grep, Glob, Ls | — | passthrough |
| WebFetch, Fetch | — | ANSI strip + generic rule |
| Everything else | — | passthrough (or safety cap in Aggressive mode) |

Each call produces a structured tracing event showing the rule fired, before/after metrics, and savings percentage.

### Quick Start

Add the dependency:

```toml
[dependencies]
cersei-compression = "0.1.7"
```

#### As an SDK user

```rust
use cersei::Agent;
use cersei_compression::CompressionLevel;

let agent = Agent::builder()
    .provider(provider)
    .tool(my_tool)
    .compression_level(CompressionLevel::Aggressive)
    .build()?;
```

#### Directly

```rust
use cersei_compression::{compress_tool_output, CompressionLevel};
use serde_json::json;

let out = compress_tool_output(
    "Bash",
    &json!({"command": "cargo test"}),
    raw_stdout,
    CompressionLevel::Aggressive,
);
```

#### From abstract-cli

```bash
# CLI flag
abstract --compress aggressive "fix the failing tests"

# Env var
ABSTRACT_COMPRESSION=aggressive abstract

# Config file (~/.abstract/config.toml or .abstract/config.toml)
compression_level = "aggressive"

# Runtime toggle in the REPL
> /compression aggressive
```

### Agent builder knob

Added in version 0.1.7:

```rust
use cersei_compression::CompressionLevel;

let agent = Agent::builder()
    .provider(provider)
    .tool(my_tool)
    .compression_level(CompressionLevel::Aggressive)
    .build()?;

// Runtime change
agent.set_compression_level(CompressionLevel::Off);
let current = agent.compression_level();
```

### What's in the box

| Component | Role |
|-----------|------|
| `CompressionLevel` | Enum for Off / Minimal / Aggressive modes, parseable from string |
| `compress_tool_output` | Primary public entry point used by cersei-agent |
| `code::filter` | Strips comments and stubs bodies; supports Rust, Python, JS/TS, Go, C/C++, Java, Ruby, Shell |
| `truncate::smart_truncate` | Line-aware fallback preserving imports, signatures, and braces |
| `toml_rules` | DSL supporting strip_ansi, replace, match_output, strip/keep_lines, truncate operations, and more |
| `ansi` helpers | Unicode-safe ANSI stripping and truncation |

### Built-in rule files

Seven TOML files are embedded at compile time:

| File | Commands |
|------|----------|
| `git.toml` | git log, git status, git diff, and generic git |
| `cargo.toml` | cargo build, check, test, clippy, and generic cargo |
| `npm.toml` | npm install, ci, npx, and generic npm |
| `pnpm.toml` | pnpm install, add, and generic pnpm |
| `pytest.toml` | pytest, py.test, python -m pytest |
| `docker.toml` | docker build, buildx, and generic docker |
| `generic.toml` | Catch-all fallback for blank-line collapse and long-line truncation |

### Safety net

Compression is a pre-filter. The agent still applies:

1. **cap_tool_result** — per-result truncation (80 + 80 lines or 20k character fallback)
2. **apply_tool_result_budget** — global budget truncating oldest results when total context exceeds limits

If compression returns raw input unchanged, the safety net still fires.

### Observability

Calls emit structured `tracing::info!` events on the `cersei_compression` target:

```rust
use tracing_subscriber::EnvFilter;

tracing_subscriber::fmt()
    .with_env_filter(EnvFilter::new("cersei_compression=info"))
    .init();
```

Or set `RUST_LOG=cersei_compression=info` when running.

Sample event from a live run:

```
INFO cersei_compression: tool-output compressed
  tool="Bash" level=aggressive strategy="shell" detail="cargo-test"
  before_bytes=2893 after_bytes=1565
  before_lines=76 after_lines=30
  savings_pct="45.9"
```

Fields emitted:

| Field | Meaning |
|-------|---------|
| `tool` | Tool name producing the output |
| `level` | off / minimal / aggressive |
| `strategy` | shell / code / passthrough / web / unknown / unknown-capped |
| `detail` | Matched rule name or detected language |
| `before_bytes` / `after_bytes` | Byte counts |
| `before_lines` / `after_lines` | Line counts |
| `savings_pct` | Percentage savings to one decimal place |

## Compression Benchmarks (/docs/compression-benchmarks)

### TL;DR

| Provider          | Model              | Off → Aggressive (input tokens) | **Savings** | tool\_calls | turns |
| ----------------- | ------------------ | ------------------------------- | ----------- | ----------- | ----- |
| **OpenAI**        | `gpt-4o-mini`      | **11,576 → 8,202**              | **29.1%**   | 15 → 13     | 5 → 5 |
| **Google Gemini** | `gemini-2.5-flash` | **4,490 → 1,700**               | **62.1%**   | 1 → 1       | 5 → 3 |

Both assertions pass: `aggressive < off` and `savings ≥ 10%` on real provider bills. Numbers are from runs captured on 2026-04-20.

Savings ratios are not fixed—they depend on how much of the turn's context is tool output versus system prompt, tool schemas, and assistant turns.

### Synthetic Fixture Baselines

Run: `cargo test -p cersei-compression`

| Fixture             | Level        | Savings floor                   | Source                                                      |
| ------------------- | ------------ | ------------------------------- | ----------------------------------------------------------- |
| `git log` output    | `Minimal`    | ≥ 30%                           | `tests/savings.rs::git_log_saves_at_least_30pct_minimal`    |
| `cargo test` output | `Minimal`    | ≥ 25%                           | `tests/savings.rs::cargo_test_saves_at_least_25pct_minimal` |
| Rust source file    | `Aggressive` | bodies dropped, signatures kept | `tests/savings.rs::rust_source_aggressive_drops_bodies`     |
| Any                 | `Off`        | exact byte-for-byte identity    | `tests/savings.rs::off_level_is_exact_passthrough`          |

### Live Provider Benchmarks

Tests are `#[ignore]` by default. Run with `-- --ignored` and the relevant API key set.

**OpenAI (2026-04-20, `gpt-4o-mini`):**

```
── openai run 1: CompressionLevel::Off ──
  off       : input=11576  output=276  total=11852  tool_calls=15  turns=5

── openai run 2: CompressionLevel::Aggressive ──
  aggressive: input=8202   output=276  total=8478   tool_calls=13  turns=5

── openai compression saved 29.1% of input tokens (11576 → 8202) ──
```

**Gemini (2026-04-20, `gemini-2.5-flash`):**

```
── gemini run 1: CompressionLevel::Off ──
  off       : input=4490  output=29  total=4519  tool_calls=1  turns=5

── gemini run 2: CompressionLevel::Aggressive ──
  aggressive: input=1700  output=52  total=1752  tool_calls=1  turns=3

── gemini compression saved 62.1% of input tokens (4490 → 1700) ──
```

### Compression Logs

Every call to `compress_tool_output` emits a `tracing::info!` event on the `cersei_compression` target. Sample:

```
INFO cersei_compression: tool-output compressed
  tool="Bash" level=aggressive strategy="shell" detail="cargo-test"
  before_bytes=2893 after_bytes=1565
  before_lines=76 after_lines=30
  savings_pct="45.9"
```

### Synthetic vs Live Differences

Synthetic tests measure input-to-output in isolation; live tests measure the full billing turn including system prompt, tool schemas, and previous assistant turns. Compression only touches tool-result content, not assistant messages or schemas, so real-world ratios are typically lower than synthetic measurements.

### Regression Guard

`off_level_is_exact_passthrough` asserts byte-for-byte identity when compression is off, making the feature opt-in with zero risk.

### Hardware & Reproducibility

* Numbers captured on Apple M1 Pro against production endpoints on 2026-04-20
* Token counts are provider-reported
* `gpt-4o-mini`'s tool-call loop is non-deterministic (±2 calls); Gemini's single-call pattern is stable


---

# VMs (Sandboxes)

## Sandboxes & VMs Overview (/docs/vms-overview)

### cersei-vms

`cersei-vms` represents the 15th crate in the workspace, introducing a pluggable sandbox runtime layer that prevents Cersei agents from executing shell commands directly on the host machine. The crate provides three cross-sandbox primitives—`Volume`, `Mailbox`, and `KvStore`—enabling safe communication and state sharing among parallel agents.

#### Design Inspiration

The trait structure mirrors E2B's SDK almost identically, allowing familiar mental models to transfer directly. However, unlike E2B, `cersei-vms` offers first-party Rust implementation, runs locally via Docker by default, and includes cross-sandbox primitives natively.

#### Why a Sandbox Layer Exists

Without sandboxing, Cersei faces three structural limitations:

1. **Security concerns with untrusted code**: Model-generated shell commands execute with the user's full privileges
2. **No isolation for parallel agents**: When spawning N parallel sub-agents, they share filesystem and process namespace, causing write conflicts and environment variable collisions
3. **Missing cross-agent communication**: No shared state mechanism, volume sharing, or message bus between independent agents

The sandbox layer resolves all three issues.

### Core Components

**Runtimes**: The `SandboxRuntime` trait supports two backends: `LocalProcessRuntime` (test-focused, no isolation) and `DockerRuntime` (real container isolation via local Docker CLI)

**Per-sandbox surface**: Each `Sandbox` exposes `commands()` for process control and `filesystem()` for file operations

**Cross-sandbox primitives**: `Volume` (host-mounted directories), `Mailbox` (broadcast pub/sub), `KvStore` (versioned compare-and-swap)

**Snapshots**: Native `Sandbox::snapshot()` and `SandboxRuntime::restore()` methods with manifest storage in `~/.cersei/vms/snapshots/`

**envd daemon**: A minimal Rust JSON-RPC 2.0 daemon living inside container images, communicating via bind-mounted Unix socket

**Transparent routing**: When a `Sandbox` handle appears in `ToolContext.extensions`, `BashTool` automatically routes through it without tool list modifications

### Quick Example

```rust
use cersei::prelude::*;
use cersei::vms::prelude::*;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. Spin up a local-process runtime (use DockerRuntime in prod).
    let runtime = LocalProcessRuntime::new()?;

    // 2. Allocate a sandbox.
    let sb = runtime
        .create(SandboxOpts::image("cersei/sandbox-base:latest"))
        .await?;

    // 3. Run a command inside it.
    let out = sb
        .commands()
        .run(RunRequest::new("echo hello && pwd"))
        .await?;
    println!("{} (exit {})", out.stdout.trim(), out.exit_code);

    // 4. Read/write files inside it.
    sb.filesystem().write("/work/note.txt", b"first-party").await?;
    let bytes = sb.filesystem().read("/work/note.txt").await?;
    assert_eq!(&bytes[..], b"first-party");

    // 5. Snapshot mid-run, kill, restore later — state survives.
    let snap = sb.snapshot().await?;
    sb.kill().await?;
    let restored = runtime.restore(&snap).await?;
    let again = restored.filesystem().read("/work/note.txt").await?;
    assert_eq!(&again[..], b"first-party");
    Ok(())
}
```

### Architecture Overview

Multiple sandboxes connect to a single host broker for `Volume`, `Mailbox`, and `KvStore` primitives. All sandbox-to-sandbox messages route through the host rather than requiring direct network links, maintaining a simplified security model.

### Workspace Integration

| Crate | Role |
|-------|------|
| `cersei-types` | Foundation types (unchanged) |
| **`cersei-vms`** | **Sandbox runtimes, traits, primitives, snapshots, envd daemon (new in 0.1.9)** |
| `cersei-tools` | Optional `vms` feature routes `BashTool` through sandboxes; provides new `vm_tools` module |
| `cersei` (facade) | Re-exports `cersei::vms` with default-enabled `vms` feature |

### Phase 1 Release (0.1.9)

- `SandboxRuntime`, `Sandbox`, `Commands`, `Filesystem` traits
- `LocalProcessRuntime` and `DockerRuntime` backends
- `Volume`, `Mailbox`, `KvStore` primitives
- Snapshot/restore functionality for both backends
- `cersei-envd` binary and reference Dockerfile
- Transparent routing and new `vm_tools` module
- Nine integration tests covering primitives and snapshots

### Planned Phase 2 (0.1.10)

- `AgentBuilder` sandbox integration methods
- Per-task allocator for `cersei-agent::delegate`
- CLI sandbox flag and slash command support
- Additional runtimes: `FirecrackerRuntime`, `E2bRuntime`, `VercelSandboxRuntime`
- Advanced features: pause/unpause, incremental snapshots, snapshot garbage collection

## Sandboxes & VMs — API Documentation (/docs/vms-api)

### Overview

The `cersei-vms` crate provides sandbox and VM management capabilities through Rust traits and types. All public APIs are available under `cersei_vms` and re-exported as `cersei::vms` with the default-enabled `vms` feature.

### Feature Flags

| Flag | Default | Purpose |
|------|---------|---------|
| `backend-docker` | ✅ | Docker container runtime support |
| `backend-firecracker` | | Phase 2 Linux microVM backend (reserved) |
| `backend-e2b` | | Phase 2 remote E2B backend (reserved) |
| `envd` | ✅ | Builds the `cersei-envd` binary target |

### Core Traits

#### SandboxRuntime

Top-level trait managing a pool of sandboxes and host-side broker components:

```rust
#[async_trait]
pub trait SandboxRuntime: Send + Sync {
    fn name(&self) -> &str;
    fn capabilities(&self) -> RuntimeCaps;

    async fn create(&self, opts: SandboxOpts) -> Result<SandboxHandle>;
    async fn get(&self, id: &SandboxId) -> Result<SandboxHandle>;
    async fn list(&self) -> Result<Vec<SandboxInfo>>;

    async fn restore(&self, snapshot: &SnapshotId) -> Result<SandboxHandle>;
}
```

`SandboxHandle` is an alias for `Arc<dyn Sandbox>`.

#### RuntimeCaps

Advertises backend capabilities without trial-and-error:

```rust
pub struct RuntimeCaps {
    pub snapshots: bool,
    pub pause_resume: bool,
    pub gpu: bool,
    pub network_isolation: bool,
    pub shared_volumes: bool,
    pub remote: bool,
}
```

| Backend | snapshots | pause_resume | network_isolation | shared_volumes | remote |
|---------|:---------:|:------------:|:-----------------:|:--------------:|:------:|
| LocalProcessRuntime | ✅ | ❌ | ❌ | ✅ | ❌ |
| DockerRuntime | ✅ | ❌¹ | ✅ | ✅ | ❌ |

¹ Phase 1 leaves pause_resume disabled; implemented in version 0.1.10.

### Backends

#### LocalProcessRuntime

Spawns plain `tokio::process` children without real isolation. Each sandbox owns a directory under `~/.cersei/vms/local/<sandbox_id>/rootfs/`.

```rust
let rt = LocalProcessRuntime::new()?;          // ~/.cersei/vms/local
let rt = LocalProcessRuntime::with_root(tmp)?; // arbitrary root for tests
```

Suitable for unit tests, development mode (`--sandbox local`), and as a no-op fallback.

#### DockerRuntime

Real container isolation via local `docker` CLI shells-out for every operation. Works identically on macOS, Linux, and Windows.

```rust
let rt = DockerRuntime::new()?;                            // looks up docker on PATH
let rt = DockerRuntime::with_docker_bin("/opt/bin/docker")?; // custom binary
```

Lifecycle mapping:

| Trait method | docker call |
|--------------|-------------|
| `create()` | `docker create [--mount …] [--env …] [-l …] <image> /bin/sh -c "tail -f /dev/null"` then `docker start` |
| `Commands::run()` | `docker exec [-w …] [-e …] <name> /bin/sh -c <cmd>` |
| `Commands::stream()` | same, piped |
| `Filesystem::read/write` | `docker exec cat` for read, `docker cp` for write |
| `Filesystem::list/stat/mkdir/remove` | `docker exec /bin/sh -c '…'` |
| `snapshot()` | `docker commit <name> cersei-snapshot:<snap_id>` + JSON manifest |
| `restore(&snap)` | `create()` with snapshot image tag |
| `pause()` / `resume()` | Phase 2 (`docker pause`/`unpause`) |
| `kill()` | `docker rm -f <name>` |

### Sandbox Interface

#### Sandbox Trait

```rust
#[async_trait]
pub trait Sandbox: Send + Sync {
    fn id(&self) -> &SandboxId;
    fn info(&self) -> SandboxInfo;
    fn commands(&self) -> Arc<dyn Commands>;
    fn filesystem(&self) -> Arc<dyn Filesystem>;

    async fn snapshot(&self) -> Result<SnapshotId>;
    async fn pause(&self) -> Result<()>;
    async fn resume(&self) -> Result<()>;
    async fn kill(&self) -> Result<()>;
}
```

#### SandboxOpts

Builder-style configuration with sensible defaults (targets `cersei/sandbox-base:latest` with `/work` as workdir):

```rust
pub struct SandboxOpts {
    pub image: String,
    pub workdir: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub volumes: Vec<VolumeMount>,
    pub cpu_limit: Option<f32>,
    pub mem_limit: Option<u64>,
    pub labels: HashMap<String, String>,
    pub from_snapshot: Option<SnapshotId>,
    pub mailbox_topics: Vec<String>,
}
```

Builder convenience methods:

```rust
let opts = SandboxOpts::image("alpine:3.20")
    .with_workdir("/work")
    .with_env("LANG", "C.UTF-8")
    .with_volume(VolumeMount {
        volume_id: shared_vol.id.clone(),
        mount_path: "/shared".into(),
        read_only: false,
    })
    .with_label("cersei.task", "build");
```

#### SandboxInfo & SandboxStatus

Current sandbox state snapshot:

```rust
pub enum SandboxStatus { Creating, Running, Paused, Exited, Killed, Failed }

pub struct SandboxInfo {
    pub id: SandboxId,
    pub backend: String,                          // "local" | "docker"
    pub image: String,
    pub status: SandboxStatus,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub labels: HashMap<String, String>,
}
```

### Commands Interface

#### Commands Trait

```rust
#[async_trait]
pub trait Commands: Send + Sync {
    async fn run(&self, req: RunRequest) -> Result<RunOutput>;
    async fn stream(&self, req: RunRequest) -> Result<CommandStream>;
    async fn signal(&self, pid: u32, sig: Signal) -> Result<()>;
}
```

#### RunRequest

```rust
pub struct RunRequest {
    pub command: String,
    pub workdir: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub timeout: Option<Duration>,    // default 120s, max 600s
    pub background: bool,
}
```

Builder pattern:

```rust
let req = RunRequest::new("cargo test --quiet")
    .workdir("/work/myproj")
    .env("RUST_BACKTRACE", "1")
    .timeout(Duration::from_secs(300));
```

#### RunOutput

```rust
pub struct RunOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
    pub timed_out: bool,
    pub pid: Option<u32>,    // populated for background runs
}
```

#### CommandStream

Streaming output as `Pin<Box<dyn Stream<Item = StreamChunk> + Send>>`:

```rust
pub enum StreamChunk {
    Started { pid: u32 },
    Stdout  { data: String },   // one line per chunk
    Stderr  { data: String },
    Exit    { code: i32 },
    Error   { message: String },
}
```

Phase 1 streaming is host-to-sandbox output-only. Bidirectional stdin support lands in version 0.1.10.

#### Signal

POSIX-style signals mapping to numeric values:

```rust
pub enum Signal { Term, Kill, Int, Hup, Usr1, Usr2 }
```

### Filesystem Interface

#### Filesystem Trait

```rust
#[async_trait]
pub trait Filesystem: Send + Sync {
    async fn read(&self, path: &str) -> Result<Bytes>;
    async fn write(&self, path: &str, data: &[u8]) -> Result<()>;
    async fn list(&self, path: &str, depth: u32) -> Result<Vec<FileEntry>>;
    async fn stat(&self, path: &str) -> Result<FileEntry>;
    async fn watch(&self, path: &str, recursive: bool) -> Result<WatchStream>;
    async fn mkdir(&self, path: &str, recursive: bool) -> Result<()>;
    async fn remove(&self, path: &str, recursive: bool) -> Result<()>;
    async fn upload(&self, local: &Path, remote: &str) -> Result<()>;
    async fn download(&self, remote: &str, local: &Path) -> Result<()>;
}
```

#### FileEntry

```rust
pub enum FileKind { File, Dir, Symlink }

pub struct FileEntry {
    pub path: PathBuf,
    pub kind: FileKind,
    pub size: u64,
    pub modified_unix_ms: i64,
}
```

The `watch()` method returns `Pin<Box<dyn Stream<Item = FileEvent> + Send>>` but is not implemented in Phase 1; both backends return a lifecycle error indicating Phase 1 status. Implementation lands in version 0.1.10.

### Cross-Sandbox Primitives

All three primitives live on the host inside the runtime-owning process. Sandboxes reach them via Unix socket bind-mount (Docker) or direct in-process calls (Local).

#### Volume & VolumeRegistry

Persistent host-side directories bindable into multiple sandboxes:

```rust
pub struct Volume {
    pub id: VolumeId,
    pub label: Option<String>,
    pub host_path: PathBuf,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

let reg = VolumeRegistry::default_user()?;       // ~/.cersei/vms/volumes
let shared = reg.create(Some("build-cache".into()))?;
// `shared.host_path` is now bind-mountable.
```

Volumes mount via `SandboxOpts::with_volume(...)`.

#### Mailbox & MailboxSubscription

Broadcast pub/sub keyed by string topic, backed by `tokio::sync::broadcast::channel`:

```rust
let mailbox = Mailbox::new();                          // or with_capacity(N)
let mut sub = mailbox.subscribe("workers/results");
mailbox.publish("workers/results", SandboxId::new(), json!({ "ok": true }))?;
let env: MailboxEnvelope = sub.recv().await?;
```

`MailboxEnvelope` carries topic, from, seq, sent_at_unix_ms, and payload. At-most-once semantics with no persistence.

#### KvStore

Shared K/V map across sandboxes using DashMap plus optional journaling:

```rust
let kv = KvStore::open("~/.cersei/vms/kv.json")?;
let entry = kv.set("progress", b"42".to_vec())?;
let again = kv.cas("progress", Some(entry.version), b"43".to_vec())?;
// `Ok(None)` on version mismatch, `Ok(Some(new_entry))` on success.
```

Supports versioned compare-and-swap for race-free updates.

### Snapshots

#### SnapshotManifest

```rust
pub struct SnapshotManifest {
    pub id: SnapshotId,
    pub backend: String,                    // "local" | "docker"
    pub fs_pointer: String,                 // backend-specific FS state pointer
    pub original_opts: SandboxOpts,
    pub volumes: Vec<VolumeMount>,
    pub kv: KvSnapshot,
    pub mailbox_topics: Vec<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub labels: HashMap<String, String>,
}
```

`fs_pointer` interpretation varies by backend:

| Backend | fs_pointer |
|---------|-----------|
| local | Relative path under `<root>/_snapshots/` containing a tree copy |
| docker | Image tag `cersei-snapshot:<snap_id>` produced by `docker commit` |

`SnapshotRegistry::open(path)` or `SnapshotRegistry::default_user()` opens or creates the host-side store. `SnapshotRegistry::list()` enumerates manifests.

### envd Protocol

`cersei-envd` is a JSON-RPC 2.0 daemon living inside sandbox container images, listening on a Unix socket path given by `$CERSEI_ENVD_SOCKET` (default `/run/cersei-envd.sock`). Wire format is line-delimited JSON — one request and response per line. Multiple concurrent connections are supported.

#### envd Methods

| Method | Params | Returns |
|--------|--------|---------|
| `ping` | `{}` | `{ "ok": true, "ts": <unix_ms> }` |
| `info` | `{}` | `{ "envd_version": "...", "uname": "..." }` |
| `process.run` | `RunRequest` | `RunOutput` |
| `fs.read` | `{ "path": "..." }` | `{ "data_b64": "..." }` |
| `fs.write` | `{ "path": "...", "data_b64": "..." }` | `{ "ok": true, "bytes_written": N }` |
| `fs.list` | `{ "path": "...", "depth": N }` | `[FileEntry, ...]` |
| `fs.stat` | `{ "path": "..." }` | `FileEntry` |
| `fs.mkdir` | `{ "path": "...", "recursive": bool }` | `{ "ok": true }` |
| `fs.remove` | `{ "path": "...", "recursive": bool }` | `{ "ok": true }` |

Building the daemon:

```bash
cargo build -p cersei-vms --bin cersei-envd --release --features envd
```

The reference image (`crates/cersei-vms/docker/Dockerfile`) includes it at `/usr/local/bin/cersei-envd`.

### Error Types

```rust
pub enum VmError {
    NotFound(String),
    SnapshotNotFound(String),
    VolumeNotFound(String),
    Lifecycle(String),
    Transport(String),
    Backend { backend: String, message: String },
    Timeout(Duration),
    Permission(String),
    Snapshot(String),
    Mailbox(String),
    Kv(String),
    Invalid(String),
    Io(std::io::Error),
    Json(serde_json::Error),
    Other(anyhow::Error),
}

pub type Result<T> = std::result::Result<T, VmError>;
```

### Integration with cersei-tools

The `vms` feature on `cersei-tools` adds optional `cersei-vms` dependency and wires two integration points.

#### Transparent Routing in BashTool

When `Arc<dyn cersei_vms::Sandbox>` is present in `ToolContext.extensions`, `BashTool::execute()` routes commands through the sandbox:

```rust
use cersei_tools::ToolContext;
use cersei_vms::Sandbox;
use std::sync::Arc;

let sandbox: Arc<dyn Sandbox> = runtime.create(opts).await?;
let ctx: ToolContext = /* … */;
ctx.extensions.insert::<Arc<dyn Sandbox>>(sandbox);
// `BashTool` now runs every command inside the sandbox.
```

#### Agent-Facing Tools (cersei_tools::vm_tools)

| Tool | Permission | Purpose |
|------|-----------|---------|
| `SendVmMessage` | Write | Publish JSON to mailbox topic |
| `RecvVmMessage` | ReadOnly | Block on next envelope for topic with timeout |
| `SharedStateGet` | ReadOnly | Read KvStore entry |
| `SharedStateSet` | Write | Write/CAS KvStore entry |
| `SandboxSnapshot` | Write | Snapshot the active sandbox |

All five require corresponding primitives registered in `ToolContext.extensions` plus an active `Arc<dyn Sandbox>` handle.

## Sandboxes & VMs — Cookbook (/docs/vms-cookbook)

The cersei-vms Cookbook provides practical, ready-to-use examples paired with the VMs API reference documentation.

### Recipe 1 — Transparent routing

Enable every `BashTool` invocation to execute within a sandbox without modifying your tool list. The implementation injects a sandbox into the agent's `ToolContext.extensions`. An important safety feature: "if no `Arc<dyn Sandbox>` is present, `BashTool` runs on the host exactly as before."

```rust
use cersei::prelude::*;
use cersei::vms::prelude::*;
use std::sync::Arc;

# async fn run() -> Result<(), Box<dyn std::error::Error>> {
let runtime = LocalProcessRuntime::new()?;
let sandbox: Arc<dyn Sandbox> = runtime
    .create(SandboxOpts::image("cersei/sandbox-base:latest"))
    .await?;

let ctx: cersei::tools::ToolContext = build_context_however_you_normally_do();
ctx.extensions.insert::<Arc<dyn Sandbox>>(sandbox.clone());

let agent = Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::coding())
    .build()?;
let out = agent.run("ls -la /work").await?;
println!("{}", out.text());
# Ok(())
# }
# fn build_context_however_you_normally_do() -> cersei::tools::ToolContext { todo!() }
```

### Recipe 2 — Shared volume between two sandboxes

Two parallel sandboxes that read and write to the same host directory using a shared `VolumeRegistry`.

```rust
use cersei::vms::prelude::*;
use cersei_vms::VolumeRegistry;

# async fn run() -> cersei_vms::Result<()> {
let runtime = DockerRuntime::new()?;
let volumes = VolumeRegistry::default_user()?;
let shared = volumes.create(Some("recipe-2".into()))?;

let mount = VolumeMount {
    volume_id: VolumeId(shared.host_path.display().to_string()),
    mount_path: "/shared".into(),
    read_only: false,
};

let a = runtime
    .create(SandboxOpts::image("cersei/sandbox-base:latest").with_volume(mount.clone()))
    .await?;
let b = runtime
    .create(SandboxOpts::image("cersei/sandbox-base:latest").with_volume(mount))
    .await?;

a.commands().run(RunRequest::new("echo from-a > /shared/note.txt")).await?;
let out = b.commands().run(RunRequest::new("cat /shared/note.txt")).await?;
assert_eq!(out.stdout.trim(), "from-a");

a.kill().await?;
b.kill().await?;
# Ok(())
# }
```

### Recipe 3 — Coordinating parallel agents through the Mailbox

Two sandboxes exchange JSON messages over a topic while a coordinator listens for published events.

```rust
use cersei::vms::prelude::*;
use serde_json::json;

# async fn run() -> cersei_vms::Result<()> {
let runtime = LocalProcessRuntime::new()?;
let mailbox = runtime.mailbox();

let worker_a = runtime.create(SandboxOpts::default()).await?;
let worker_b = runtime.create(SandboxOpts::default()).await?;

let mut sub = mailbox.subscribe("workers/results");

mailbox.publish(
    "workers/results",
    worker_a.id().clone(),
    json!({ "status": "ok", "tests_passed": 42 }),
)?;

mailbox.publish(
    "workers/results",
    worker_b.id().clone(),
    json!({ "status": "ok", "tests_passed": 17 }),
)?;

for _ in 0..2 {
    let env = sub.recv().await?;
    println!("from {}: {}", env.from, env.payload);
}
# worker_a.kill().await?;
# worker_b.kill().await?;
# Ok(())
# }
```

The same flow is available from within agent loops via `SendVmMessage` and `RecvVmMessage` tools.

### Recipe 4 — `KvStore` with CAS

Implement a race-free counter incremented from N parallel workers using compare-and-swap semantics.

```rust
use cersei::vms::prelude::*;

# fn run() -> cersei_vms::Result<()> {
let kv = KvStore::open("/tmp/cersei-counter.json")?;
kv.set("counter", b"0".to_vec())?;

fn bump(kv: &KvStore) -> cersei_vms::Result<u64> {
    loop {
        let current = kv.get("counter");
        let (value, version) = match &current {
            Some(e) => (
                std::str::from_utf8(&e.value).unwrap().parse::<u64>().unwrap(),
                Some(e.version),
            ),
            None => (0, None),
        };
        let next = value + 1;
        if let Some(new) = kv.cas("counter", version, next.to_string().into_bytes())? {
            return Ok(new.version);
        }
    }
}

let _ = bump(&kv)?;
# Ok(())
# }
```

Agents can use the same pattern via `SharedStateSet` with an `expected_version` field. CAS failures return as tool errors, prompting automatic retry.

### Recipe 5 — Two LLM agents coordinating via the Mailbox tool

Both agents operate in separate sandboxes. One performs discovery while the other handles work, exchanging information through a shared message topic.

```rust
use cersei::prelude::*;
use cersei::vms::prelude::*;
use std::sync::Arc;

# async fn run() -> Result<(), Box<dyn std::error::Error>> {
let runtime = Arc::new(DockerRuntime::new()?);
let mailbox = runtime.mailbox();
let kv = runtime.kv();

let scout = runtime.create(SandboxOpts::default()).await?;
let worker = runtime.create(SandboxOpts::default()).await?;

let mut scout_tools = cersei::tools::coding();
scout_tools.extend(cersei::tools::vm_tools::all_vm_tools());

let mut worker_tools = cersei::tools::coding();
worker_tools.extend(cersei::tools::vm_tools::all_vm_tools());

# Ok(())
# }
```

The `all_vm_tools()` function returns boxed tools for `SendVmMessage`, `RecvVmMessage`, `SharedStateGet`, `SharedStateSet`, and `SandboxSnapshot`. Permission gating follows existing tool patterns: `Write` for publish/set/snapshot operations and `ReadOnly` for recv/get operations.

### Recipe 6 — Snapshot-driven retry

Create a checkpoint before executing a risky operation; if it fails, restore and attempt an alternative approach.

```rust
use cersei::vms::prelude::*;

# async fn run() -> cersei_vms::Result<()> {
let runtime = DockerRuntime::new()?;
let sb = runtime.create(SandboxOpts::default()).await?;

sb.commands().run(RunRequest::new("git clone https://example.com/repo /work/repo")).await?;
let checkpoint = sb.snapshot().await?;

let attempt = sb
    .commands()
    .run(RunRequest::new("cd /work/repo && ./scripts/migrate.sh"))
    .await?;

if attempt.exit_code != 0 {
    sb.kill().await?;
    let restored = runtime.restore(&checkpoint).await?;
    restored
        .commands()
        .run(RunRequest::new("cd /work/repo && ./scripts/migrate-safe.sh"))
        .await?;
}
# Ok(())
# }
```

Snapshots persist across process restarts via manifests stored in `~/.cersei/vms/snapshots/<id>.json` and Docker image tags.

### Recipe 7 — End-to-end Docker setup

Build the reference image and run a sandbox from the command line.

```bash
cargo build --release -p cersei-vms --bin cersei-envd --features envd

docker build \
    -t cersei/sandbox-base:latest \
    --build-arg ENVD_BIN=target/release/cersei-envd \
    crates/cersei-vms/docker/

docker run --rm cersei/sandbox-base:latest /usr/local/bin/cersei-envd --help || true

cargo run --release --example vms_docker_smoke
```

### Recipe 8 — Mounting a project read-only

Enable code review agents to inspect repository contents without permitting mutations.

```rust
use cersei::vms::prelude::*;
use std::path::PathBuf;

# async fn run() -> cersei_vms::Result<()> {
let opts = SandboxOpts::image("cersei/sandbox-base:latest").with_volume(VolumeMount {
    volume_id: VolumeId(PathBuf::from("/Users/me/projects/myrepo").display().to_string()),
    mount_path: "/work/repo".into(),
    read_only: true,
});

let runtime = DockerRuntime::new()?;
let sb = runtime.create(opts).await?;
let out = sb
    .commands()
    .run(RunRequest::new("touch /work/repo/test.txt"))
    .await?;
assert_ne!(out.exit_code, 0);
# Ok(())
# }
```

### What's next

* VMs Overview — concepts and architecture
* VMs API — complete type and method reference
* Changelog — version history and upcoming features


---

# Runtime: Sessions, Background Tasks, System Prompts

## Sessions (/docs/sessions)

Every conversation in Cersei is a session. Messages are persisted as append-only JSONL, compacted when the context window fills up, and consolidated into long-term memory overnight. Sessions survive agent restarts, provider switches, and schema migrations.

### Storage Format

Sessions are stored as `.jsonl` files — one JSON object per line, append-only. Each entry is a `TranscriptEntry`:

```
{"type":"user","uuid":"a1b2...","timestamp":"2026-04-03T10:00:00Z","session_id":"abc","cwd":"/project","message":{"role":"user","content":"fix the tests"}}
{"type":"assistant","uuid":"c3d4...","parent_uuid":"a1b2...","timestamp":"2026-04-03T10:00:05Z","session_id":"abc","cwd":"/project","message":{"role":"assistant","content":"..."}}
{"type":"tombstone","deleted_uuid":"a1b2...","timestamp":"2026-04-03T10:01:00Z"}
{"type":"summary","uuid":"e5f6...","timestamp":"2026-04-03T10:02:00Z","session_id":"abc","summary":"User asked to fix tests...","messages_compacted":8}
```

#### Message Fields

| Field | Type | Description |
|-------|------|-------------|
| uuid | String | Unique message identifier (UUID v4) |
| parent_uuid | Option<String> | Links assistant responses to the user message they reply to |
| timestamp | String | RFC3339 timestamp of when the message was created |
| session_id | String | Session this message belongs to |
| cwd | String | Working directory at the time of the message |
| message | Message | The actual message content (role + content blocks) |
| is_sidechain | bool | Whether this message is from a sidechain (sub-agent or background task) |

**Location:** `~/.claude/projects/{sanitized-project-root}/{session-id}.jsonl`

**Size limit:** 50MB per part file. When a session exceeds this, writes automatically fork to `{session-id}_part2.jsonl`, `_part3.jsonl`, etc. Loading stitches all parts together. Total limit across all parts: 200MB. Compatible with Claude Code's session format.

### Session APIs

#### Writing

```rust
use cersei::memory::manager::MemoryManager;

let mm = MemoryManager::new(project_root);

// Write a user message — returns the UUID
let user_uuid = mm.write_user_message("session-1", Message::user("fix the tests"))?;

// Write an assistant response linked to the user message
let asst_uuid = mm.write_assistant_message(
    "session-1",
    Message::assistant("I'll fix those tests."),
    Some(&user_uuid),
)?;
```

#### Loading

```rust
// Load all messages (tombstones applied, summaries included)
let messages = mm.load_session_messages("session-1")?;
for msg in &messages {
    println!("[{}] {}", msg.role, msg.get_text().unwrap_or(""));
}
```

Loading is a two-pass process: first collect all tombstone UUIDs, then load messages while skipping tombstoned ones. This means soft-deleted messages never appear in the loaded history.

#### Listing

```rust
let sessions = mm.list_sessions();
for session in &sessions {
    println!("{} — {} messages, created {}", session.id, session.message_count, session.created_at);
}
```

### Resume and Recovery

#### Resuming a Session

Pass the same `session_id` to the agent builder. The runner loads history from the session file on startup.

```rust
let agent = Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::coding())
    .memory(JsonlMemory::new("./sessions"))
    .session_id("my-session")
    .build()?;

// First run — starts fresh
agent.run("What files are in src/?").await?;

// Later — same session_id, resumes with full history
agent.run("Now fix the bug you found").await?;
```

When `with_messages()` is used (e.g., during provider switching), the runner skips loading from memory to prevent duplicates.

#### Abstract CLI

```bash
abstract --resume                # resume the most recent session
abstract --resume abc12345       # resume a specific session by ID
abstract sessions list           # list all sessions with size and date
abstract sessions show abc12345  # view transcript
abstract sessions rm abc12345    # delete a session
```

#### Soft Delete (Tombstones)

Individual messages can be soft-deleted without removing the session file:

```rust
use cersei_memory::session_storage;

session_storage::tombstone_entry(&session_path, "message-uuid-to-delete")?;
```

The message stays in the file but is skipped on load. This preserves the audit trail while removing unwanted content. Tombstones work across part files — a tombstone in `_part3` can delete a message from the base file.

### Auto-Fork (Multi-Part Sessions)

When a session file grows past 50MB, writes automatically fork to a new part file. This is transparent — you don't need to change any code. The MemoryManager, agent runner, and CLI all handle multi-part sessions automatically.

#### How It Works

1. Before each write, the storage layer checks the current file's size
2. If `file_size + entry_size > 50MB`, the write goes to the next part file instead
3. Part naming: `session.jsonl` → `session_part2.jsonl` → `session_part3.jsonl` → ...
4. Loading reads all parts in order and stitches them into a single transcript
5. Tombstones apply across all parts — a tombstone in any part can delete a message in any other part

#### File Layout

```
~/.claude/projects/-my-project/
├── abc12345.jsonl          # base file (up to 50MB)
├── abc12345_part2.jsonl    # auto-forked when base exceeded 50MB
├── abc12345_part3.jsonl    # auto-forked when part2 exceeded 50MB
└── def67890.jsonl          # a different session (single file)
```

#### Inspecting Parts

```rust
use cersei_memory::session_storage::{all_part_paths, total_session_size};

let base = Path::new("~/.claude/projects/-my-project/abc12345.jsonl");

// List all parts
let parts = all_part_paths(base);
println!("{} part(s)", parts.len());

// Total size across all parts
let bytes = total_session_size(base);
println!("Total: {} MB", bytes / 1_000_000);
```

#### Limits

| Limit | Value |
|-------|-------|
| Per-part file | 50MB |
| Total across all parts | 200MB |
| Part count | Unlimited (practical limit ~4 parts at 50MB each) |

With auto-compact enabled (default), most sessions never reach a single fork. A typical 100-turn coding session produces ~500KB. You'd need thousands of resumed turns with compaction disabled to hit 50MB.

#### CLI

`abstract sessions rm` removes all parts automatically:

```bash
abstract sessions rm abc12345
# Deleted session: abc12345 (3 parts)
```

`abstract sessions list` shows the combined size across parts.

### Auto-Compact

When a conversation approaches the model's context window limit, the agent automatically summarizes older messages to free space.

#### Configuration

```rust
Agent::builder()
    .auto_compact(true)          // enable (default: true)
    .compact_threshold(0.9)      // trigger at 90% of context window
    .tool_result_budget(50_000)  // truncate oldest tool results above 50K chars
```

#### How It Works

1. Before each turn, the agent counts tokens in the conversation
2. If usage exceeds the threshold (default 90%), compaction triggers
3. Old messages are grouped at API-round boundaries (user→assistant→tool cycles)
4. The model summarizes each group into a `<context_summary>` block
5. Originals are replaced with the summary
6. The 10 most recent messages are always preserved
7. Events emitted: `CompactStart` and `CompactEnd` (with `tokens_freed`)

#### Circuit Breaker

If compaction fails 3 times in a row (e.g., the summary call itself fails), auto-compact disables for the rest of the session. This prevents an infinite failure loop.

#### Context Windows

| Model | Window |
|-------|--------|
| Claude (all variants) | 200K tokens |
| GPT-4o, GPT-4 Turbo | 128K tokens |
| Gemini 2.0 Flash | 1M tokens |
| Default | 200K tokens |

### Memory Extraction

After enough conversation, the agent extracts durable facts and persists them to memory files. These facts survive across sessions — they become part of the system prompt context for future conversations.

#### Gates

All three conditions must be true for extraction to trigger:

| Gate | Type | Description | Default |
|------|------|-------------|---------|
| Message count | usize | At least 20 messages in the conversation | 20 |
| Tool calls since last | usize | At least 3 tool calls since the last extraction (skipped on first extraction) | 3 |
| No pending tools | bool | The last assistant message must not have unresolved tool_use blocks | — |

#### Categories

| Category | Label | What it captures |
|----------|-------|------------------|
| UserPreference | preference | User's role, coding style, tool preferences |
| ProjectFact | project | Architecture decisions, deadlines, dependencies |
| CodePattern | pattern | Recurring code patterns, conventions |
| Decision | decision | Why a particular approach was chosen |
| Constraint | constraint | Hard requirements ("must support Python 3.8+") |

Each extracted fact has a confidence score (0.0–1.0). Facts are appended to a `## Auto-extracted memories` section in the target memory file.

### Auto-Dream (Background Consolidation)

Auto-dream is a background process that periodically reviews session transcripts and consolidates insights into long-term memory files. It runs after the agent finishes its work — not during active conversation.

#### Three-Gate System

| Gate | Condition | Default | Purpose |
|------|-----------|---------|---------|
| Time | Hours since last consolidation | 24h | Prevent running too frequently |
| Sessions | New sessions since last run | 5 | Ensure enough new material |
| Lock | No active consolidation process | Stale after 1h | Prevent concurrent runs |

All three gates must pass. They're evaluated in order (cheapest first): time check is a timestamp comparison, session count scans the directory, lock check reads a file.

#### Consolidation Phases

The consolidation agent follows four phases:

1. **Orient** — read MEMORY.md, list existing memory files, understand what's already stored
2. **Gather** — scan recent session transcripts for new insights, search for patterns
3. **Consolidate** — write or update memory files with new facts, convert relative dates to absolute
4. **Prune** — update the MEMORY.md index, remove stale pointers, keep under 200 lines

#### State Persistence

Consolidation state is stored in `.consolidation_state.json`:

```json
{
  "last_consolidated_at": 1712150400,
  "lock_etag": null
}
```

The lock file (`.consolidation_lock`) contains a Unix timestamp. It's considered stale after 1 hour — if a consolidation process crashes, the next one can proceed after the stale period.

```rust
use cersei_agent::auto_dream::AutoDream;

let dreamer = AutoDream::new(memory_dir, conversations_dir);

if dreamer.should_consolidate() {
    dreamer.acquire_lock()?;
    // Run consolidation agent...
    dreamer.update_state()?;
    dreamer.release_lock()?;
}
```

### Production Guidance

#### Session File Size

Sessions are capped at 50MB. For long-running agents, enable auto-compact to keep sessions within bounds. A typical coding session (100 turns with tool calls) produces ~500KB of JSONL.

#### Debugging Sessions

Inspect a session file directly:

```bash
# Count messages
wc -l ~/.claude/projects/-my-project/session-id.jsonl

# View user messages only
grep '"type":"user"' session.jsonl | python3 -c "import sys,json; [print(json.loads(l)['message']['content'][:80]) for l in sys.stdin]"

# Check for tombstones
grep '"type":"tombstone"' session.jsonl
```

Or via the CLI:

```bash
abstract sessions show abc12345
```

#### Concurrent Access

Session files use append-only writes — multiple processes can safely append to the same file. However, loading is not atomic: if process A appends while process B is reading, B may see a partial last line. For multi-agent setups sharing a session, use file-level locking or separate session IDs per agent.

#### Cleanup

```bash
# Delete old sessions (older than 30 days)
find ~/.claude/projects -name "*.jsonl" -mtime +30 -delete

# Clear memory
abstract memory clear
```

## Background Tasks (/docs/background-tasks)

Cersei provides built-in task orchestration, scheduled job execution, and isolated git workspaces through its standard tool system. These features let the model manage long-running work, schedule recurring prompts, and work in parallel git branches — all through the standard tool system.

### Task System Overview

Tasks track work units across conversation turns: "Tasks track units of work across turns. The model creates a task, updates its status as work progresses, and stores the output when done." The registry is in-memory, concurrent-safe, and scoped to each session.

Tasks follow this lifecycle: `TaskCreate → Pending → Running → Completed` with possible transitions to `Failed` or `Stopped` states.

### Key Task Tools

- **TaskCreate** initiates work units with a description and optional associated prompt, returning a task identifier.
- **TaskGet** retrieves current task state (status, description, output, timestamps).
- **TaskUpdate** modifies a task's status and output as work progresses.
- **TaskList** displays all tasks with their identifiers, statuses, descriptions, and timestamps.
- **TaskStop** halts an active task.
- **TaskOutput** retrieves the complete output from finished tasks.

### Cron Scheduling

"Schedule recurring prompts that execute on a timer. Useful for periodic checks, monitoring, and automated maintenance."

Cron supports standard expressions (`*/5 * * * *` for every 5 minutes) and one-shot timers (`once:30s` format).

**CronCreate**, **CronList**, and **CronDelete** manage scheduled jobs. Cron jobs are in-memory — they run within the current agent session and stop when the agent exits.

### Git Worktree Isolation

**EnterWorktree** and **ExitWorktree** enable parallel branch work without affecting the main directory, useful for testing multiple implementation approaches simultaneously.

### Integration Patterns

The documentation describes combining these systems — pairing tasks with session memory, monitoring agent work via events, and implementing deployment patterns with sleep and polling mechanisms.

### Important Limitation

Both task registries and cron jobs are "in-memory only — they don't persist across agent restarts," requiring developers to use session transcripts for durable work tracking.

> _Note: the /docs/background-tasks page was retrievable but the fetch tool returned a condensed rendering on both attempts; code blocks and full tables on that page may not be reproduced verbatim above._

## System Prompts (/docs/system-prompts)

The system prompt defines how an agent thinks, acts, and communicates through 23 named components—some always present, some conditional based on configuration. The prompt is split at a cache boundary: the static portion before it qualifies for provider-level prompt caching, while everything after is recomputed each turn.

### How It's Built

The system prompt builder evaluates each component's inclusion rule against provided options, skipping components that don't apply to avoid wasted tokens. Components can be controlled through Rust code:

```rust
let opts = SystemPromptOptions {
    working_directory: Some("/my/project".into()),
    has_memory: true,
    has_auto_compact: true,
    tools_available: vec!["Agent".into(), "Skill".into(), "Read".into()],
    git_status: Some(GitSnapshot { branch: "main".into(), ..Default::default() }),
    ..Default::default()
};

let prompt = build_system_prompt(&opts);
```

### Always-Included Components

**Attribution** sets the agent's identity (varies by context: interactive, SDK, custom, or sub-agent). Models behave differently based on stated identity—an "agent" is more likely to take action than a helper.

**Core Capabilities** lists available tools and establishes the approach: understand before acting, make minimal changes, verify work, and communicate blockers.

**Tool Use Guidelines** prefer dedicated tools over shell equivalents (Read over cat, Grep over grep, etc.) for structured output and faster execution.

**Actions with Care** instructs the model to consider reversibility before destructive operations, requiring confirmation for hard-to-reverse actions.

**Safety Guidelines** cover file deletion, protected files, secrets, and ambiguous destructive actions—a self-regulation layer beyond mechanical permissions.

**Security** defines what's authorized versus prohibited (CTF challenges are okay; malware is not).

**Output Efficiency** directs the agent to lead with answers, avoid verbose explanations, and prefer brevity—directly affecting perceived speed.

**Tool Result Summarization** warns that old results may be cleared during auto-compact, instructing the model to capture important findings in response text.

### Conditional Components

**Sub-Agent Guidance** (when Agent/TaskCreate is available) teaches the model to launch parallel agents for independent tasks and delegate effectively.

**Skills Guidance** (when Skill tool is available) explains that `/<skill-name>` invokes skills from designated directories.

**Memory Guidance** (when memory is configured) instructs the model to store persistent facts but verify that referenced code still exists—preventing hallucinated references to deleted functions.

**Context Management Warning** (when auto-compact is enabled) proactively warns about context space management.

**Output Style** (when configured) offers options like Concise, Explanatory, Learning, Formal, or Casual—significantly affecting response behavior.

**Coordinator Mode** (when enabled) positions the agent as an orchestrator spawning parallel workers.

**Language Preference** (when set) directs all responses in the specified language while preserving technical terms.

### Dynamic Sections (After Cache Boundary)

**Working Directory** provides the current project path for resolving relative paths.

**Git Status Snapshot** includes branch, user, modified files, and recent commits—avoiding a wasted turn on `git status` calls.

**Memory Content** injects the MEMORY.md index and CLAUDE.md hierarchy from the memory manager.

**MCP Server Instructions** provides per-server guidance for connected MCP servers.

### Controlling the Prompt from Code

Replace entirely:
```rust
Agent::builder()
    .system_prompt("You are a data analyst. Only use SQL tools.")
```

Append to defaults:
```rust
Agent::builder()
    .append_system_prompt("Additional rule: never modify files outside src/")
```

Fine-grained control via SystemPromptOptions with output_style, coordinator_mode, language, and other settings.

### Impact on Agent Behavior

Without output efficiency guidance, responses become 3-4x longer. Without tool guidelines, file reads go through bash. Without memory guidance, the model recommends stale or deleted code. Without context management awareness, important data is lost during compaction. The git snapshot alone saves a full turn.

### Token Budget

Always-included components: ~1500 tokens
All conditional components (maximum): ~700 tokens
Git snapshot (typical): ~100 tokens
Memory content: 0–2000 tokens
**Total typical session: ~2200 tokens**

This lean design contrasts with Claude Code's ~8000+ token system prompt, enabling faster first-token time and lower per-session costs.


---

# Architecture

## Architecture (/docs/architecture)

### Overview

Cersei is organized as a modular workspace comprising nine crates plus an Abstract CLI tool. The system prioritizes composability, with all major components implemented as replaceable traits.

### Core Design Principles

The architecture follows five foundational design tenets:

1. **Trait-based extensibility** — "Provider, Tool, Memory, Permission, Hook are all traits. Swap any implementation."

2. **Zero-cost abstractions** — Tool dispatch operates in-process with minimal latency (0.02-0.09ms), avoiding inter-process communication or subprocess overhead.

3. **Streaming-first** — "All async operations emit events. Never blocks waiting for tool results."

4. **POSIX-native I/O** — Direct system calls preferred; file operations leverage standard library utilities while shell operations use the `nix` crate.

5. **Compatible** — Session data (JSONL), memory documentation (MARKDOWN), and skill definitions align with Claude Code formats.

### Component Structure

The nine crates include: cersei (facade), cersei-types, cersei-provider, cersei-tools, cersei-tools-derive, cersei-agent, cersei-memory, cersei-hooks, and cersei-mcp, alongside the abstract-cli command-line interface.

Dependencies flow from cersei-types as a leaf module upward through provider and tools layers, converging in cersei-agent, which coordinates with memory, hooks, and MCP as sibling modules.

### Execution Pipeline

User input triggers the agentic loop through system prompt assembly (incorporating CLAUDE.md hierarchy and MEMORY.md indexing), provider completion requests with streaming event parsing, tool dispatch with permission validation and hook middleware, context management via token counting and auto-compaction, and finally event broadcasting across multiple consumers supporting 26 event variants.

## Crate Map (/docs/crate-map)

### Overview

The Cersei framework comprises multiple interconnected crates that work together to provide an agent-building infrastructure. The facade crate re-exports core components using `cersei::prelude::*` for convenient access.

### Core Architecture

**cersei-types** provides foundational abstractions with zero external dependencies, including message structures, role definitions, content blocks, usage metrics, and error handling.

**cersei-provider** implements the provider abstraction layer, supporting "Anthropic and OpenAI with SSE streaming, token counting, and prompt caching capabilities."

### Tool & Capability System

**cersei-tools** offers "34 built-in tools organized into sets" spanning filesystem operations, shell execution, web interactions, planning, scheduling, and orchestration. A derive macro simplifies tool implementation through the `#[derive(Tool)]` attribute.

**cersei-embeddings** provides a provider-agnostic embedding system with "Gemini and OpenAI backends, a usearch-backed VectorIndex" for semantic search functionality.

### Agent Runtime

**cersei-agent** powers the agentic loop with a "26-variant event system" and includes auto-compaction, memory extraction, and sub-agent capabilities.

**cersei-memory** abstracts storage through multiple backends including JSONL, in-memory, and graph-based options.

### Advanced Features

**cersei-agentlang** introduces the AgentTemplate DSL with permission-gated execution for workflow definitions.

**cersei-agentrl** implements self-evolving orchestration through execution graphs, verification systems, and dynamic tool registries.

**abstract-cli** delivers a production-ready REPL interface with session management and interactive permissions.

## Data Flow (/docs/data-flow)

### The Agentic Loop

The agent operates through a cyclical process where user input triggers system prompt construction incorporating memory and tools. The provider streams completion events that the agent processes—forwarding text deltas to listeners, dispatching tool invocations, and looping on tool-use stops until reaching an end-turn signal. Context auto-compaction occurs when exceeding 90% of the token window, and sessions persist to JSONL format.

### Event Pipeline

Three observation mechanisms exist for monitoring agent behavior:

**Callback (Synchronous):** Provides pattern matching on events like TextDelta and ToolStart through synchronous handlers.

**Broadcast (Multi-Consumer):** Enables multiple subscribers to receive events via a tokio channel, supporting concurrent consumers.

**Stream (Bidirectional Control):** Offers the most control, allowing permission decisions mid-execution, message injection, and cancellation through "a bidirectional channel for runtime control."

### Tool Dispatch

Tool execution follows a defined sequence: lookup by name, permission policy evaluation, pre-execution hooks, execution in-process, post-execution hooks, and result return. The documentation notes that "a Read tool call completes in 0.09ms" due to in-process dispatch without subprocess overhead.

### Context Management & Session Persistence

Before each turn, token counting triggers either normal continuation or auto-compaction when approaching budget limits. Compaction groups messages by topic and summarizes them via LLM calls. Sessions record user messages, assistant responses, summaries, and tombstone entries in JSONL format at `~/.claude/projects/<sanitized-root>/<session-id>.jsonl`.


---

# Examples & Cookbooks

## Examples (/docs/examples)

All examples live in the `examples/` directory and run with:

```bash
cargo run --example <name> --release
```

### Catalog

| Example             | Description                                             |
| ------------------- | ------------------------------------------------------- |
| `simple_agent`      | Minimal agent in 3 lines                                |
| `custom_tools`      | Define and register custom tools with `#[derive(Tool)]` |
| `streaming_events`  | `run_stream()` with colored terminal output             |
| `multi_listener`    | Broadcast channel with multiple consumers               |
| `resumable_session` | Persist and resume conversations with `JsonlMemory`     |
| `custom_provider`   | Echo provider + OpenAI-compatible endpoints             |
| `hooks_middleware`  | Cost guard + audit logger + tool blocker                |
| `benchmark_io`      | Full I/O benchmark suite                                |
| `usage_report`      | Token/cost tracking and billing estimates               |
| `coding_agent`      | End-to-end: build a Python todo CLI                     |
| `oauth_login`       | Anthropic OAuth PKCE login flow                         |

### Stress Tests

```bash
cargo run --example stress_core_infrastructure --release  # system prompt, compact, bash classifier
cargo run --example stress_tools --release                 # all 34 tools, registry, performance
cargo run --example stress_orchestration --release         # sub-agents, coordinator, tasks
cargo run --example stress_skills --release                # bundled + disk skills
cargo run --example stress_memory --release                # memdir, CLAUDE.md, sessions, graph
```

160 unit tests, 262 stress checks, 0 failures.

### simple_agent

```rust
use cersei::prelude::*;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let output = Agent::builder()
        .provider(Anthropic::from_env()?)
        .tools(cersei::tools::coding())
        .permission_policy(AllowAll)
        .run_with("What files are in the current directory?")
        .await?;

    println!("{}", output.text());
    Ok(())
}
```

### custom_tools

```rust
#[derive(Tool)]
#[tool(name = "weather", description = "Get current weather", permission = "none")]
struct WeatherTool;

#[async_trait]
impl ToolExecute for WeatherTool {
    type Input = WeatherInput;
    async fn run(&self, input: WeatherInput, _ctx: &ToolContext) -> ToolResult {
        ToolResult::success(format!("72F and sunny in {}", input.city))
    }
}

#[derive(Deserialize, JsonSchema)]
struct WeatherInput { city: String }
```

### hooks_middleware

```rust
Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::coding())
    .hook(CostGuard { max_usd: 5.0 })
    .hook(AuditLogger)
    .hook(BlockDangerous)
    .permission_policy(AllowAll)
    .run_with("Deploy the app")
    .await?;
```

### resumable_session

```rust
let memory = JsonlMemory::new("./sessions");
let agent = Agent::builder()
    .provider(Anthropic::from_env()?)
    .memory(memory)
    .session_id("my-project-session")
    .build()?;

// First run
agent.run("What's in src/?").await?;

// Later — resumes with full context
agent.run("Now fix the bug you found").await?;
```

## Cookbook: Custom Tools (/docs/cookbook-custom-tools)

### Database Query Tool

The documentation provides an example of implementing a database query tool using the `cersei` framework:

```rust
use cersei::prelude::*;

#[derive(Tool)]
#[tool(name = "db_query", description = "Execute a SQL query", permission = "execute")]
struct DbQueryTool {
    pool: sqlx::PgPool,
}

#[async_trait]
impl ToolExecute for DbQueryTool {
    type Input = DbQueryInput;
    async fn run(&self, input: DbQueryInput, _ctx: &ToolContext) -> ToolResult {
        match sqlx::query(&input.sql).fetch_all(&self.pool).await {
            Ok(rows) => ToolResult::success(format!("{} rows returned", rows.len())),
            Err(e) => ToolResult::error(format!("Query failed: {e}")),
        }
    }
}

#[derive(Deserialize, JsonSchema)]
struct DbQueryInput {
    /// The SQL query to execute
    sql: String,
}
```

### HTTP API Tool

An example showing how to construct a tool for making HTTP requests:

```rust
#[derive(Tool)]
#[tool(name = "api_call", description = "Call an HTTP API endpoint", permission = "execute")]
struct ApiCallTool;

#[async_trait]
impl ToolExecute for ApiCallTool {
    type Input = ApiCallInput;
    async fn run(&self, input: ApiCallInput, _ctx: &ToolContext) -> ToolResult {
        let client = reqwest::Client::new();
        let resp = match input.method.as_str() {
            "POST" => client.post(&input.url).body(input.body.unwrap_or_default()).send().await,
            _ => client.get(&input.url).send().await,
        };

        match resp {
            Ok(r) => {
                let status = r.status().as_u16();
                let body = r.text().await.unwrap_or_default();
                ToolResult::success(format!("HTTP {status}: {body}"))
            }
            Err(e) => ToolResult::error(format!("Request failed: {e}")),
        }
    }
}

#[derive(Deserialize, JsonSchema)]
struct ApiCallInput {
    url: String,
    #[serde(default = "default_get")]
    method: String,
    body: Option<String>,
}

fn default_get() -> String { "GET".into() }
```

### Deploy Tool

A tool demonstrating execution of deployment scripts with elevated permissions:

```rust
#[derive(Tool)]
#[tool(name = "deploy", description = "Deploy to production", permission = "dangerous")]
struct DeployTool;

#[async_trait]
impl ToolExecute for DeployTool {
    type Input = DeployInput;
    async fn run(&self, input: DeployInput, ctx: &ToolContext) -> ToolResult {
        let output = std::process::Command::new("bash")
            .args(["-c", &format!("cd {} && ./deploy.sh {}", ctx.working_dir.display(), input.env)])
            .output();

        match output {
            Ok(o) if o.status.success() => {
                ToolResult::success(String::from_utf8_lossy(&o.stdout).to_string())
            }
            Ok(o) => ToolResult::error(String::from_utf8_lossy(&o.stderr).to_string()),
            Err(e) => ToolResult::error(format!("Deploy failed: {e}")),
        }
    }
}

#[derive(Deserialize, JsonSchema)]
struct DeployInput {
    /// Target environment: staging or production
    env: String,
}
```

### Registering Custom Tools

Tools are integrated into an agent using the builder pattern:

```rust
let agent = Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::coding())  // built-in tools
    .tool(DbQueryTool { pool })      // + custom
    .tool(ApiCallTool)               // + custom
    .tool(DeployTool)                // + custom
    .build()?;
```

### Manual Tool (without derive)

For cases where the derive macro cannot be used, tools can be implemented manually:

```rust
struct ManualTool;

#[async_trait]
impl Tool for ManualTool {
    fn name(&self) -> &str { "manual" }
    fn description(&self) -> &str { "A manually implemented tool" }
    fn input_schema(&self) -> Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "input": { "type": "string", "description": "The input value" }
            },
            "required": ["input"]
        })
    }
    fn permission_level(&self) -> PermissionLevel { PermissionLevel::ReadOnly }

    async fn execute(&self, input: Value, _ctx: &ToolContext) -> ToolResult {
        let text = input["input"].as_str().unwrap_or("");
        ToolResult::success(format!("Processed: {text}"))
    }
}
```

## Cookbook: Agent Deployment (/docs/cookbook-agent-deployment)

### As a CLI Tool

Build a single-binary coding agent:

```rust
use cersei::prelude::*;
use clap::Parser;

#[derive(Parser)]
struct Cli {
    prompt: Option<String>,
    #[arg(long)]
    model: Option<String>,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let model = cli.model.as_deref().unwrap_or("claude-sonnet-4-6");

    let agent = Agent::builder()
        .provider(Anthropic::from_env()?)
        .tools(cersei::tools::all())
        .model(model)
        .permission_policy(AllowAll)
        .auto_compact(true)
        .build()?;

    if let Some(prompt) = cli.prompt {
        let output = agent.run(&prompt).await?;
        println!("{}", output.text());
    } else {
        // REPL loop
        loop {
            let mut input = String::new();
            std::io::stdin().read_line(&mut input)?;
            if input.trim().is_empty() { break; }
            let output = agent.run(input.trim()).await?;
            println!("{}", output.text());
        }
    }
    Ok(())
}
```

### As an HTTP API

```rust
use axum::{routing::post, Json, Router};
use cersei::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct AgentRequest { prompt: String }

#[derive(Serialize)]
struct AgentResponse { response: String, tokens: u64, turns: u32 }

async fn handle(Json(req): Json<AgentRequest>) -> Json<AgentResponse> {
    let output = Agent::builder()
        .provider(Anthropic::from_env().unwrap())
        .tools(cersei::tools::coding())
        .permission_policy(AllowReadOnly)
        .max_turns(5)
        .run_with(&req.prompt)
        .await
        .unwrap();

    Json(AgentResponse {
        response: output.text().to_string(),
        tokens: output.usage.output_tokens,
        turns: output.turns,
    })
}

#[tokio::main]
async fn main() {
    let app = Router::new().route("/agent", post(handle));
    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
```

### With Session Persistence

```rust
let memory = JsonlMemory::new("./sessions");

let agent = Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::coding())
    .memory(memory)
    .session_id(&session_id)
    .auto_compact(true)
    .build()?;

// Conversations resume automatically across restarts
```

### With Graph Memory

```rust
use cersei::memory::manager::MemoryManager;

let mm = MemoryManager::new(project_root)
    .with_graph(Path::new("./agent.grafeo"))?;

// Store facts the agent learns
mm.store_memory("User prefers functional patterns", MemoryType::User, 0.9);
mm.tag_memory(&id, "coding-style");

// Recall during conversations
let relevant = mm.recall("coding style preferences", 5);
```

### Background Worker (Cron)

```rust
// Run agent on a schedule
loop {
    let output = Agent::builder()
        .provider(Anthropic::from_env()?)
        .tools(cersei::tools::coding())
        .working_dir("./my-project")
        .max_turns(10)
        .permission_policy(AllowAll)
        .run_with("Check for new issues and fix any simple bugs")
        .await?;

    println!("Agent completed: {} turns, {} tool calls", output.turns, output.tool_calls.len());
    tokio::time::sleep(Duration::from_secs(3600)).await;
}
```

### Multi-Agent Coordination

```rust
// Agent with sub-agent capabilities
let agent = Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::all())  // includes AgentTool, Tasks, SendMessage
    .system_prompt("You are a coordinator. Delegate tasks to sub-agents.")
    .build()?;

// The model can now spawn sub-agents, create tasks, and send messages
// between agents using the built-in orchestration tools
```

## Cookbook: Embedding in Apps (/docs/cookbook-embedding)

### Cookbook: Embedding Agents

#### In a Tauri Desktop App

```rust
use cersei::prelude::*;
use tauri::Manager;

#[tauri::command]
async fn ask_agent(prompt: String) -> Result<String, String> {
    let output = Agent::builder()
        .provider(Anthropic::from_env().map_err(|e| e.to_string())?)
        .tools(cersei::tools::filesystem())
        .permission_policy(AllowReadOnly)
        .max_turns(3)
        .run_with(&prompt)
        .await
        .map_err(|e| e.to_string())?;

    Ok(output.text().to_string())
}
```

#### In an Actix-web Server

```rust
use actix_web::{web, App, HttpResponse, HttpServer};
use cersei::prelude::*;
use std::sync::Arc;

struct AppState {
    provider: Arc<dyn Provider>,
}

async fn agent_endpoint(
    body: web::Json<serde_json::Value>,
    state: web::Data<AppState>,
) -> HttpResponse {
    let prompt = body["prompt"].as_str().unwrap_or("");
    let output = Agent::builder()
        .provider(Arc::clone(&state.provider))
        .tools(cersei::tools::coding())
        .permission_policy(AllowReadOnly)
        .run_with(prompt)
        .await;

    match output {
        Ok(o) => HttpResponse::Ok().json(serde_json::json!({ "response": o.text() })),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({ "error": e.to_string() })),
    }
}
```

#### Streaming to WebSocket

```rust
let agent = Agent::builder()
    .provider(Anthropic::from_env()?)
    .tools(cersei::tools::coding())
    .enable_broadcast(256)
    .build()?;

let mut rx = agent.subscribe().unwrap();

// Forward events to WebSocket
tokio::spawn(async move {
    while let Ok(event) = rx.recv().await {
        match event {
            AgentEvent::TextDelta(t) => ws_send(&t).await,
            AgentEvent::ToolStart { name, .. } => ws_send(&format!("[{name}]")).await,
            AgentEvent::Complete(_) => break,
            _ => {}
        }
    }
});

agent.run("Fix the tests").await?;
```

#### With Custom Memory Backend

```rust
struct PostgresMemory { pool: PgPool }

#[async_trait]
impl Memory for PostgresMemory {
    async fn store(&self, session_id: &str, messages: &[Message]) -> Result<()> {
        let json = serde_json::to_string(messages)?;
        sqlx::query("INSERT INTO sessions (id, messages) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET messages = $2")
            .bind(session_id)
            .bind(&json)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    async fn load(&self, session_id: &str) -> Result<Vec<Message>> {
        let row = sqlx::query_scalar::<_, String>("SELECT messages FROM sessions WHERE id = $1")
            .bind(session_id)
            .fetch_optional(&self.pool)
            .await?;
        match row {
            Some(json) => Ok(serde_json::from_str(&json)?),
            None => Ok(vec![]),
        }
    }

    // ... implement search, sessions, delete
}
```

### Extension Points

| What               | How                              |
| ------------------ | -------------------------------- |
| Custom provider    | `impl Provider`                  |
| Custom tool        | `#[derive(Tool)]` or `impl Tool` |
| Custom permissions | `impl PermissionPolicy`          |
| Custom memory      | `impl Memory`                    |
| Custom hooks       | `impl Hook`                      |
| Custom reporters   | `impl Reporter`                  |
| MCP servers        | `McpServerConfig`                |
| Skills             | `.claude/commands/*.md`          |
| Graph memory       | `features = ["graph"]`           |

## Cookbook: ML Coding Agent (/docs/cookbook-ml-agent)

Build an agent that understands ML codebases, runs training scripts, evaluates models, and iterates on architectures — all from natural language instructions.

### Why Cersei for ML?

Unlike generic agent SDKs, Cersei gives you:

* **Full control over tool execution** — run `python train.py` with custom timeout, capture GPU metrics
* **Graph memory** — track experiment results across sessions (loss curves, hyperparams, what worked)
* **Tree-sitter code intelligence** — parse Python ML code to understand model architectures before modifying
* **Provider agnostic** — use GPT-5.3 for cheap iteration, Claude Opus for complex architecture decisions

### The Agent

```rust
use cersei::prelude::*;
use cersei_tools::tool_primitives::{code_intel, process};
use std::path::Path;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let provider = cersei_provider::from_model_string("auto")?.0;

    // Custom tools for ML workflows
    let mut tools = cersei_tools::coding(); // Read, Write, Edit, Glob, Grep, Bash
    tools.push(Box::new(TrainTool));
    tools.push(Box::new(EvalTool));
    tools.push(Box::new(GpuStatusTool));

    let agent = Agent::builder()
        .provider(provider)
        .tools(tools)
        .system_prompt(ML_SYSTEM_PROMPT)
        .max_turns(30) // ML tasks need many iterations
        .max_tokens(16384)
        .working_dir(".")
        .build()?;

    let agent = std::sync::Arc::new(agent);
    let mut stream = agent.run_stream(
        "Analyze the model architecture in model.py, then train for 5 epochs \
         and report the loss curve. If val_loss plateaus, suggest architecture changes."
    );

    while let Some(event) = stream.next().await {
        match event {
            AgentEvent::TextDelta(t) => print!("{t}"),
            AgentEvent::ToolStart { name, .. } => eprintln!("\n  > {name}"),
            AgentEvent::ToolEnd { name, duration, .. } => {
                eprintln!("  < {name} ({:.1}s)", duration.as_secs_f64());
            }
            AgentEvent::Complete(_) => break,
            _ => {}
        }
    }

    Ok(())
}

const ML_SYSTEM_PROMPT: &str = "You are an ML engineering agent. You can:
- Read and understand model architectures (PyTorch, TensorFlow, MLX)
- Run training scripts and capture metrics
- Analyze loss curves and suggest improvements
- Modify hyperparameters and model code
- Track experiments across sessions via memory

Always check GPU status before training. Report metrics in tables.";
```

### Custom Tools

#### Train Tool

```rust
struct TrainTool;

#[async_trait]
impl Tool for TrainTool {
    fn name(&self) -> &str { "Train" }
    fn description(&self) -> &str {
        "Run a training script with GPU monitoring. Returns stdout, stderr, and training metrics."
    }
    fn permission_level(&self) -> PermissionLevel { PermissionLevel::Execute }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "script": { "type": "string", "description": "Python script to run" },
                "args": { "type": "string", "description": "CLI arguments", "default": "" },
                "timeout_secs": { "type": "integer", "default": 600 }
            },
            "required": ["script"]
        })
    }

    async fn execute(&self, input: serde_json::Value, ctx: &ToolContext) -> ToolResult {
        let script = input["script"].as_str().unwrap_or("train.py");
        let args = input["args"].as_str().unwrap_or("");
        let timeout = input["timeout_secs"].as_u64().unwrap_or(600);

        let cmd = format!("python {} {}", script, args);
        let opts = process::ExecOptions {
            cwd: Some(ctx.working_dir.clone()),
            timeout: Some(std::time::Duration::from_secs(timeout)),
            ..Default::default()
        };

        match process::exec(&cmd, opts).await {
            Ok(output) => {
                let mut result = String::new();
                if !output.stdout.is_empty() {
                    result.push_str(&output.stdout);
                }
                if !output.stderr.is_empty() {
                    result.push_str("\n--- stderr ---\n");
                    result.push_str(&output.stderr);
                }
                if output.timed_out {
                    ToolResult::error(format!("Training timed out after {timeout}s\n{result}"))
                } else if output.exit_code != 0 {
                    ToolResult::error(format!("Training failed (exit {})\n{result}", output.exit_code))
                } else {
                    ToolResult::success(result)
                }
            }
            Err(e) => ToolResult::error(format!("Failed to start training: {e}")),
        }
    }
}
```

#### GPU Status Tool

```rust
struct GpuStatusTool;

#[async_trait]
impl Tool for GpuStatusTool {
    fn name(&self) -> &str { "GpuStatus" }
    fn description(&self) -> &str { "Check GPU availability and memory usage." }
    fn permission_level(&self) -> PermissionLevel { PermissionLevel::ReadOnly }

    fn input_schema(&self) -> serde_json::Value {
        serde_json::json!({ "type": "object", "properties": {} })
    }

    async fn execute(&self, _input: serde_json::Value, _ctx: &ToolContext) -> ToolResult {
        // Try nvidia-smi first, fall back to Apple MPS check
        let nvidia = process::exec(
            "nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader",
            Default::default(),
        ).await;

        if let Ok(output) = nvidia {
            if output.exit_code == 0 {
                return ToolResult::success(format!("NVIDIA GPU:\n{}", output.stdout));
            }
        }

        // Check for Apple Silicon MPS
        let mps = process::exec(
            "python -c \"import torch; print(f'MPS available: {torch.backends.mps.is_available()}')\"",
            Default::default(),
        ).await;

        match mps {
            Ok(output) if output.exit_code == 0 => {
                ToolResult::success(format!("Apple Silicon:\n{}", output.stdout))
            }
            _ => ToolResult::success("No GPU detected. Training will use CPU."),
        }
    }
}
```

### Using Tree-Sitter for Model Analysis

Before modifying ML code, use tree-sitter to understand the architecture:

```rust
use cersei_tools::tool_primitives::code_intel;
use std::path::Path;

// Scan the ML project
let intels = code_intel::scan_project(Path::new("./"), 20);

// Find model definition files
for intel in &intels {
    let has_model = intel.symbols.iter().any(|s| {
        s.name.contains("Model") || s.name.contains("Network") || s.name.contains("Net")
    });
    if has_model {
        println!("Model file: {} — symbols:", intel.path.display());
        for sym in &intel.symbols {
            println!("  {} {} (line {})", sym.kind.label(), sym.name, sym.line);
        }
    }
}
```

### Experiment Tracking with Graph Memory

Store experiment results in Cersei's graph memory for cross-session recall:

```rust
use cersei_memory::graph::GraphMemory;

let graph = GraphMemory::open(Path::new("~/.abstract/graph.db"))?;

// After each training run, store results
graph.store_memory(
    "experiment: lr=1e-4, epochs=10, val_loss=0.23, val_acc=0.91",
    cersei_memory::memdir::MemoryType::Project,
    0.95, // high confidence
)?;

// Tag with topic
let mem_id = graph.store_memory(/* ... */)?;
graph.tag_memory(&mem_id, "experiment-results")?;

// Later: recall what worked
let results = graph.by_topic("experiment-results");
// Returns: all experiment results sorted by confidence
```

### Full Example Flow

```
User: "Train the model on the new dataset and compare with last run"

Agent:
1. [GpuStatus] → MPS available: True
2. [Read] model.py → Understands architecture (ResNet variant, 8M params)
3. [Grep] "val_loss" in training logs → Finds last run: val_loss=0.31
4. [Train] python train.py --data new_dataset --epochs 10
   → Training output: epoch 10/10, val_loss=0.24, val_acc=0.89
5. [Memory] Stores: "new_dataset run: val_loss=0.24 (improved from 0.31)"
6. Synthesizes comparison table with improvement analysis
```

## Cookbook: Research Agent (/docs/cookbook-research-agent)

Build an agent that autonomously researches topics by searching the web, reading papers, analyzing codebases, and synthesizing findings — with persistent memory across sessions.

### Architecture

```
User Query → Research Agent
  ├── WebSearch (Brave API) → top results
  ├── WebFetch → read full pages
  ├── Grep/Glob → search local codebases
  ├── LSP → understand code semantics
  └── Graph Memory → store + recall findings
```

### The Agent

```rust
use cersei::prelude::*;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let provider = cersei_provider::from_model_string("auto")?.0;

    // Research agent: web + filesystem + memory tools
    let mut tools: Vec<Box<dyn Tool>> = Vec::new();
    tools.extend(cersei_tools::filesystem()); // Read, Glob, Grep
    tools.extend(cersei_tools::web());        // WebFetch, WebSearch
    tools.push(Box::new(cersei_tools::lsp_tool::LspTool::new(
        std::path::Path::new("."),
    )));

    // Memory manager for persistent findings
    let memory = cersei_memory::manager::MemoryManager::new(".");

    let agent = Agent::builder()
        .provider(provider)
        .tools(tools)
        .system_prompt(RESEARCH_PROMPT)
        .max_turns(40) // Research needs many rounds
        .auto_compact(true)
        .session_id("research-session-1")
        .memory(memory)
        .build()?;

    let output = agent.run(
        "Research the current state of Rust async runtimes. \
         Compare tokio, async-std, smol, and glommio. \
         Focus on performance benchmarks, API ergonomics, and ecosystem maturity. \
         Write a comprehensive report to research-output.md"
    ).await?;

    println!("Research complete in {} turns, {} tool calls",
        output.turns, output.tool_calls.len());

    Ok(())
}

const RESEARCH_PROMPT: &str = "You are a research agent. Your job is to:
1. Break research questions into sub-topics
2. Search the web for each sub-topic using WebSearch
3. Read promising URLs with WebFetch
4. Cross-reference findings with local codebases using Grep/Glob
5. Use LSP for semantic code understanding when analyzing libraries
6. Synthesize findings into structured reports with citations
7. Store key findings in memory for future reference

Always cite your sources with URLs. Use tables for comparisons.
Search for multiple perspectives before drawing conclusions.";
```

### Multi-Source Research Pattern

The key to quality research is combining multiple sources:

```rust
// Step 1: Web search for overview
let search_results = agent.run(
    "WebSearch for 'Rust async runtime benchmarks 2025'"
).await?;

// Step 2: Fetch top results
let fetched = agent.run(
    "WebFetch the top 3 URLs from the search results"
).await?;

// Step 3: Cross-reference with actual code
let code_analysis = agent.run(
    "Grep the tokio source code for benchmark results and performance notes"
).await?;

// Step 4: Synthesize
let report = agent.run(
    "Synthesize all findings into a comparison table"
).await?;
```

### Persistent Research with Graph Memory

Store research findings across sessions:

```rust
use cersei_memory::graph::GraphMemory;
use cersei_memory::memdir::MemoryType;

let graph = GraphMemory::open(std::path::Path::new("~/.abstract/graph.db"))?;

// Store a finding
let id = graph.store_memory(
    "tokio 1.x: 2.3M req/s on HTTP benchmarks (source: tokio blog 2025)",
    MemoryType::Reference,
    0.9,
)?;
graph.tag_memory(&id, "rust-async")?;
graph.tag_memory(&id, "benchmarks")?;

// Link related findings
let id2 = graph.store_memory(
    "async-std deprecated in favor of smol ecosystem (source: GitHub announcement)",
    MemoryType::Reference,
    0.85,
)?;
graph.link_memories(&id, &id2, "COMPARES_TO")?;

// Later: recall all findings about async runtimes
let findings = graph.by_topic("rust-async");
for finding in findings {
    println!("{finding}");
}
```

### Sub-Agent Pattern for Parallel Research

Use sub-agents to research multiple topics concurrently:

```rust
let agent = Agent::builder()
    .provider(provider)
    .tools(tools)
    .system_prompt(
        "You are a research coordinator. Use the Agent tool to spawn \
         parallel research sub-agents for each sub-topic. Each sub-agent \
         should search, read, and summarize independently. Synthesize \
         all sub-agent results into a final report."
    )
    .build()?;

// The agent will spawn sub-agents like:
// Agent("Research tokio performance benchmarks")
// Agent("Research async-std current status")
// Agent("Research smol ecosystem maturity")
// Then synthesize all results
```

### Output Format

The agent produces structured markdown reports:

```markdown
# Rust Async Runtimes: Comparative Analysis

## Executive Summary
...

## Detailed Comparison

| Runtime | Throughput | API Ergonomics | Ecosystem | Status |
|---------|-----------|----------------|-----------|--------|
| tokio | 2.3M req/s | Good | Extensive | Active |
| smol | 1.8M req/s | Excellent | Growing | Active |
| glommio | 3.1M req/s | Complex | Niche | Active |
| async-std | N/A | Good | Declining | Deprecated |

## Sources
1. [tokio blog](https://tokio.rs/blog/...) — performance benchmarks
2. [GitHub announcement](https://github.com/...) — async-std deprecation
...
```

## Cookbook: General Agent (/docs/cookbook-general-agent)

Build a production-ready agent that automatically handles memory persistence, skill discovery, MCP server connections, and multi-turn conversations — the full Cersei stack in one setup.

### The Complete Setup

```rust
use cersei::prelude::*;
use cersei_memory::manager::MemoryManager;
use cersei_mcp::McpServerConfig;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let working_dir = std::env::current_dir()?;

    // 1. Provider: auto-detect from environment
    let (provider, model) = cersei_provider::from_model_string("auto")?;
    println!("Using: {model}");

    // 2. Memory: graph + flat files + CLAUDE.md hierarchy
    let mut memory = MemoryManager::new(&working_dir);

    #[cfg(feature = "graph")]
    {
        let graph_path = dirs::home_dir()
            .unwrap_or_default()
            .join(".abstract/graph.db");
        if let Some(parent) = graph_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        memory = memory.with_graph(&graph_path)?;
    }

    // 3. Tools: all built-ins + LSP
    let mut tools = cersei_tools::all(); // 35 tools
    tools.push(Box::new(cersei_tools::lsp_tool::LspTool::new(&working_dir)));

    // 4. MCP servers (if configured)
    let mcp_configs = vec![
        McpServerConfig::stdio("filesystem", "npx", &["-y", "@anthropic/mcp-server-filesystem", "."]),
        McpServerConfig::stdio("github", "npx", &["-y", "@anthropic/mcp-server-github"]),
    ];

    // 5. Skills: auto-discovered from .claude/commands/ and .claude/skills/
    // (automatically loaded by the skill tool in cersei_tools::all())

    // 6. Build the agent
    let mut builder = Agent::builder()
        .provider(provider)
        .tools(tools)
        .model(&model)
        .max_turns(50)
        .max_tokens(16384)
        .auto_compact(true)
        .enable_broadcast(512)
        .working_dir(&working_dir)
        .session_id("general-session")
        .memory(memory);

    // Add MCP servers
    for config in mcp_configs {
        builder = builder.mcp_server(config);
    }

    let agent = builder.build()?;
    let agent = std::sync::Arc::new(agent);

    // 7. Run with streaming
    let mut stream = agent.run_stream("What files have changed since last session?");

    while let Some(event) = stream.next().await {
        match event {
            AgentEvent::TextDelta(t) => print!("{t}"),
            AgentEvent::ToolStart { name, .. } => eprintln!("\n  [{name}]"),
            AgentEvent::Complete(_) => break,
            AgentEvent::Error(e) => {
                eprintln!("\nError: {e}");
                break;
            }
            _ => {}
        }
    }

    Ok(())
}
```

### What You Get Automatically

#### Memory

The `MemoryManager` composes three layers:

```
Graph DB (Grafeo)     ← 98us recall, relationship tracking
├── Memory nodes      ← User preferences, project decisions
├── Topic nodes       ← Tags for categorization
└── Session nodes     ← History tracking

Flat Files (memdir)   ← ~/.abstract/memory/*.md
├── user_role.md      ← "Senior Rust developer"
├── feedback_*.md     ← Corrections and preferences
└── project_*.md      ← Project-specific context

CLAUDE.md Hierarchy   ← Walk up from working dir
├── ./AGENTS.md       ← Project instructions
├── ../AGENTS.md      ← Parent directory instructions
└── ~/.abstract/AGENTS.md ← Global instructions
```

All three layers are composed into a single context string injected into every system prompt.

#### Skills

Skills are auto-discovered from the filesystem:

```
.claude/commands/deploy.md     → /deploy skill
.claude/commands/review.md     → /review skill
.claude/skills/test/SKILL.md   → /test skill (with YAML frontmatter)
```

The agent can invoke them via the Skill tool:

```
Agent: [Skill] skill="deploy", args="production"
→ Expands deploy.md template with args, executes as a prompt
```

#### MCP Servers

External tool servers connected via JSON-RPC:

```rust
// Filesystem MCP server — gives agent sandboxed file access
McpServerConfig::stdio("fs", "npx", &["-y", "@anthropic/mcp-server-filesystem", "."]);

// GitHub MCP server — issues, PRs, repos
McpServerConfig::stdio("github", "npx", &["-y", "@anthropic/mcp-server-github"]);

// Custom MCP server
McpServerConfig::stdio("my-server", "./my-mcp-server", &["--port", "8080"]);
```

MCP tools appear alongside built-in tools — the agent doesn't know the difference.

### Multi-Turn Conversation

```rust
// First message
let output1 = agent.run("Read the README and summarize the project").await?;

// Follow-up (same conversation, memory persists)
let output2 = agent.run("Now look at the test coverage").await?;

// Session is auto-saved to JSONL
// Resume later:
let agent = Agent::builder()
    .session_id("general-session") // Same ID
    .memory(memory)
    // ... other config
    .build()?;
// History is loaded automatically from session storage
```

### Hooks for Lifecycle Control

```rust
use cersei_hooks::{Hook, HookEvent, HookContext, HookAction};

struct LoggingHook;

#[async_trait]
impl Hook for LoggingHook {
    fn event(&self) -> HookEvent { HookEvent::PostToolUse }

    async fn run(&self, ctx: &HookContext) -> HookAction {
        if let Some(tool) = &ctx.tool_name {
            println!("[hook] Tool used: {tool}");
        }
        HookAction::Continue
    }
}

// Add to agent
let agent = Agent::builder()
    .hook(LoggingHook)
    // ...
    .build()?;
```

### Event-Driven Architecture

Subscribe to all agent events for custom UIs:

```rust
let agent = Agent::builder()
    .enable_broadcast(512) // Enable broadcast channel
    .build()?;

// Subscribe from multiple listeners
let mut rx = agent.subscribe();

tokio::spawn(async move {
    while let Ok(event) = rx.recv().await {
        match event {
            AgentEvent::CostUpdate { cumulative_cost, .. } => {
                update_cost_display(cumulative_cost);
            }
            AgentEvent::TokenWarning { pct_used, .. } => {
                show_context_warning(pct_used);
            }
            _ => {}
        }
    }
});
```

## Cookbook: Graph Memory (/docs/cookbook-graph-memory)

Cersei's graph memory (powered by Grafeo) gives you structured, queryable memory that survives across sessions. Unlike flat-file memory, you can traverse relationships, tag by topic, decay old memories, and recall in 98 microseconds.

### Setup

```rust
use cersei_memory::graph::GraphMemory;
use cersei_memory::memdir::MemoryType;
use std::path::Path;

// Open or create the graph database
let graph = GraphMemory::open(Path::new("./memory.db"))?;

// Or use in-memory for testing
let graph = GraphMemory::open_in_memory()?;
```

### Storing Memories

```rust
// Store a user preference
let id = graph.store_memory(
    "User prefers concise responses without emojis",
    MemoryType::User,
    0.95, // confidence
)?;

// Store a project decision
let id2 = graph.store_memory(
    "Authentication uses JWT with RS256, stored in HttpOnly cookies",
    MemoryType::Project,
    0.9,
)?;

// Store feedback
let id3 = graph.store_memory(
    "Don't add docstrings to code the user didn't change",
    MemoryType::Feedback,
    1.0,
)?;
```

### Tagging and Relationships

```rust
// Tag memories by topic
graph.tag_memory(&id2, "authentication")?;
graph.tag_memory(&id2, "security")?;

// Link related memories
graph.link_memories(&id2, &id3, "RELATES_TO")?;

// Create a topic hierarchy
let id4 = graph.store_memory(
    "API rate limiting: 100 req/min per user, 1000 req/min per org",
    MemoryType::Project,
    0.85,
)?;
graph.tag_memory(&id4, "security")?;
graph.link_memories(&id2, &id4, "RELATES_TO")?;
```

### Querying

```rust
// Full-text recall (fuzzy matching)
let results = graph.recall("authentication", 5);
// Returns top 5 memories matching "authentication"

// By type
let user_prefs = graph.by_type(MemoryType::User);
let project_docs = graph.by_type(MemoryType::Project);
let feedback = graph.by_type(MemoryType::Feedback);

// By topic
let security_memories = graph.by_topic("security");
// Returns all memories tagged with "security"
```

### Confidence Decay

Memories automatically lose confidence over time unless revalidated:

```rust
// Memory stored with confidence 0.95
let id = graph.store_memory("API uses v2 endpoints", MemoryType::Project, 0.95)?;

// After 30 days, effective_confidence decays based on decay_rate
// Default decay_rate = 0.01 per day

// Revalidate to reset the clock
graph.revalidate_memory(&id)?;
// Now effective_confidence resets to the stored value
```

This prevents stale memories from dominating context. Old, unverified information naturally fades.

### Session Recording

```rust
// Track sessions in the graph
graph.record_session(
    "session-abc123",
    Some("gpt-5.3-chat-latest"),
    15, // turns
)?;
```

### Graph Statistics

```rust
let stats = graph.stats();
println!("Memories: {}", stats.memory_count);
println!("Sessions: {}", stats.session_count);
println!("Topics: {}", stats.topic_count);
println!("Relationships: {}", stats.relationship_count);
```

### Schema Versioning

The graph auto-migrates on open:

```rust
use cersei_memory::graph_migrate::VersionCheck;

let version = graph.schema_version();
match version {
    VersionCheck::Current(v) => println!("Schema v{v} — up to date"),
    VersionCheck::NeedsMigration { from, to } => println!("Migrating v{from} → v{to}"),
    VersionCheck::Unknown => println!("New database"),
}
```

Migrations are sequential and idempotent. v0→v1 adds session tracking. v1→v2 adds confidence decay fields.

### Integration with MemoryManager

In production, use `MemoryManager` to compose graph + flat files + CLAUDE.md:

```rust
use cersei_memory::manager::MemoryManager;

let mut mm = MemoryManager::new("./project");
mm = mm.with_graph(Path::new("./memory.db"))?;

// Build context for system prompt (composes all layers)
let context = mm.build_context();
// Returns: combined string from graph recall + memdir files + CLAUDE.md hierarchy

// Use in agent
let agent = Agent::builder()
    .memory(mm)
    // ...
    .build()?;
```

### Graph Node Types

| Node      | Properties                                                               | Description                          |
| --------- | ------------------------------------------------------------------------ | ------------------------------------ |
| `Memory`  | content, type, confidence, created_at, last_validated_at, decay_rate     | A stored memory entry                |
| `Session` | session_id, created_at, model, turns                                     | A recorded agent session             |
| `Topic`   | name                                                                     | A tag/category for grouping memories |

### Edge Types

| Edge         | From → To       | Description                            |
| ------------ | --------------- | -------------------------------------- |
| `RELATES_TO` | Memory → Memory | Semantic relationship between memories |
| `TAGGED`     | Memory → Topic  | Memory belongs to a topic/category     |

### Performance

| Operation            | Time    | Notes              |
| -------------------- | ------- | ------------------ |
| Store memory         | ~120us  | Write + index      |
| Recall (text search) | ~98us   | Indexed lookup     |
| By topic             | ~50us   | Edge traversal     |
| By type              | ~60us   | Indexed filter     |
| Stats                | ~30us   | Aggregate counts   |
| Context build        | ~45us   | Compose all layers |


---

# Comparisons, Abstract & Benchmarks

## Cersei vs Other Agent SDKs (/docs/comparisons)

# Cersei vs Other Agent SDKs

Looking for the **general-purpose agent framework comparison (Agno, LangGraph, CrewAI, PydanticAI)**? The five-axis showdown — instantiation, per-agent memory, max concurrent agents, graph memory recall under load, semantic search under load — is at [Cersei vs Agno / LangGraph / CrewAI / PydanticAI](/docs/bench-vs-agents). This page covers the coding-agent-focused comparison against Claude Code and Codex.

## Cersei vs Claude Code SDK

Claude Code's Agent SDK (part of the `@anthropic-ai/claude-code` package) provides a way to embed Claude Code's agent capabilities in your application. Here's how it compares to Cersei:

| Dimension               | Cersei SDK                                            | Claude Code SDK                        |
| ----------------------- | ----------------------------------------------------- | -------------------------------------- |
| **Language**            | Rust (native binary)                                  | TypeScript/Node.js                     |
| **Provider Lock-in**    | 15+ providers (Anthropic, OpenAI, Google, Groq, etc.) | Anthropic only                         |
| **Tool System**         | 35 built-in + custom `Tool` trait + MCP               | Inherited from Claude Code             |
| **Memory**              | Graph DB (Grafeo) + flat files + CLAUDE.md            | Flat file CLAUDE.md only               |
| **Control**             | Full: custom system prompt, tools, hooks, everything  | Limited: prompt injection, some config |
| **Streaming**           | 26-variant event system with broadcast channels       | Callback-based events                  |
| **Binary Size**         | Single static binary (~15MB)                         | Requires Node.js runtime (~100MB+)    |
| **Startup Time**        | ~50ms                                                | ~2s (Node.js cold start)              |
| **Tool Dispatch**       | 0.02ms (Edit) to 17ms (Bash)                          | Depends on Node.js event loop          |
| **Memory Recall**       | 98us (graph indexed)                                  | File scan (varies)                     |
| **LSP Integration**     | Built-in cersei-lsp crate (13 servers)                | Via MCP servers                        |
| **Tree-sitter**         | Built-in (5 languages + bash safety)                  | Not available                          |
| **Sub-agents**          | AgentTool with independent loops                      | Task tool                              |
| **Auto-compact**        | LLM summarization + snip fallback                     | Automatic                              |
| **Session Persistence** | JSONL with auto-fork at 50MB                          | Managed internally                     |
| **Hooks**               | Pre/Post ToolUse, ModelTurn, Stop, Error              | Limited lifecycle hooks                |
| **Permission System**   | 6 levels + 5 TUI modes                                | Interactive/auto                       |
| **Cost Tracking**       | Per-message with model pricing                        | Basic token counting                   |
| **TUI**                 | ratatui with side panel, themes, graph viz            | Built-in (not customizable)            |

### When to Choose Cersei

* You need **provider flexibility** (switch between GPT-5, Claude, Gemini, local models)
* You want **full control** over every aspect: system prompt, tools, memory, permissions
* You're building a **Rust application** and want native performance
* You need **graph-based memory** with relationship tracking and confidence decay
* You want **tree-sitter code intelligence** built into your agent
* You're building a **custom CLI tool** or **embedding an agent** in a desktop app

### When to Choose Claude Code SDK

* You're already using **Claude Code** and want to extend it
* You want the **quickest path** to a working agent with minimal configuration
* Your application is **TypeScript/Node.js** based
* You only need **Anthropic models**
* You want Claude Code's existing **UX and polish** out of the box

### Code Comparison

**Cersei — Full control:**

```rust
let agent = Agent::builder()
    .provider(cersei_provider::from_model_string("openai/gpt-5.3-chat-latest")?.0)
    .tools(cersei_tools::all())
    .system_prompt("You are a Rust expert. Focus on performance.")
    .max_turns(30)
    .thinking_budget(8000)
    .temperature(0.3)
    .auto_compact(true)
    .hook(MyCustomHook)
    .mcp_server(McpServerConfig::stdio("db", "my-db-server", &[]))
    .memory(MemoryManager::new(".").with_graph(&graph_path)?)
    .permission_policy(MyCustomPolicy)
    .working_dir(".")
    .build()?;
```

**Claude Code SDK — Quick start:**

```typescript
import { createAgent } from "@anthropic-ai/claude-code";

const agent = createAgent({
  prompt: "You are a Rust expert",
  allowedTools: ["read", "write", "bash"],
});
```

Cersei requires more setup but gives you control over every aspect. Claude Code SDK is simpler but constrains you to its architecture.

## Cersei vs Pydantic AI / LangChain

| Dimension               | Cersei                                | Pydantic AI            | LangChain                |
| ----------------------- | ------------------------------------- | ---------------------- | ------------------------ |
| **Language**            | Rust                                  | Python                 | Python/JS                |
| **Focus**               | Coding agents                         | Structured AI apps     | General AI chains        |
| **Tool System**         | Trait-based, async, permission levels | Function decorators    | Tool classes             |
| **Memory**              | Graph DB + flat files                 | External (Redis, etc.) | VectorStore abstractions |
| **Performance**         | Native binary, sub-ms dispatch        | Python overhead        | Python overhead          |
| **Type Safety**         | Compile-time (Rust)                   | Runtime (Pydantic)     | Runtime                  |
| **Agent Loop**          | Built-in agentic loop with events     | Manual or via agents   | AgentExecutor            |
| **Streaming**           | Native SSE parsing, 26 event types    | Via callbacks          | Via callbacks            |
| **Code Intelligence**   | LSP + tree-sitter built-in            | Not available          | Not available            |
| **Binary Distribution** | Single static binary                  | Requires Python + deps | Requires Python + deps   |

### When to Choose Cersei

* Performance matters (sub-millisecond tool dispatch)
* You want a single binary with no runtime dependencies
* You need built-in code intelligence (LSP, tree-sitter)
* You're building a CLI tool or desktop application
* Type safety and compile-time guarantees are important

### When to Choose Python SDKs

* Your team is Python-first
* You need access to Python ML libraries (numpy, pandas, transformers)
* You're prototyping and want maximum iteration speed
* You need the Python ecosystem (thousands of LangChain integrations)

## Feature Matrix

| Feature             | Cersei            | Claude Code SDK | Pydantic AI | LangChain     |
| ------------------- | ----------------- | --------------- | ----------- | ------------- |
| Multi-provider      | 15+               | 1 (Anthropic)   | Multiple    | Multiple      |
| Native binary       | Yes               | No              | No          | No            |
| Graph memory        | Yes               | No              | No          | No            |
| Tree-sitter         | Yes               | No              | No          | No            |
| LSP integration     | Yes               | Via MCP         | No          | No            |
| Sub-agents          | Yes               | Yes             | No          | Yes           |
| Auto-compact        | Yes               | Yes             | No          | No            |
| Hooks/middleware    | Yes               | Limited         | Yes         | Yes           |
| MCP support         | Yes               | Yes             | No          | No            |
| Permission system   | 6 levels          | 2 levels        | No          | No            |
| Session persistence | JSONL + auto-fork | Internal        | External    | External      |
| TUI framework       | ratatui           | Built-in        | No          | No            |
| Cost tracking       | Per-model pricing | Basic           | No          | Via callbacks |
| Bash safety         | tree-sitter AST   | No              | No          | No            |
| File undo/snapshots | Yes               | Yes             | No          | No            |

## Cersei vs General Agent Frameworks (Agno, PydanticAI, LangGraph, CrewAI)

Every number here is measured end-to-end on Apple M1 Pro via [`bench/general-agents/`](https://github.com/pacifio/cersei/tree/main/bench/general-agents). See [bench-vs-agents](/docs/bench-vs-agents) for methodology, caveats, and reproduction steps.

### Instantiation — μs per Agent.build()

*[Chart reference: AgentInstantiationChart]*

### Per-Agent Memory

*[Chart reference: PerAgentMemoryChart]*

### Capacity — RSS vs concurrent live agents

*[Chart reference: MaxConcurrentChart]*

### At a glance

|                            |            Cersei |    Agno | PydanticAI | LangGraph |    CrewAI |
| -------------------------- | ----------------: | ------: | ---------: | --------: | --------: |
| Version                    |     0.1.6-patch.2 |  2.5.17 |     1.22.0 |     1.1.8 |    1.14.2 |
| Instantiation p50          |       **7.12 μs** | 6.50 μs |     219 μs |  5 536 μs | 28 509 μs |
| Per-agent memory           |         **704 B** | 5.8 KiB |    8.7 KiB |  30.2 KiB |  17.7 KiB |
| Wall to build 500          |        **4.4 ms** | 13.5 ms |     125 ms |  2 246 ms | 50 697 ms |
| RSS @ 500 agents           |        **8.5 MB** |   82 MB |     123 MB |    193 MB |  1 739 MB |
| Graph memory in-process    |  **Yes** (Grafeo) |      No |         No |        No |        No |
| Semantic search in-process | **Yes** (usearch) |      No |         No |        No |        No |

### When to choose Cersei over the Python stack

* **You need to run thousands of concurrent agents on one host.** Memory per agent decides your ceiling. Cersei is 8–44× tighter than anything in Python.
* **You want graph memory or semantic search in-process.** The Python frameworks do not ship either. Bolting on a vector DB means network hops, serialization, and a second runtime to operate.
* **You are paying for the GIL.** Any real concurrency story in Python either runs multiple processes (big memory tax) or wraps blocking work in asyncio (CPU-bound sections still serialize). Cersei + tokio uses every core natively.
* **You want a single static binary at the edge.** Cersei is a 15 MB Rust binary. Agno/PydanticAI/LangGraph/CrewAI ship ~50+ Python deps and a runtime.

### When to prefer Agno or PydanticAI

* **You're already deep in a Python ML stack** and the 8–12× memory hit is acceptable for your fleet size.
* **You need type-driven structured output with Pydantic validators at the core** — PydanticAI is purpose-built for that.
* **Your team can't take on Rust.** Cersei exposes a C-ABI-free SDK that must be linked from Rust or called via a bin; there is no first-class Python binding yet.

## Abstract CLI Documentation (/docs/abstract)

# Abstract CLI Documentation

Abstract represents "a complete CLI coding agent built on the Cersei SDK" with single-binary distribution and graph-based memory functionality.

## Installation

The toolkit provides two installation pathways. A streamlined shell script handles OS detection and dependency setup:

```bash
curl -fsSL https://cersei.pacifio.dev/install-abstract.sh | bash
```

Alternatively, users with Rust environments can build directly from source using Cargo.

## Command Patterns

The agent supports interactive sessions, single-command execution, and resumable workflows. Notable invocations include model selection (`--model opus --max`), output formatting (`--json`), provider specification, and working directory configuration.

## Configuration Architecture

Settings follow a hierarchical precedence model starting with built-in defaults, progressing through global and project-level TOML files, environment variables, and finally CLI arguments. Key configurable parameters encompass model selection, token limits, interface theming, and memory behavior.

## Authentication Methods

The system accommodates both interactive credential entry and environment-based configuration. Support extends across Anthropic and OpenAI providers, with automatic detection based on available API keys.

## Session Management

Sessions persist as append-only JSONL records with automatic partitioning when reaching 50MB thresholds. Users can enumerate, examine, and remove sessions via dedicated commands, including resumption of prior conversations.

## Graph Memory System

"Graph recall returns results in 98 microseconds — indexed lookups instead of scanning every file," implementing relationship-based storage through nodes and directed edges representing memory associations.

## Core Architecture

The implementation layers CLI presentation atop the Cersei SDK foundation, delegating substantive agent operations to the underlying framework while managing user interaction and configuration orchestration.

## Abstract Slash Commands (/docs/abstract-commands)

# Slash Commands

Type these inside the Abstract REPL:

| Command         | Aliases       | Description                                                       |
| --------------- | ------------- | ----------------------------------------------------------------- |
| `/help`         | `/h`, `/?`    | Show command list and CLI subcommands                             |
| `/sessions`     | `/ls`         | List all sessions                                                 |
| `/clear`        |               | Clear conversation, start fresh                                   |
| `/compact`      |               | Trigger manual context compaction                                 |
| `/cost`         |               | Show token usage and cost                                         |
| `/commit`       |               | Generate a git commit with AI message                             |
| `/review`       |               | AI code review of current changes                                 |
| `/memory`       | `/mem`        | Show memory status (graph stats, memdir, CLAUDE.md)               |
| `/model <name>` |               | Switch model (`opus`, `sonnet`, `haiku`, `4o`, `gemini`, `llama`) |
| `/config`       | `/cfg`        | Show or set config values                                         |
| `/diff`         |               | Show `git diff` with syntax highlighting                          |
| `/resume [id]`  |               | Resume a previous session                                         |
| `/exit`         | `/quit`, `/q` | Exit the REPL                                                     |

## CLI Subcommands

```bash
abstract sessions list       # List sessions
abstract sessions show <id>  # Show transcript
abstract sessions rm <id>    # Delete session
abstract config show         # Show config
abstract config set <k> <v>  # Set config value
abstract memory show         # Show memory context
abstract memory clear        # Clear all memory
abstract mcp add <n> <cmd>   # Add MCP server
abstract mcp list            # List MCP servers
abstract mcp remove <name>   # Remove MCP server
abstract init                # Initialize project
abstract login [provider]    # Authenticate
abstract logout              # Remove credentials
```

## Flags

```bash
--resume [session-id]   Resume a session (default: last)
-m, --model <name>      Model override
-p, --provider <name>   Provider override (anthropic, openai, groq, google, etc.)
--fallback <models>      Fallback models, comma-separated (for provider switching)
--fast                   Low effort, minimal thinking
--max                    Maximum thinking budget
--no-permissions         Auto-approve all (CI mode)
--json                   NDJSON output for piping
-v, --verbose            Debug logging
-C, --directory <path>   Working directory override
```

## Library Benchmarks (/docs/bench-library)

# Library Benchmarks

Cersei SDK in-process performance. Apple Silicon, release build, 50 iterations with warmup.

## Tool Dispatch

| Tool  | Avg     | Min     | Max     |
| ----- | ------- | ------- | ------- |
| Edit  | 0.02ms  | 0.02ms  | 0.04ms  |
| Glob  | 0.05ms  | 0.05ms  | 0.13ms  |
| Write | 0.06ms  | 0.05ms  | 0.19ms  |
| Read  | 0.09ms  | 0.08ms  | 0.12ms  |
| Grep  | 6.04ms  | 4.88ms  | 6.82ms  |
| Bash  | 16.67ms | 16.39ms | 17.00ms |

Grep latency is dominated by `rg` process spawn. Bash latency is shell execution. Everything else is pure in-process I/O.

## Session I/O

| Operation                   | Speed         |
| --------------------------- | ------------- |
| Session write (single)      | 27 us/entry   |
| Session write (100 burst)   | 26.5 us/entry |
| Session load (100 entries)  | 268 us        |
| Session load (1000 entries) | 2633 us       |

Write throughput: ~36000 entries/sec. Load scales linearly at ~2.6 us/entry.

## Context Building

| Operation                            | Speed   |
| ------------------------------------ | ------- |
| Full context (CLAUDE.md + MEMORY.md) | 45 us   |
| Load MEMORY.md (200 lines)           | 14.6 us |

## Auto-Dream Gates

| Operation                   | Speed    |
| --------------------------- | -------- |
| `should_consolidate()`      | 10 us    |
| `should_extract()`          | sub-1 us |
| `parse_extraction_output()` | 0.7 us   |

Per-turn overhead for memory gates: under 12 microseconds.

## Run

```bash
# Tool I/O
cargo run --example benchmark_io --release

# Memory + sessions
cargo run --example stress_memory --release

# Full standalone suite
cd examples/benchmark && cargo run --release
```

## Graph Memory Benchmarks (/docs/bench-graph)

# Graph Memory Benchmarks

Grafeo embedded graph database. Apple Silicon, release build, `memory_bench.rs`.

## Operations

| Operation              | Time                 | Notes                       |
| ---------------------- | -------------------- | --------------------------- |
| Store single node      | 30 us                | UUID + content + metadata   |
| Store 100 nodes (bulk) | 8572 us (86 us/node) | Amortized with WAL          |
| Tag memory (topic)     | 1241 us              | Creates/links Topic node    |
| Link memories (edge)   | 2681 us              | Creates RELATES_TO edge     |
| Query by type          | 3200 us              | Filter all Memory nodes     |
| Query by topic         | 77 us                | Traverse Topic-Memory edges |
| Recall (hit)           | 98 us                | Indexed content lookup      |
| Stats                  | 480 us               | Count nodes/edges           |

Benchmark dataset: 1503 memories, 123 topics, 152 relationships.

## Graph ON vs OFF

Same operations on identical 100-file dataset:

| Operation          | Graph OFF | Graph ON   | Delta      |
| ------------------ | --------- | ---------- | ---------- |
| Scan 100 files     | 1310 us   | 1308 us    | -0.2%      |
| Recall (100 files) | 1359 us   | **103 us** | **-92.5%** |
| Build context      | 17 us     | 16 us      | -6.4%      |

"Graph recall is **92.5% faster** than text-matching recall." The graph leverages indexed lookups rather than scanning every file.

Scan and context building remain unaffected — the graph introduces no overhead to those operations.

## Scaling

| File Count | Scan (graph OFF) | Recall (graph ON) |
| ---------- | ---------------- | ----------------- |
| 10         | 141 us           | ~10 us            |
| 100        | 1212 us          | 103 us            |
| 200        | 2411 us          | ~103 us           |
| 500        | 6154 us          | ~103 us           |

Text-matching recall increases linearly with file count. "Graph recall is constant — it queries the index regardless of dataset size."

## Run

```bash
cargo run --release -p abstract-cli --example memory_bench
```

## Abstract CLI Benchmarks (/docs/bench-abstract)

# Abstract CLI Benchmarks

Measures framework overhead, not model speed. Apple Silicon, release build.

## Startup

| Metric                     | Abstract | Notes                                        |
| -------------------------- | -------- | -------------------------------------------- |
| `--version` (avg, 50 runs) | 32ms     | Includes Python subprocess overhead (~20ms) |
| `--version` (native)       | ~8ms     | Direct wall-clock                            |
| `--help`                   | 21ms     |                                              |

## Binary & Memory

| Metric              | Value  |
| ------------------- | ------ |
| Binary size         | 6.0 MB |
| Peak RSS (`--help`) | 4.9 MB |

## Subcommand Latency

20 iterations each:

| Subcommand      | Avg  |
| --------------- | ---- |
| `--help`        | 21ms |
| `sessions list` | 21ms |
| `config show`   | 20ms |
| `mcp list`      | 21ms |
| `memory show`   | 22ms |

All subcommands complete in ~21ms — process startup dominates. The operation itself adds under 1ms.

## End-to-End Agentic Latency

Full round-trip: CLI startup + config + system prompt + API call + streaming + rendering.

Using OpenAI gpt-4o:

| Test                       | Avg (5 runs) |
| -------------------------- | ------------ |
| Simple response ("say OK") | 1078ms       |
| Multi-word response        | 1094ms       |
| JSON output mode           | 1004ms       |

Estimated overhead breakdown:

| Phase                         | Time           |
| ----------------------------- | -------------- |
| Process startup               | ~8ms           |
| Config + memory context       | ~2ms           |
| System prompt assembly        | ~1ms           |
| Tool definition serialization | ~1ms           |
| HTTP connection + TLS         | ~50-100ms      |
| **Framework overhead**        | **~60-110ms**  |

Everything else is network + model inference.

## Sequential Throughput

10 consecutive prompts, compared across all three tools:

| Tool        | Total    | Per-request    |
| ----------- | -------- | -------------- |
| Abstract    | 15637ms  | **1564ms/req** |
| Codex CLI   | 41518ms  | 4152ms/req     |
| Claude Code | 120787ms | 12079ms/req    |

Abstract processes 10 prompts in 16 seconds. Codex takes 42 seconds. Claude Code takes 2 minutes.

## Run

```bash
./run_tool_bench_claude.sh --iterations 20 --full
./run_tool_bench_codex.sh --iterations 20 --full
```

## Benchmarks: vs Claude Code and Codex (/docs/bench-vs-claude-code)

# Benchmarks: vs Claude Code and Codex

## Abstract vs Claude Code vs Codex CLI

Three-way comparison. Claude Code numbers from `run_tool_bench_claude.sh --full`. Codex numbers from `run_tool_bench_codex.sh --full`. All using the respective tool's non-interactive mode (`claude -p`, `codex exec`).

**Claude Code** v2.0.76 (Bun/JS, Anthropic Max plan). **Codex CLI** v0.118.0 (Node.js/Rust hybrid, OpenAI). **Abstract** v0.1.0 (Rust, OpenAI gpt-4o).

## Infrastructure

| Metric               | Abstract   | Claude Code    | Codex CLI |
| -------------------- | ---------- | -------------- | --------- |
| Startup              | **22ms**   | 266ms          | 57ms      |
| Binary / package     | **6.0 MB** | 174 MB         | ~15 MB    |
| Peak RSS             | **4.7 MB** | 333 MB         | 44.7 MB   |
| `--help` latency     | **20ms**   | 263ms          | 57ms      |
| Tool dispatch (Read) | **0.09ms** | ~265ms (fork)  | —         |

Abstract is a single static Rust binary. Claude Code bundles the Bun runtime. Codex uses Node.js with a Rust sandbox component. Codex is significantly lighter than Claude Code but still 9.4x heavier than Abstract.

## Memory

The largest gap across all three tools. Both Claude Code and Codex use LLM calls for memory operations. Abstract uses an embedded graph database.

| Operation                 | Abstract         | Claude Code     | Codex CLI    |
| ------------------------- | ---------------- | --------------- | ------------ |
| Memory recall (agent)     | **98us** (graph) | 7545ms (Sonnet) | 5751ms (GPT) |
| Memory write (agent)      | **28us** (graph) | 20687ms         | 5882ms       |
| Memory recall (file I/O)  | **1.3ms** (text) | 17.5ms (grep)   | —            |
| MEMORY.md load            | **9.6us**        | 17.1ms          | —            |
| File scan (100 files)     | **1.2ms**        | 26.6ms          | —            |
| Session parse (20K lines) | **~53ms**        | 378.7ms         | —            |

Claude Code calls Sonnet every turn to rank which 5 memory files are relevant (~7.5 seconds). Codex runs the full agent pipeline for memory operations (~5.8 seconds). Abstract's graph does indexed lookups in 98 microseconds — no LLM call, no API cost.

## Agentic Throughput

End-to-end prompt-to-response latency. Abstract and Codex both use OpenAI models. Claude Code uses Anthropic Opus via Max plan.

| Metric                   | Abstract       | Claude Code | Codex CLI  |
| ------------------------ | -------------- | ----------- | ---------- |
| Simple prompt ("say OK") | **2122ms**     | 8942ms      | 3843ms     |
| Sequential (10 prompts)  | **1564ms/req** | 12079ms/req | 4152ms/req |

The throughput gap between Abstract and Codex (2.7x) is purely framework overhead — both hit the same OpenAI API. The gap between Codex and Claude Code (2.9x) includes both framework overhead and provider latency differences.

## Token Consumption

| Factor                   | Abstract      | Claude Code    | Codex CLI       |
| ------------------------ | ------------- | -------------- | --------------- |
| System prompt            | ~2200 tokens  | ~8000+ tokens  | ~10000+ tokens  |
| Tool definitions         | 34 tools      | ~40 tools      | ~30 tools       |
| "say OK" total tokens    | —             | —              | 10180           |
| LLM call for recall      | **No**        | Yes (Sonnet)   | Yes (GPT)       |
| Per-turn memory overhead | **12us**      | ~7500ms        | ~5800ms         |

Codex used 10180 tokens for a 2-word response. The bulk is system prompt, tool definitions, and workspace context that Codex sends every turn.

## Summary

| Category       | Abstract       | Claude Code        | Codex CLI         |
| -------------- | -------------- | ------------------ | ----------------- |
| Startup        | **22ms**       | 266ms (12x)        | 57ms (2.6x)       |
| RSS            | **4.7 MB**     | 333 MB (71x)       | 44.7 MB (9.5x)    |
| Simple prompt  | **2122ms**     | 8942ms (4.2x)      | 3843ms (1.8x)     |
| Throughput     | **1564ms/req** | 12079ms/req (7.7x) | 4152ms/req (2.7x) |
| Memory recall  | **98us**       | 7545ms             | 5751ms            |
| Memory write   | **28us**       | 20687ms            | 5882ms            |
| Graph memory   | Yes            | No                 | No                |
| LLM for recall | **No**         | Yes                | Yes               |

Ratios in parentheses are relative to Abstract.

## Reproduce

```bash
# vs Claude Code
./run_tool_bench_claude.sh --iterations 20 --full

# vs Codex CLI
./run_tool_bench_codex.sh --iterations 20 --full

# Memory architecture
cargo run --release -p abstract-cli --example memory_bench
```

Full report: [`crates/abstract-cli/benchmarks/REPORT.md`](https://github.com/pacifio/cersei/blob/main/crates/abstract-cli/benchmarks/REPORT.md)

## Cersei vs Agno / LangGraph / CrewAI / PydanticAI (/docs/bench-vs-agents)

# Cersei vs Agno / LangGraph / CrewAI / PydanticAI

## General Agent Framework Benchmark

Cersei, a Rust SDK originally built for coding agents, now competes with general-purpose Python frameworks through features including graph memory, in-process semantic search, sub-agent orchestration, hooks, and permission systems.

The key differentiator measured here addresses production constraints: "how many live agent instances can you hold on one host before p99 latency or memory blows up." Rust's native structs and zero-overhead `Arc` sharing provide advantages in this domain.

### Methodology

Benchmarks construct real agents without network calls or inference invocation. The focus isolates framework overhead from provider costs, following Agno's own performance methodology. Measurements use identical harness suites across all frameworks tested on Apple M1 Pro.

---

## Axis 1 — Instantiation Time

Constructing one ready-to-use Agent with one tool, measured over 1000 samples (100 warmup):

| Framework  | Version       | Instantiation p50 | Ratio vs Cersei |
| ---------- | ------------- | ----------------: | --------------: |
| **Cersei** | 0.1.6-patch.2 |       **7.12 μs** |              1× |
| Agno       | 2.5.17        |           6.50 μs |            0.9× |
| PydanticAI | 1.22.0        |         219.12 μs |             31× |
| LangGraph  | 1.1.8         |       5 536.17 μs |        **777×** |
| CrewAI     | 1.14.2        |      28 508.83 μs |      **4 004×** |

Cersei achieves comparable performance to Agno despite including batteries-in: "Cersei is 31× faster than PydanticAI, 777× faster than LangGraph, 4,000× faster than CrewAI."

---

## Axis 2 — Per-Agent Memory

Bytes per agent across 1000 live instantiations (Cersei uses `jemalloc`; Python frameworks use `tracemalloc`):

| Framework  |    Per-agent memory | Ratio vs Cersei |
| ---------- | ------------------: | --------------: |
| **Cersei** |           **704 B** |              1× |
| Agno       |   5.8 KiB (5 938 B) |            8.4× |
| PydanticAI |   8.7 KiB (8 892 B) |           12.6× |
| CrewAI     | 17.7 KiB (18 157 B) |           25.8× |
| LangGraph  | 30.2 KiB (30 910 B) |             44× |

The result demonstrates substantial savings: "One Cersei agent fits 8× smaller than the leanest Python framework and 44× smaller than LangGraph."

---

## Axis 3 — Max Concurrent Agents

Production capacity: agent construction and retention on a single host:

### Cersei Results

| N live agents | p50 per-build | p99 per-build | RSS (total) | Wall to build all N |
| ------------: | ------------: | ------------: | ----------: | ------------------: |
|           100 |       0.05 ms |       0.21 ms |      8.3 MB |              1.0 ms |
|           500 |       0.05 ms |       0.13 ms |      8.5 MB |              4.4 ms |
|         1 000 |       0.05 ms |       0.13 ms |      9.3 MB |              8.5 ms |
|         5 000 |       0.06 ms |       0.14 ms |     14.0 MB |             42.3 ms |
|    **10 000** |   **0.06 ms** |   **0.16 ms** | **22.4 MB** |         **86.6 ms** |

Ten thousand concurrent Cersei agents construct and remain live in 87 milliseconds using 22.4 MB total memory, with p99 per-build latency under 200 microseconds.

### Python Frameworks Comparison

| Framework  |     @ N=100 — RSS / wall |         @ N=500 — RSS / wall |
| ---------- | -----------------------: | ---------------------------: |
| **Cersei** |      **8.3 MB / 1.0 ms** |          **8.5 MB / 4.4 ms** |
| Agno       |         79.3 MB / 7.7 ms |            82.0 MB / 13.5 ms |
| PydanticAI |       122.0 MB / 28.9 ms |          123.2 MB / 125.0 ms |
| LangGraph  |      193.5 MB / 361.3 ms |        193.5 MB / 2 246.5 ms |
| CrewAI     | 1 739.3 MB / 11 628.5 ms | 1 739.3 MB / **50 697.4 ms** |

CrewAI demonstrates dramatic constraints: building 500 agents requires 50 seconds and 1.7 GB memory, versus Cersei's 4.4 milliseconds on 8.5 MB—"11,500× the wall time and 204× the RSS for the same capacity."

---

## Axis 4 — Graph Memory Recall Under Load

Cersei includes Grafeo, a schema-versioned, file-backed in-process graph database.

Under 10 concurrent readers × 100 recalls, 10,000 nodes (Apple M1 Pro):

| Metric |  Value |
| ------ | -----: |
| p50    |  94 ms |
| p95    | 120 ms |
| p99    | 139 ms |

Higher concurrency (100+ simultaneous readers) shows serialization behind the read path, currently tracked as work-in-progress. Single-reader recall measures approximately 98 microseconds.

---

## Axis 5 — Semantic Search Under Load

In-process HNSW semantic search via `cersei-embeddings`:

Under 50 concurrent agents × 100 queries, 10,000 embedded chunks (cosine, 64-dimensional vectors):

| Metric |     Value |
| ------ | --------: |
| p50    | **51 μs** |
| p95    |    132 μs |
| p99    |    354 μs |

Lock-free HNSW internals enable clean concurrent scaling, with fifty agents issuing 100 queries each completing at sub-millisecond p95 latency.

---

## Reproduce the Numbers

Python dependencies use `uv`. Each framework operates in isolated virtual environments via `pyproject.toml`:

```bash
# Cersei (host)
cargo run --release -p cersei-agent --example general_agent_bench --features bench-full

# All frameworks
cd bench/general-agents
./run.sh

# Per-framework
./run.sh --only cersei
./run.sh --only agno
uv run --extra pydantic_ai python bench_pydantic_ai.py

# Docker with cgroup cap
./run.sh --docker
BENCH_MEM_CAP=16g ./run.sh --docker
```

Configuration for selective axes and scale tuning:

```bash
# Skip slow graph/semantic axes
CERSEI_BENCH_AXES=1,2,3 cargo run --release ...

# Increase graph/semantic scales to 100k
CERSEI_BENCH_GRAPH_MAX=100000 CERSEI_BENCH_SEMANTIC_MAX=100000 cargo run --release ...
```

Measurements output to `bench/general-agents/results/<framework>.json`, merged by `aggregate.py` into `summary.json`.

## LongMemEval — Memory Benchmark (/docs/bench-memory)

# LongMemEval — Memory Benchmark

LongMemEval (ICLR 2025) is the 500-question long-term-memory benchmark used by Mastra for its Observational Memory research, cited by Zep in the Graphiti paper, and referenced by Supermemory in comparisons. Cersei ran the same 500 questions through four memory configurations to align results one-to-one with published frameworks.

## Summary Results

Testing occurred on 2026-04-25 using version 0.1.8 with the Memory++ stack. All components—answerer, judge, and observer—used `gemini-2.5-flash`; embeddings relied on `gemini-embedding-001` (3072-dimensional, Matryoshka).

| Config | Overall Accuracy | Abstention | Correct / Total | Input Tokens | Avg Wall (ms) |
|--------|------------------|-----------|-----------------|--------------|---------------|
| Full-context baseline | 87.6% | 93.3% (28/30) | 434/500 | 55.37M | 9,564 |
| Semantic recall | 86.6% | 93.3% (28/30) | 428/500 | 2.90M | 39,124 |
| Graph substring | 2.2% | 96.7% (29/30) | 33/500 | 0.46M | 4,081 |
| Hybrid configuration | 86.3% | 90.0% (27/30) | 430/500 | 1.78M | 183,733 |

The hybrid configuration incorporated "Omega-style per-question-type RAG prompts, LLM query expansion (lexical, vector, HyDE), abstention floors, and Jaccard semantic deduplication at ingest."

## Leaderboard Position

Against competing systems across frameworks:

| System | Model | Overall | Delta vs Cersei Baseline |
|--------|-------|---------|-------------------------|
| Mastra OM | gpt-5-mini | 94.87% | +7.3 |
| Mastra OM | gemini-3-pro-preview | 93.27% | +5.7 |
| Hindsight | gemini-3-pro-preview | 91.40% | +3.8 |
| **Cersei Baseline** | **gemini-2.5-flash** | **87.6%** | — |
| **Cersei Hybrid** | **gemini-2.5-flash** | **86.3%** | −1.3 |
| Supermemory | gpt-5 | 84.60% | −3.0 |
| Zep | gpt-4o | 71.20% | −16.4 |

## Per-Question-Type Results

| Question Type | Count | Baseline | Embedding | Graph | Hybrid |
|---|---|---|---|---|---|
| knowledge-update | 72 | 87.5% | 90.3% | 0.0% | 90.3% |
| multi-session | 121 | 78.5% | 76.0% | 0.0% | 81.0% |
| single-session-assistant | 56 | 98.2% | 96.4% | 0.0% | 96.4% |
| single-session-preference | 30 | 80.0% | 83.3% | 13.3% | 76.7% |
| single-session-user | 64 | 96.9% | 89.1% | 0.0% | 90.6% |
| temporal-reasoning | 127 | 84.3% | 84.3% | 0.0% | 82.7% |

The hybrid configuration achieved a targeted "+2.5 percentage point lift on multi-session questions" compared to prior versions.

## Cost Analysis

| Configuration | Input Tokens | Estimated Cost | Cost/Question |
|---|---|---|---|
| Baseline | 55.37M | $16.61 | 9.6s |
| Embedding-only | 2.90M | $0.92 | 39.1s |
| Graph | 0.46M | $0.14 | 4.1s |
| Hybrid | 1.78M | $5–8 | 183.7s |

The embedding approach delivered "19× fewer input tokens than full-context baseline" while maintaining comparable accuracy.

## Configurations Tested

1. **Baseline**: `JsonlMemory` with full haystack in prompt—control establishing the upper bound
2. **Semantic Recall**: `EmbeddingMemory` with HNSW index and Gemini embeddings
3. **Graph Substring**: `GraphMemory` using substring matching without semantic processing
4. **Hybrid**: LLM fact extractor feeding both embedding and graph retrieval with RRF fusion

## Methodology

The benchmark employed the official `xiaowu0162/longmemeval` dataset containing 500 questions across six categories. Evaluation used a "verbatim port of Mastra's judge rubric" and identical abstention detection. Top-k retrieval was set to 20 across configurations. All models ran at temperature 0 (0.3 for the observer component).

## Running the Benchmark

Full execution requires approximately $20–30 in API costs and 3–4 hours at concurrency level 4:

```bash
./bench/long-mem/setup.sh
echo "GOOGLE_API_KEY=AIza..." > .env
cargo run --release -p longmem-bench -- \
  --dataset s --config all --concurrency 4 --top-k 20
```

A smoke test using the oracle variant with 10 questions completes in ~30 seconds for under $0.05.

## Security Measures

The project implemented several protections: API keys flow through HTTP headers rather than query strings, error messages are scrubbed of credentials before logging, environment variables replace hardcoded keys, and Git ignores sensitive files. A "pre-commit sanity check" verifies no credentials appear in tracked files.

## Key Findings

The Memory++ stack improved multi-session accuracy by 2.5 percentage points. The semantic retrieval approach achieved "18× cost reduction versus baseline" on Gemini while surpassing several competing frameworks on budget-constrained models. Graph-based substring matching proved inadequate, registering only 2.2% accuracy, though high abstention rates (96.7%) prevented incorrect answers.

## Changelog (/docs/changelog)

# Changelog

## Version 0.2.1 (2026-06-23)

**Added:**
- New crate `cersei-workflows` — a workflow engine enabling visual builder round-trips via "One IR, two front-ends" architecture
- Serializable `WorkflowDef` serves as single source of truth with programmatic and UI-based emission
- Step trait mirroring tools with `FnStep`, `AgentStep`, `ToolStep`, and `WorkflowStep` implementations
- Live status streaming via `WorkflowEvent`/`WorkflowStream` with snapshot-driven suspend/resume via `RunStore`
- Workspace version bumped to 0.2.1 across all crates

## Version 0.2.0 (2026-06-19)

**Added:**
- New crate `cersei-agentrl` — self-evolving orchestration layer with "run → fail → trace → plan → sandbox → promote → register" loop
- New crate `cersei-agentlang` — functional DSL for agents with `parse` → `Program` → `run_program` execution
- New crate `cersei-tbench` — terminal-bench coding agent on Cersei SDK
- `--agentrl` mode in abstract-cli for headless task solving
- Anthropic via Google Vertex AI support (`AnthropicVertex`)
- "Custom OpenAI-compatible endpoints" with base URL overrides and redacted logging
- Workspace bumped to 0.2.0 (18-crate layout)

**Changed:**
- API keys now trimmed on read; whitespace-only values treated as absent
- OpenAI-compatible router resolves base URL through dedicated helper

**Fixed:**
- UTF-8 panic on multibyte TUI input (CJK text cursor handling)
- UTF-8 panic on accented characters (six byte-slice truncators now char-based)

## Version 0.1.9 (2026-05-17)

**Added:**
- New crate `cersei-vms` — sandbox & VM isolation for coding agents
- Core traits: `SandboxRuntime`, `Sandbox`, `Commands`, `Filesystem`
- `LocalProcessRuntime` (test/local) and `DockerRuntime` (container isolation)
- Cross-sandbox primitives: `Volume`, `Mailbox`, `KvStore`
- First-party snapshots via `docker commit` + JSON manifest
- `cersei-envd` binary — JSON-RPC daemon for in-VM operations
- Reference image: `cersei/sandbox-base:latest` (~8 MB Alpine)
- VMs feature integration with transparent routing in `BashTool`
- `cersei` facade with default-on `vms` feature
- 9 passing tests covering snapshot round-trip and cross-sandbox operations
- Workspace version bumped to 0.1.9 (15-crate layout)

**Deferred:**
- Agent sandbox allocation, CLI `--sandbox` flag, and firecracker/E2B/Vercel backends

## Version LongMemEval Benchmark (2026-04-24)

**Added:**
- LongMemEval benchmark dataset (500 questions) across four memory configurations
- Hybrid configuration achieves "85.7% overall, 93.3% abstention, 432/500 correct, 1.58M input tokens"
- Hybrid outperforms Supermemory/gpt-5 (84.6%), Mastra OM/gpt-4o (84.23%), and Zep/gpt-4o (71.2%)
- Embed-only configuration: 84.2% overall, 429/500 correct, 2.68M input tokens (20× fewer than baseline)
- `EmbeddingMemory` adapter bridging embedding store into Memory trait
- `GraphMemory::recall_top_k()` with scored retrieval via query word matching
- `GeminiEmbeddings` rewritten for `gemini-embedding-001` with bounded concurrent streaming
- Gemini API key plumbing moved to `x-goog-api-key` header (security improvement)

**Fixed:**
- Multi-byte UTF-8 truncation panic in embedding batch calls

**Changed:**
- Tightened `.gitignore` for bench artifacts containing sensitive data

## Version 0.1.7 (2026-04-20)

**Added:**
- New crate `cersei-compression` — structural compression for tool outputs
- Three levels: `Off`, `Minimal` (ANSI/comment stripping), `Aggressive` (language-aware stubbing)
- Rule engine, language-aware filters, and TOML DSL ported from rtk (Patrick Szymkowiak)
- Agent builder + runtime knobs for compression control
- Abstract CLI `--compress` flag and `/compression` slash command
- Live-provider benchmarks: "OpenAI gpt-4o-mini −29.1% tokens, Gemini −62.1%"
- Per-call observability via structured tracing events
- Workspace version bumped to 0.1.7

**Changed:**
- `cersei-agent::Agent` gained `compression_level` field (defaults to `Off`)

## Version 0.1.6-patch.2 (2026-04-18)

**Added:**
- New crate `cersei-embeddings` — provider-agnostic text embeddings
- `GeminiEmbeddings` (768-d) and `OpenAiEmbeddings` (1536-d) implementations
- `EmbeddingProvider` trait with `VectorIndex` and `EmbeddingStore` composition
- General-Agent Framework Benchmark comparing against Agno, PydanticAI, LangGraph, CrewAI
- Cersei achieves "704B per agent, 8× smaller than Agno, 44× smaller than LangGraph"
- Concurrent agent construction: "500 agents in 4.4ms on 8.5MB vs CrewAI's 50,697ms on 1,739MB"
- Four chart components for benchmark visualization
- Harness at `crates/cersei-agent/benchmarks/general_agent_bench.rs`

**Changed:**
- `cersei-tools::code_search` delegates to `cersei-embeddings`
- `abstract-cli` uses `auto_from_model` instead of inline detection
- Google provider default upgraded from `gemini-2.0-flash` to `gemini-3.1-pro-preview`
- `abstract login <provider>` accepts all registered providers

**Fixed:**
- `cersei-lsp` version now inherits from workspace (was hardcoded)
- Auto-default silently picking Ollama; now requires explicit selection
- `abstract login google` rejection fixed

## Version 0.1.6-patch.1 (2026-04-13)

**Added:**
- VibeProxy support with `--proxy` and `--proxy-url` CLI flags
- Channel-based TUI permissions (replacing stdin-based system)
- Virtualized message list rendering (O(viewport height) instead of O(total lines))
- Inline diff viewer with syntax highlighting
- Multi-line textarea input with dynamic height
- Four cookbooks and dedicated comparisons page

**Changed:**
- Permission overlay sizing and layout
- TUI rendering performance and responsiveness

**Fixed:**
- TUI permission freeze from stdin race condition
- Stale scroll content and Ghostty resize crash
- Missing slash commands

## Version 0.1.6 (2026-04-12)

**Added:**
- New crate `cersei-lsp` — on-demand LSP server management (JSON-RPC 2.0)
- Tree-sitter code intelligence for Rust, TypeScript/JS, Python, Go
- Production TUI at 62 FPS with side panel (Git Diff + File Tree), 5 permission modes
- 16 slash commands, markdown rendering, graph visualization, syntax highlighting
- Parallel tool execution via `futures::join_all()` with exponential backoff
- File snapshot/undo capability with `/undo` command
- `ApplyPatch` tool for unified diff patching
- Shell state persistence via cwd capture
- GPT-5.x support (gpt-5.3-chat-latest default, 1M context)
- AGENTS.md/CLAUDE.md hierarchy walking
- File watching via notify crate
- Three themes (Enterprise/Light/Solarized)

**Changed:**
- Default OpenAI model: `gpt-4o` → `gpt-5.3-chat-latest`
- Default theme to Enterprise (AMOLED black)
- `Agent::run_stream()` uses `Arc<Self>` for safety
- System prompt rewritten for deep exploration

**Fixed:**
- TUI streaming blocking, mid-stream cancellation
- OpenAI `max_completion_tokens` handling
- Token stats/cost display, git diff with untracked files
- Markdown wrapping and paste handling

## Version 0.1.5 (2026-04-07)

**Added:**
- `/sessions` and `/ls` slash commands for listing sessions
- Expanded `/help` with CLI subcommands
- 23-section conditional system prompt components
- `GitSnapshot` struct and `SystemPromptOptions` fields
- 11 new tests for system prompt functionality

**Changed:**
- System prompt includes output efficiency and tool summarization by default
- Git info upgraded to structured snapshot format

## Version 0.1.4 (2026-04-06)

**Added:**
- Tool primitives module with six sub-modules (diff, fs, process, http, search, git)
- 26 new tests for primitives
- Built-in tools reference documentation with input schemas
- Tool primitives documentation with cookbook examples
- Providers documentation covering 13 providers

**Changed:**
- File and bash tools refactored to delegate to tool primitives
- Web fetch refactored to use `tool_primitives::http::fetch_html`
- Grep and glob tools refactored with structured `SearchMatch` results

## Version 0.1.3 (2026-04-05)

**Added:**
- Session auto-fork when exceeding 50MB (creates `_part2.jsonl`, etc.)
- Multi-part session helpers: `all_part_paths()` and `total_session_size()`
- Sessions and Tasks documentation
- 200MB total session limit

**Changed:**
- `load_transcript()` now stitches all part files with tombstone application

**Fixed:**
- Sessions exceeding 50MB became unloadable; now auto-fork before limit

## Version 0.1.2 (2026-04-04)

**Added:**
- Multi-provider model router supporting 13 providers via "provider/model" format
- `from_model_string()` parser with auto-detection
- Provider continuity with interactive model switching on rate limits
- `--fallback` CLI flag and `fallback_models` config
- OpenAI tool calling with full streaming support
- `AgentBuilder::with_messages()` for pre-populating history

**Changed:**
- Provider resolution replaced with model router
- REPL owns Agent (not borrows) for mid-session provider swaps
- Grafeo dependency uses crates.io instead of local paths

**Fixed:**
- OpenAI tool calling loop (tool results serialize as `role: "tool"`)
- `cargo install` works on any machine

**Removed:**
- Hardcoded local filesystem paths from Cargo.toml files

## Version 0.1.1 (2026-04-03)

**Added:**
- Schema versioning and migration engine for graph databases
- Confidence decay via `last_validated_at` and `decay_rate` tracking
- Embedding readiness with `embedding_model_version` field
- Centralized GQL queries in single `mod gql` block
- Abstract CLI — complete coding agent with REPL, streaming, permissions, sessions
- Benchmark suite and documentation site (23 pages)

**Changed:**
- `GraphMemory::open()` auto-migrates on startup

**Fixed:**
- Empty `ANTHROPIC_API_KEY` no longer treated as valid auth

## Version 0.1.0 (2026-04-02)

**Added:**
- Initial release with complete Rust SDK for coding agents
- Nine crates: facade, types, provider, tools (34 built-in), tools-derive, agent, memory, hooks, MCP
- Graph memory via Grafeo embedded DB with 98-microsecond recall
- Agent builder with 20+ options and 26-variant event system
- Session persistence via append-only JSONL with tombstone soft-delete
- 11 examples and 5 stress test suites
- 160 unit tests and 262 stress checks


---

