import { invoke } from "@tauri-apps/api/core";
import type {
  InstalledPack,
  Pack,
  PackInstallResult,
  PackProjectReport,
  PackProjectionView,
  PackSearchHit,
  Scope,
} from "./types";

/**
 * Packs on-disk bridge. The pack store (`<root>/.atlas/packs/<repo>/`), the
 * lockfile, and every projection are owned Rust-side (`commands/skills.rs`,
 * Phases 2–3). The frontend only searches, previews, installs, lists, and
 * projects through these wrappers. Disk *is* the state — mutations refetch.
 *
 * `projectPath` is required for `scope: "project"` and ignored for
 * `scope: "global"`; we pass it through whenever present.
 */
export const packs = {
  // ── Discovery ──────────────────────────────────────────────────────────

  /** Search the skills.sh registry (discovery only — no content fetched). */
  search: (query: string) => invoke<PackSearchHit[]>("pack_search", { query }),

  /** Clone a source repo and parse it WITHOUT installing (install preview). */
  remotePreview: (source: string) =>
    invoke<Pack>("pack_remote_preview", { source }),

  /** Inspect an already-on-disk pack directory. */
  inspect: (dir: string) => invoke<Pack>("pack_inspect", { dir }),

  // ── Install / list ─────────────────────────────────────────────────────

  /**
   * Install a pack from its GitHub source into the store. Fetches the whole
   * repo, dedups against the lock, writes `skills-lock.json`. No projection
   * and no script execution. `force` overrides a non-managed-dir conflict.
   */
  install: (
    scope: Scope,
    source: string,
    force = false,
    projectPath?: string | null,
  ) =>
    invoke<PackInstallResult>("pack_install_remote", {
      scope,
      source,
      force,
      projectPath: projectPath ?? null,
    }),

  /** Installed packs in this scope (manifest + provenance). */
  list: (scope: Scope, projectPath?: string | null) =>
    invoke<InstalledPack[]>("pack_list", {
      scope,
      projectPath: projectPath ?? null,
    }),

  // ── Projection ─────────────────────────────────────────────────────────

  /**
   * Project an installed pack's components into a tool (optionally filtered to
   * specific kinds). Returns a per-component report. `force` overrides the
   * non-destructive foreign-entry guard.
   */
  project: (
    scope: Scope,
    pack: string,
    tool: string,
    kinds?: string[] | null,
    force = false,
    projectPath?: string | null,
  ) =>
    invoke<PackProjectReport[]>("pack_project", {
      scope,
      pack,
      tool,
      kinds: kinds ?? null,
      force,
      projectPath: projectPath ?? null,
    }),

  /** Undo every projection of a pack into a tool. */
  unproject: (
    scope: Scope,
    pack: string,
    tool: string,
    projectPath?: string | null,
  ) =>
    invoke<void>("pack_unproject", {
      scope,
      pack,
      tool,
      projectPath: projectPath ?? null,
    }),

  /** Read-only projection ledger view for one pack (across tools). */
  projections: (scope: Scope, pack: string, projectPath?: string | null) =>
    invoke<PackProjectionView[]>("pack_projections", {
      scope,
      pack,
      projectPath: projectPath ?? null,
    }),
};
