# Telemetry

Atlas collects anonymous, metadata-only usage data to find out what breaks and what
gets used. This file is the complete catalogue: every event, every property, and the
list of things that are never collected under any circumstance.

If something is not in the table below, Atlas does not send it. If you find something
that contradicts this file, that is a bug — please open an issue.

- Emitter: [`src-tauri/src/telemetry/mod.rs`](src-tauri/src/telemetry/mod.rs) (Rust, all product events)
- Crash reporter: [`src/features/telemetry/posthog-client.ts`](src/features/telemetry/posthog-client.ts) (renderer failures only)
- Backend: [PostHog](https://posthog.com)

---

## Consent

The toggle is **Settings → General → "Share anonymous usage data"**. It defaults to
**ON**, the same opt-out posture as VS Code and Zed, and it can be turned off at any
time — the change takes effect immediately, without a restart.

With the toggle off, `capture()` returns before anything is queued. Nothing is
buffered for later, and nothing is sent.

A build with no PostHog key resolved is **inert**: the client is constructed dead, the
frontend never loads `posthog-js` at all, and the toggle does nothing. Source builds
are inert unless you supply your own key (see [Self-hosting](#self-hosting-and-opting-out-entirely)).

---

## Identity: one anonymous install, permanently

Telemetry identity is a single random UUID (`telemetry_anon_id`) generated on first
launch and stored in `state.json`. It is the PostHog `distinct_id` for both the Rust
emitter and the renderer's crash reporter, so one install maps to one anonymous
person. It is not derived from your machine, your account, or anything about you.

**Signing in to an Atlas account does not change this.** There is no `identify` and no
`alias` call anywhere in the desktop app. The account events below carry no user id,
no email, and no Organisation id.

This is not an oversight — it is the point. Linking the install UUID to a real user on
sign-in would retroactively de-anonymize every event the install had ever sent, under
a consent string that promised the opposite. Identified analytics happens server-side,
where an account already exists and the user is signing in to it knowingly.

The consequence, stated plainly: **an install that has never opted in sends nothing
extra as a result of signing in.** The account feature is not a telemetry backdoor.

---

## Common properties

Every event carries these four and nothing else implicitly:

| Property | Value |
| --- | --- |
| `$lib` | `atlas-rust` (Rust emitter) or `atlas-js` (renderer crash reporter) |
| `app_version` | Atlas version, e.g. `0.2.1` |
| `os` | `macos`, `linux`, `windows` |
| `arch` | `aarch64`, `x86_64` |

PostHog also records the ingest timestamp and the request's IP, which it uses for
coarse geo-resolution. Atlas sends no other device, network, or locale information.

---

## Event catalogue

### Lifecycle

| Event | When | Properties |
| --- | --- | --- |
| `app_started` | Atlas launches | `is_first_launch` (bool) |
| `rust_panic` | A Rust panic, sent synchronously from the panic hook | `location` (Atlas's own `file:line`), `message` (redacted of path / URL / email tokens, truncated to 160 chars) |

### Account (ATL-52)

| Event | When | Properties |
| --- | --- | --- |
| `auth_signed_in` | A device-authorization grant completes | *none* |
| `auth_signed_out` | The user signs out from the account menu | *none* |

Both carry **no user id, email, or Organisation id** — see
[Identity](#identity-one-anonymous-install-permanently). `auth_signed_out` records the
*user's* action only; a session the server ended (expiry or revocation) emits nothing,
because folding the two together would leave a count that means neither one thing nor
the other.

### Agents and models

| Event | When | Properties |
| --- | --- | --- |
| `agent_turn_started` | A turn is sent to an agent | `agent_kind` |
| `agent_turn_finished` | A turn completes | `agent_kind`, `stop_reason`, `usage` (token counts) |
| `agent_turn_failed` | A turn errors | `agent_kind`, `error_summary` (redacted, ≤160 chars) |
| `model_chat_sent` | A direct model chat completes | `provider`, `model`, `input_tokens`, `output_tokens` |
| `code_review_completed` | An AI code review finishes | `provider`, `model` |

`agent_kind` is currently the agent instance's internal `AgentId`, which is a random
UUID minted per registration — it identifies nothing outside the process and does not
survive a restart. The name overpromises; it is documented here as what it actually
is rather than what it sounds like.

Note what these do *not* carry: no prompt, no response, no file name, no repository,
no diff.

### Consent itself

| Event | When | Properties |
| --- | --- | --- |
| `telemetry_opt_in` | The toggle is switched on | *none* |
| `telemetry_opt_out` | The toggle is switched off | *none* |

`telemetry_opt_out` is sent while telemetry is still enabled, so nothing is
transmitted after the moment you opted out.

### Renderer crashes

`posthog-js` is loaded for **crash reporting only**. Autocapture, pageviews, page-leave
events, and session recording are all explicitly disabled — the renderer captures no
usage events of any kind.

| Event | When | Properties |
| --- | --- | --- |
| `$exception` | A React render error, uncaught `window.onerror`, or unhandled promise rejection | The error message and stack, plus `type` (`react_error_boundary` / `uncaught_error` / `unhandled_rejection`), `source`, and a truncated `component_stack` |

A short list of known-benign, non-actionable errors is dropped before it reaches
PostHog. Note that a JavaScript stack trace can contain bundled file names; it does not
contain your files, your project path, or your content.

---

## Never collected

None of the following leaves your machine as telemetry, with or without consent:

- **Prompts and responses.** No message you write to an agent, and nothing it writes back.
- **Code.** No file contents, no diffs, no patches, no repository names or remotes.
- **Paths.** No absolute or relative file paths, no project or directory names. Free-text
  fields (`message`, `error_summary`) are run through a redactor that strips path-like,
  URL-like, and email-like tokens before sending.
- **Knowledge, notes, canvases, chat history, memory.** None of it, in any form.
- **API keys and credentials.** No provider keys, no Atlas session token, no access JWT,
  no device code. These are never logged either.
- **Terminal input or output.**
- **Browser URLs, page contents, or history** from the in-app browser.
- **Account identity.** No user id, name, email, avatar URL, Organisation id, or role —
  see [Identity](#identity-one-anonymous-install-permanently).
- **Keystrokes, screenshots, or session recordings.**

---

## The one thing that is not consent-gated

The **auto-update check** queries PostHog's remote-config endpoint for the latest
version and download URL. It carries the anonymous install id and the common
properties, and it runs on launch and every few hours.

It is deliberately independent of the telemetry toggle, because an app that stops
learning about security updates when you decline analytics is a worse deal than the
one you thought you were making. It is not analytics and captures no event.

It is gated by its own setting: **Settings → Updates → "Automatic updates"**. Turn that
off and Atlas makes no background update request. An inert build never makes one at
all.

---

## Self-hosting and opting out entirely

The PostHog key and host resolve in this order, first match winning:

1. `ATLAS_POSTHOG_KEY` / `POSTHOG_KEY` (+ `ATLAS_POSTHOG_HOST` / `POSTHOG_HOST`) from
   the environment or a `.env` file
2. `<app_config_dir>/telemetry.json` — `{ "key": "...", "host": "..." }`
3. A compile-time key baked into official release builds
4. Nothing — the client is permanently inert and makes no network calls

Point rungs 1 or 2 at your own PostHog project to keep your organisation's data in
your own instance. Build from source without a key to have no telemetry path at all.
