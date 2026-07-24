//! Tauri adapters over [`crate::auth::AuthCore`].
//!
//! Thin by design: translate arguments, spawn the poll task, emit events. Every
//! decision worth testing lives in `crate::auth`, which is why there are no
//! tests here — this layer holds no logic of its own.
//!
//! Events emitted to the frontend:
//!   `atlas:auth-changed`    — the full [`AuthSnapshot`], on every transition
//!   `atlas:auth-error`      — `{ message }` when a grant ends without a token
//!   `atlas:auth-signed-out` — `{ message }` when the server ended the session
//!
//! All go out via `app.emit`, which broadcasts to **every** window, so a
//! multi-window install always agrees about who is signed in.
//!
//! `auth-error` and `auth-signed-out` are separate because they are read in
//! different places: a grant failure belongs inside the connect dialog the user
//! is already looking at, while a revoked session arrives with nothing on
//! screen and has to reach them as a toast.

use std::sync::Arc;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::auth::{
    auth_base, AuthCore, AuthSnapshot, CreatedOrg, GrantError, OrgInvitation, OrgMember, Role,
    Validation,
};
use crate::telemetry::TelemetryClient;

/// Shown when the server rejects the stored credential. Deliberately says what
/// happened and what to do about it: a title bar that silently reverts to a
/// signed-out icon reads as a bug.
const SESSION_ENDED: &str = "Your Atlas session ended. Sign in again to reconnect.";

/// Managed handle to the auth core.
pub struct AuthState {
    core: Arc<AuthCore>,
}

impl AuthState {
    pub fn new(config_dir: std::path::PathBuf) -> Self {
        Self {
            core: Arc::new(AuthCore::new(
                auth_base(),
                config_dir,
                reqwest::Client::new(),
            )),
        }
    }

    pub fn core(&self) -> Arc<AuthCore> {
        Arc::clone(&self.core)
    }
}

fn broadcast(app: &AppHandle, snapshot: AuthSnapshot) {
    let _ = app.emit("atlas:auth-changed", snapshot);
}

/// The anonymous account events (ATL-52). Both are no-ops unless the user has
/// already opted into telemetry, and neither carries a user id, email, or
/// Organisation id — see [`TelemetryClient::capture_signed_in`] for why the
/// payload is defined there rather than here.
fn telemetry(app: &AppHandle) -> Arc<TelemetryClient> {
    Arc::clone(&app.state::<Arc<TelemetryClient>>())
}

/// Current account state. Carries no credential — see [`AuthSnapshot`].
#[tauri::command]
pub fn auth_snapshot(state: State<'_, AuthState>) -> AuthSnapshot {
    state.core().snapshot()
}

/// Begin (or resume) sign-in.
///
/// Opens the approval page in the system browser and polls in the background.
/// Returns immediately with the `connecting` snapshot so the dialog can render
/// while the human is still in the browser.
#[tauri::command]
pub async fn auth_sign_in(
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<AuthSnapshot, String> {
    let core = state.core();

    let grant = core
        .start_grant()
        .await
        .map_err(|e| e.user_message())?;

    // Never a URL built here — it comes off the wire, so the desktop stays
    // ignorant of the web app's routing. *Which* of the two the server sent is
    // a security decision, so it is `approval_url`'s to make and not this
    // layer's: see the note there before changing it.
    let _ = app
        .opener()
        .open_url(grant.approval_url().to_string(), None::<&str>);

    let snapshot = core.snapshot();
    broadcast(&app, snapshot.clone());

    // Poll off the command so the frontend is not blocked for up to 10 minutes.
    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        match core.run_grant(&grant).await {
            Ok(()) => {
                broadcast(&task_app, core.snapshot());
                raise(&task_app);
                telemetry(&task_app).capture_signed_in();
            }
            // Cancellation is a deliberate user action; it needs no error toast.
            Err(GrantError::Cancelled) => broadcast(&task_app, core.snapshot()),
            Err(err) => {
                broadcast(&task_app, core.snapshot());
                let _ = task_app.emit(
                    "atlas:auth-error",
                    serde_json::json!({ "message": err.user_message() }),
                );
            }
        }
    });

    Ok(snapshot)
}

