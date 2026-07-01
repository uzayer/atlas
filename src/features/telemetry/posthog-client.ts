/**
 * Frontend telemetry — `posthog-js` for **client-side failures only** (React
 * render errors, uncaught window errors, unhandled rejections). All product /
 * usage analytics is emitted from Rust (`crate::telemetry`); the JS side never
 * captures usage events, pageviews, autocapture, or session recordings.
 *
 * Consent + identity come from Rust via the `telemetry_config` command, so the
 * browser shares the same anonymous `distinct_id` and opt-in state. Nothing is
 * sent until the user has opted in AND a PostHog key resolved server-side.
 */
import posthog from "posthog-js";
import { invoke } from "@tauri-apps/api/core";

interface TelemetryConfig {
  enabled: boolean;
  host: string;
  anonId: string;
  usingDefaultKey: boolean;
  /** Write-only project key, or null on an inert build (→ posthog never inits). */
  key: string | null;
}

let initialized = false; // initTelemetry ran
let started = false; // posthog.init() called (a key resolved)
let enabled = false; // live opt-in gate

/**
 * Known-benign client errors we never report. These are common, undiagnosed,
 * and non-actionable across every Atlas build — sending them to PostHog just
 * burns event quota (they'd recur endlessly). Matched as substrings against the
 * error message + stack.
 *
 *  1. React's dev-only "state update on a not-yet-mounted component" warning —
 *     noise from async setState landing during mount; harmless, dev-only.
 *  2. `document`-not-defined ReferenceError from a bundled dependency that
 *     touches `document` off the main document context (e.g. a worker chunk).
 */
const IGNORED_ERROR_PATTERNS: string[] = [
  "state update on a component that hasn't mounted yet",
  "Can't find variable: document",
  "document is not defined",
];

function isIgnoredError(error: unknown): boolean {
  let text = "";
  if (error instanceof Error) {
    text = `${error.message}\n${error.stack ?? ""}`;
  } else if (typeof error === "string") {
    text = error;
  } else {
    text = safeString(error);
  }
  return IGNORED_ERROR_PATTERNS.some((p) => text.includes(p));
}

/**
 * Bootstrap from Rust once at startup. Initializes `posthog-js` with capturing
 * OFF, then opts in only if the user has enabled telemetry. Never throws.
 */
export async function initTelemetry(): Promise<void> {
  if (initialized) return;
  initialized = true;

  let cfg: TelemetryConfig;
  try {
    cfg = await invoke<TelemetryConfig>("telemetry_config");
  } catch {
    return; // command unavailable → stay dark
  }
  if (!cfg.key) return; // inert build → never load posthog

  try {
    posthog.init(cfg.key, {
      api_host: cfg.host,
      bootstrap: { distinctID: cfg.anonId },
      // Crash reporting only — disable every ambient capture surface.
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      opt_out_capturing_by_default: true,
      persistence: "localStorage",
    });
    started = true;
    setEnabled(cfg.enabled);
  } catch {
    /* posthog init failure must never break app boot */
  }
}

/** Flip capturing on/off — mirrors the Settings toggle / first-run consent. */
export function setEnabled(on: boolean): void {
  enabled = on;
  if (!started) return;
  try {
    if (on) posthog.opt_in_capturing();
    else posthog.opt_out_capturing();
  } catch {
    /* ignore */
  }
}

/**
 * Report a client-side failure. No-op unless posthog is started and the user
 * has opted in. Swallows all errors so telemetry can never crash the app.
 */
export function captureClientError(
  error: unknown,
  context: Record<string, unknown> = {},
): void {
  if (!started || !enabled) return;
  // Drop known-benign, non-actionable noise before it hits PostHog quota.
  if (isIgnoredError(error)) return;
  try {
    const err = error instanceof Error ? error : new Error(safeString(error));
    posthog.captureException(err, { $lib: "atlas-js", ...context });
  } catch {
    /* never throw into the app */
  }
}

function safeString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}
