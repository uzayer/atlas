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