/// Abandon an in-flight grant. Idempotent.
#[tauri::command]
pub fn auth_cancel_sign_in(app: AppHandle, state: State<'_, AuthState>) -> AuthSnapshot {
    let core = state.core();
    core.cancel_grant();
    let snapshot = core.snapshot();
    broadcast(&app, snapshot.clone());
    snapshot
}

/// Sign out (ATL-50).
///
/// Local state is gone and the signed-out snapshot has been broadcast to every
/// window **before** the server is contacted at all, so the UI flips with no
/// spinner and no wait — and sign-out works with the network off, which is when
/// it matters most.
///
/// Resolves to `true` when the server confirmed the session is revoked. The
/// caller is already signed out either way; the value only decides whether they
/// are told the server session may outlive the local one. It is returned rather
/// than emitted because, unlike everything else here, it answers *this* window's
/// click — broadcasting it would put the same caveat in front of two other
/// windows that did nothing.
#[tauri::command]
pub async fn auth_sign_out(app: AppHandle, state: State<'_, AuthState>) -> Result<bool, String> {
    let core = state.core();
    let ticket = core.sign_out();
    broadcast(&app, core.snapshot());

    Ok(match ticket {
        Some(ticket) => {
            // Recorded on the local sign-out, not the revocation: the user has
            // signed out either way, and whether the server could be reached is
            // not what this event counts.
            telemetry(&app).capture_signed_out();
            core.revoke(ticket).await
        }
        // Nothing was stored, so there is nothing the server could still be
        // holding — no caveat is owed, and nothing happened worth recording.
        None => true,
    })
}

