// Dev/test-only feature flags. Plain in-memory zustand store — flags
// reset on every launch (we wipe localStorage on boot during alpha, see
// `App.tsx`). When a flag is on, the relevant subsystem swaps in a
// simulated code path so UI states can be exercised without invoking the
// real backend.

import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";

interface DevFlagsState {
  /**
   * Force the Claude Code setup banner to render the "not-installed"
   * state, so we can visually verify the install / sign-in UI without
   * actually uninstalling the CLI on this machine. While ON:
   *   - `claudeSetup.refreshStatus()` no-ops and pins phase to `not-installed`.
   *   - `claudeSetup.install()` simulates a fake install lifecycle
   *     (a few log lines → success tick → "not-authed") with no real
   *     subprocess.
   *   - `claudeSetup.authLogin()` simulates a brief auth handshake and
   *     flips to `ready`.
   * Toggling this off triggers a real `claude_status` re-check so the
   * banner reflects the actual machine state again.
   */
  triggerClaudeInstall: boolean;
  actions: {
    setTriggerClaudeInstall: (next: boolean) => void;
  };
}

export const useDevFlagsStore = createSelectors(
  create<DevFlagsState>((set) => ({
    triggerClaudeInstall: false,
    actions: {
      setTriggerClaudeInstall: (next) => set({ triggerClaudeInstall: next }),
    },
  })),
);
