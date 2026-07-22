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

/** Who is signed in. Carries no credential — see the note at the top. */
export interface AccountUser {
  id: string;
  name: string;
  email: string;
  /**
   * Absolute path to the locally cached profile photo, or `null` when the user
   * has none or the fetch failed. Render it through `convertFileSrc`.
   *
   * Deliberately a local path rather than the provider URL: an `<img>` pointed
   * at Google or GitHub would tell them the user opened Atlas, every launch,
   * for a photo already on disk — and would leave the title bar blank offline.
   */
  avatarPath: string | null;
}

/** A credential is held. */
export interface SignedIn {
  status: "signed-in";
  /**
   * `null` only between holding a credential and the first successful profile
   * fetch — a network blip right after approval, or an upgrade from a build
   * that stored no identity. The next validation fills it in; until then the
   * button shows the generic icon rather than nothing.
   */
  user: AccountUser | null;
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
  /**
   * Sign out (ATL-50).
   *
   * Nothing here waits: Rust clears the credential, the identity snapshot and
   * the cached photo first and unconditionally, and the signed-out state
   * arrives over `atlas:auth-changed` before the server is contacted at all.
   *
   * Resolves — later, once the background revocation settles — to whether the
   * server confirmed the session is gone. `false` means this device is signed
   * out but the server session may stay active until it expires, which is the
   * one thing the user has to be told.
   */
  signOut: () => invoke<boolean>("auth_sign_out"),
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

/**
 * The server rejected the stored credential and Atlas signed out (ATL-48).
 *
 * Separate from `atlas:auth-error` because it is read somewhere else: a grant
 * failure belongs inside the connect dialog the user is already looking at,
 * while this one arrives unprompted — a session revoked from the web, or one
 * that finally expired — and has to reach them as a toast.
 *
 * Only ever fires on an authoritative rejection. Being offline, an Atlas
 * outage, or a rate limit never produces this: those preserve the credential
 * and retry silently, which is the entire point of the classification.
 */
export const listenAuthSignedOut = (
  handler: (e: { message: string }) => void,
): Promise<UnlistenFn> =>
  listen<{ message: string }>("atlas:auth-signed-out", (e) =>
    handler(e.payload),
  );