/// Create an organisation server-side and hand back its id (ATL-36).
///
/// The "Turn on sync" action: the frontend keeps the org local and calls this to
/// link it, writing the returned `id` onto the local org as its `remoteId`. On
/// success the refreshed snapshot (now listing the new org) is broadcast to every
/// window; the returned id is what *this* window links against without waiting
/// for that event.
///
/// Carries no token out — only the server id and name (see [`CreatedOrg`]).
/// A failure is surfaced as a user-facing string; only a real 401 inside
/// `create_org` clears the credential, and it does so through the same single
/// path everything else does — never here.
#[tauri::command]
pub async fn auth_create_org(
    name: String,
    slug: String,
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<CreatedOrg, String> {
    let core = state.core();
    let created = core
        .create_org(&name, &slug)
        .await
        .map_err(|e| e.user_message())?;
    broadcast(&app, core.snapshot());
    Ok(created)
}

/// Is an organisation handle free? — the create-form typeahead probe (§6.2).
///
/// Advisory only: a `true` here can still lose a race against another create,
/// so the caller must still handle [`auth_create_org`] failing. A taken slug is
/// a plain `false`, not an error — only a real failure (no session, rate limit,
/// unreachable) rejects, carrying the same user-facing string as everything
/// else. Broadcasts nothing: this reads, it does not change state.
#[tauri::command]
pub async fn auth_check_org_slug(
    slug: String,
    state: State<'_, AuthState>,
) -> Result<bool, String> {
    state
        .core()
        .check_slug(&slug)
        .await
        .map_err(|e| e.user_message())
}

/// Force a server re-pull of the account's organisations and broadcast the
/// refreshed snapshot — the manual "refresh" affordance behind the org list.
///
/// Silent about failure like the launch-path refresh it reuses: a flaky pull
/// leaves the last-known list in place rather than emptying the menu, and never
/// touches the credential.
#[tauri::command]
pub async fn auth_refresh(
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<AuthSnapshot, String> {
    let core = state.core();
    core.refresh().await;
    let snapshot = core.snapshot();
    broadcast(&app, snapshot.clone());
    Ok(snapshot)
}

/// Delete a synced organisation server-side (ATL-36).
///
/// Best-effort from the frontend's side: the local purge happens whether this
/// resolves or rejects (deleting is admin-only, so a member gets a 403 here yet
/// still wants the org gone locally). On success the refreshed snapshot — now
/// without the org — is broadcast so no window re-merges it.
#[tauri::command]
pub async fn auth_delete_org(
    remote_id: String,
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<(), String> {
    let core = state.core();
    core.delete_org(&remote_id)
        .await
        .map_err(|e| e.user_message())?;
    broadcast(&app, core.snapshot());
    Ok(())
}

// ── Organisation members (ATL-36) ───────────────────────────────────────────
//
// `Denied` collapses 403 and 400, and its default message names the org-CREATE
// case ("that name or handle may already be taken"), which would be nonsense
// here — so every member command supplies its own wording via
// `user_message_denied`. As everywhere in this module, only a real 401 inside
// `AuthCore` clears the credential; nothing below ever touches it.

/// The org's members. Read-only: no `AppHandle`, and it broadcasts nothing.
#[tauri::command]
pub async fn auth_list_members(
    org_id: String,
    state: State<'_, AuthState>,
) -> Result<Vec<OrgMember>, String> {
    state
        .core()
        .list_members(&org_id)
        .await
        .map_err(|e| e.user_message_denied("You don't have access to this organisation's members."))
}

/// Pending + past invitations. Admin-scoped server-side, so a non-admin's call
/// comes back `Denied` and the caller shows an empty tab. Read-only.
#[tauri::command]
pub async fn auth_list_invitations(
    org_id: String,
    state: State<'_, AuthState>,
) -> Result<Vec<OrgInvitation>, String> {
    state
        .core()
        .list_invitations(&org_id)
        .await
        .map_err(|e| e.user_message_denied("Only an admin can see this organisation's invites."))
}

/// Invite someone by email. The returned `acceptUrl` is the whole point —
/// email delivery is deferred, so that link is the only way the invitee hears
/// about it. Changes server state only; the snapshot holds no members, so
/// there is nothing to broadcast.
#[tauri::command]
pub async fn auth_invite_member(
    org_id: String,
    email: String,
    role: Role,
    state: State<'_, AuthState>,
) -> Result<OrgInvitation, String> {
    state
        .core()
        .invite_member(&org_id, &email, role)
        .await
        .map_err(|e| {
            e.user_message_denied(
                "Couldn't invite them — you may not be an admin, or they're already in.",
            )
        })
}

/// Revoke a pending invitation. Broadcasts nothing (see above).
#[tauri::command]
pub async fn auth_cancel_invitation(
    invitation_id: String,
    state: State<'_, AuthState>,
) -> Result<(), String> {
    state
        .core()
        .cancel_invitation(&invitation_id)
        .await
        .map_err(|e| e.user_message_denied("Only an admin can cancel an invite."))
}

/// Change a member's role. Takes effect in their NEXT minted token — tokens
/// already issued stay valid until they expire. Broadcasts nothing.
#[tauri::command]
pub async fn auth_update_member_role(
    org_id: String,
    member_id: String,
    role: Role,
    state: State<'_, AuthState>,
) -> Result<(), String> {
    state
        .core()
        .update_member_role(&org_id, &member_id, role)
        .await
        .map_err(|e| e.user_message_denied("Only an admin can change a member's role."))
}

/// Remove a member. **This one does broadcast**: it is the only member op that
/// can change the caller's own org set (you may be removing yourself), and
/// `remove_member` re-pulls the identity, so the account menu would otherwise
/// keep listing an org the user just left.
#[tauri::command]
pub async fn auth_remove_member(
    org_id: String,
    member_id_or_email: String,
    app: AppHandle,
    state: State<'_, AuthState>,
) -> Result<(), String> {
    let core = state.core();
    core.remove_member(&org_id, &member_id_or_email)
        .await
        .map_err(|e| e.user_message_denied("Only an admin can remove a member."))?;
    broadcast(&app, core.snapshot());
    Ok(())
}

/// Bring Atlas forward once approval lands, so the human does not have to hunt
/// for the window they left behind in the browser.
fn raise(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Render the stored credential immediately, then validate it in the
/// background for as long as it takes (ATL-48).
///
/// The first broadcast is the whole offline story: a launch with no network
/// shows a complete signed-in title bar — name and photo — from the stored
/// snapshot, rather than waiting on a call that is going to time out.
///
/// The validation behind it runs unbounded, so a machine that boots offline
/// reconnects on its own. Only a 401 ends it in a sign-out, and only then does
/// the user hear about it.
pub fn restore_on_launch(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let core = app.state::<AuthState>().core();
        broadcast(&app, core.snapshot());

        let settled = {
            let app = app.clone();
            core.revalidate(move |snapshot| broadcast(&app, snapshot)).await
        };

        if settled == Validation::Rejected {
            let _ = app.emit(
                "atlas:auth-signed-out",
                serde_json::json!({ "message": SESSION_ENDED }),
            );
        }
    });
}
