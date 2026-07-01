/**
 * Global window-level error capture. Installed once from `main.tsx` before
 * React mounts so uncaught errors and unhandled promise rejections anywhere in
 * the renderer are reported (gated on consent inside `captureClientError`).
 */
import { captureClientError } from "./posthog-client";

let installed = false;

export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (event) => {
    captureClientError(event.error ?? event.message, {
      type: "uncaught_error",
      source: "window.onerror",
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    captureClientError(event.reason, {
      type: "unhandled_rejection",
      source: "window.onunhandledrejection",
    });
  });
}
