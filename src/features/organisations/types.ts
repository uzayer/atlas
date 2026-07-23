/**
 * Organisation data model. Local-only in phase 01, but shaped as a superset of
 * the Atlas server contracts (`packages/db` `organization`/`member`/`invitation`
 * + Better Auth) so cloud sync (a separate auth branch) is a thin adapter.
 *
 * Mirrors `src-tauri/src/state/app_state.rs:Organisation`.
 */

/** Org member roles, highest privilege first. Matches the server `Role` enum
 *  (`@atlas/contracts`). Unused in phase 01 (no members locally) — present so
 *  the member-management UI + the auth branch share one type. */
export type Role = "admin" | "product_owner" | "developer" | "member";

/**
 * A top-level tenant that owns a set of workspaces. Exactly one org is active
 * per window. Local-only until the user opts into sync per org.
 *
 * Server-mapped fields: `id` (sync key), `name`, `slug` (unique + required),
 * `logo`. Local-only fields: `activeWorkspaceId`, `syncEnabled`, `color`, and
 * `remoteId` (the server `organization.id` once linked).
 */
export interface Organisation {
  id: string;
  name: string;
  /** URL-safe unique handle; derived from `name` at create time. */
  slug: string;
  color?: string;
  logo?: string;
  /** ISO-8601 creation timestamp. */
  createdAt?: string;
  /** Per-org memory of the last active workspace (restore target on switch).
   *  Local-only — the server has no active-workspace concept. */
  activeWorkspaceId?: string;
  /** Opt-in cloud sync (Chrome-profile model). `false` = local-only. */
  syncEnabled: boolean;
  /** Server `organization.id` once linked via "Turn on sync". Reconciliation
   *  seam for the auth branch. */
  remoteId?: string;
}

/**
 * Org member. Mirrors the server `member` row + `get-full-organization`
 * response. Unused in phase 01 — shaped for the auth branch to populate.
 */
export interface Member {
  id: string;
  organizationId: string;
  userId: string;
  role: Role;
  createdAt?: string;
  user?: { id: string; name: string; email: string; image?: string };
}

/**
 * Pending/past org invitation. Mirrors the server `invitation` row. Unused in
 * phase 01 — shaped for the auth branch.
 */
export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role?: Role;
  status?: string;
  expiresAt?: string;
  createdAt?: string;
  inviterId?: string;
}

/**
 * Derive a URL-safe, server-compatible slug from an org name. The server
 * enforces a globally-unique slug; we generate one locally and (in phase 01)
 * disambiguate against the current local org set — the auth branch reconciles
 * against the server on link.
 */
export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "org";
}
