// Atlas account auth (ATL-35) — the frontend half.
//
// Every credential stays in Rust: the Better Auth session token and the access
// JWT never cross this boundary. What arrives here is `AuthSnapshot`, which
// carries identity and nothing secret. That split is deliberate — the renderer
// runs with no CSP and also displays agent-authored markdown, so a token in
// this heap would be one injection away from being exfiltrated.
//
// See src-tauri/src/auth for the state machine and src-tauri/src/commands/auth
// for the adapters.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** No credential stored. */
export interface SignedOut {
  status: "signed-out";
}

/** A device grant is in flight, awaiting approval in the browser. */
export interface Connecting {
  status: "connecting";
  /** Shown only behind the "enter the code manually" disclosure. */
  userCode: string;
  /** The plain approval URL, for that same manual fallback. */
  verificationUri: string;
  /** ISO-8601; the dialog stops offering a dead code past this. */
  expiresAt: string;
}

/** A credential is held. ATL-47 adds the user identity here. */
export interface SignedIn {
  status: "signed-in";
}

export type AuthSnapshot = SignedOut | Connecting | SignedIn;

export const auth = {
  /** Current state, for hydrating on mount. */
  snapshot: () => invoke<AuthSnapshot>("auth_snapshot"),
  /**
   * Begin or resume sign-in. Opens the approval page in the system browser and
   * polls in the background; resolves as soon as the grant starts, not when it
   * completes. Calling it again while one is in flight resumes the same grant
   * and reopens the browser rather than minting a competing code.
   */
  signIn: () => invoke<AuthSnapshot>("auth_sign_in"),
  /** Abandon an in-flight grant. Idempotent. */
  cancelSignIn: () => invoke<AuthSnapshot>("auth_cancel_sign_in"),
};

/** Every auth transition, broadcast to every window. */
export const listenAuthChanged = (
  handler: (snapshot: AuthSnapshot) => void,
): Promise<UnlistenFn> =>
  listen<AuthSnapshot>("atlas:auth-changed", (e) => handler(e.payload));

/** A grant that ended without a token (denied, expired, unreachable). */
export const listenAuthError = (
  handler: (e: { message: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ message: string }>("atlas:auth-error", (e) => handler(e.payload));
