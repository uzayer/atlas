import { create } from "zustand";
import { createSelectors } from "@/lib/create-selectors";
import { logEvent } from "@/features/log/lib/log";
import { scheduleAppStateSave } from "@/features/project/stores/project-store";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import type { Organisation } from "../types";
import { slugify } from "../types";

const uuid = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `org-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Whether `name` (case-insensitive, trimmed) is already used by an org other
 *  than `exceptId`. Enforces GitHub-style globally-unique org names. */
function nameTaken(
  name: string,
  orgs: Organisation[],
  exceptId?: string,
): boolean {
  const norm = name.trim().toLowerCase();
  return orgs.some((o) => o.id !== exceptId && o.name.trim().toLowerCase() === norm);
}

/** Make `slug` unique within the current local org set (append -2, -3, …).
 *  The server enforces global slug uniqueness; the auth branch reconciles on
 *  link. This only prevents local collisions. */
function uniqueSlug(base: string, orgs: Organisation[]): string {
  const taken = new Set(orgs.map((o) => o.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

interface OrgState {
  /** All organisations known to this window. */
  organisations: Organisation[];
  /** The single active org (mirrors the one-active-workspace invariant). */
  activeOrganisationId: string | null;
  /** True while an org switch is tearing down + reloading; gates the full-app
   *  "Loading Organisation…" overlay. Driven by `lib/org-switch.ts`. */
  orgSwitching: boolean;
  actions: {
    /** One-shot hydration from Rust `AppState` on boot. */
    hydrate: (payload: {
      organisations: Organisation[];
      activeOrganisationId: string | null;
    }) => void;
    /** Create a new local org (unsynced). Returns its id, or `null` if an org
     *  with that name already exists (case-insensitive; GitHub-style). Does
     *  NOT switch. */
    createOrg: (name: string) => string | null;
    /** Rename an org. Returns `false` (no-op) if the name is blank or already
     *  taken by ANOTHER org (case-insensitive), so no two orgs collide. */
    rename: (id: string, name: string) => boolean;
    setColor: (id: string, color: string | null) => void;
    /** Remove an org. Refuses if it's the last org or still owns workspaces
     *  (the caller must reassign/close those first). Returns whether removed. */
    deleteOrg: (id: string) => boolean;
    /** Record the per-org last-active workspace (restore target on switch). */
    setActiveWorkspaceForOrg: (orgId: string, workspaceId: string | null) => void;
    /** Low-level setter used by the org-switch orchestration + overlay gate. */
    setSwitching: (v: boolean) => void;
    /** Set the active org id (authoritative swap; called by org-switch). */
    setActiveOrganisation: (id: string) => void;

    // --- Auth-branch seams (stubbed in phase 01) --------------------------
    /** Opt into cloud sync for an org (Chrome-profile model). Stub: the auth
     *  branch runs the device grant + org link + sets `syncEnabled/remoteId`. */
    enableSync: (id: string) => void;
    /** Invite a member. Stub until auth ships. */
    inviteMember: (orgId: string, email: string, role: string) => void;
  };
}

export const useOrgStore = createSelectors(
  create<OrgState>()((set, get) => ({
    organisations: [],
    activeOrganisationId: null,
    orgSwitching: false,
    actions: {
      hydrate: (payload) => {
        set({
          organisations: payload.organisations ?? [],
          activeOrganisationId: payload.activeOrganisationId ?? null,
        });
      },

      createOrg: (name) => {
        const trimmed = name.trim() || "New organisation";
        // GitHub-style: names are globally unique (case-insensitive).
        if (nameTaken(trimmed, get().organisations)) return null;
        const org: Organisation = {
          id: uuid(),
          name: trimmed,
          slug: uniqueSlug(slugify(trimmed), get().organisations),
          createdAt: new Date().toISOString(),
          syncEnabled: false,
        };
        set((s) => ({ organisations: [...s.organisations, org] }));
        scheduleAppStateSave();
        logEvent({
          source: "project",
          kind: "org-create",
          summary: org.name,
          payload: { orgId: org.id, slug: org.slug },
        });
        return org.id;
      },

      rename: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return false;
        // Reject if ANOTHER org already has this name (case-insensitive).
        if (nameTaken(trimmed, get().organisations, id)) return false;
        set((s) => ({
          organisations: s.organisations.map((o) =>
            o.id === id ? { ...o, name: trimmed } : o,
          ),
        }));
        scheduleAppStateSave();
        return true;
      },

      setColor: (id, color) => {
        set((s) => ({
          organisations: s.organisations.map((o) =>
            o.id === id ? { ...o, color: color ?? undefined } : o,
          ),
        }));
        scheduleAppStateSave();
      },

      deleteOrg: (id) => {
        const { organisations } = get();
        if (organisations.length <= 1) return false; // never delete the last org
        const ownsWorkspaces = useWorkspaceStore
          .getState()
          .workspaces.some((w) => w.orgId === id);
        if (ownsWorkspaces) return false; // caller must clear its projects first
        set((s) => ({
          organisations: s.organisations.filter((o) => o.id !== id),
        }));
        scheduleAppStateSave();
        return true;
      },

      setActiveWorkspaceForOrg: (orgId, workspaceId) => {
        set((s) => ({
          organisations: s.organisations.map((o) =>
            o.id === orgId
              ? { ...o, activeWorkspaceId: workspaceId ?? undefined }
              : o,
          ),
        }));
        // Persisted via the switch's flushAppStateSave / scheduleAppStateSave.
      },

      setSwitching: (v) => set({ orgSwitching: v }),

      setActiveOrganisation: (id) => set({ activeOrganisationId: id }),

      enableSync: (id) => {
        logEvent({
          source: "project",
          kind: "org-enable-sync",
          summary: "Sync requested (auth pending)",
          payload: { orgId: id, deferred: "auth-branch" },
        });
      },

      inviteMember: (orgId, email, role) => {
        logEvent({
          source: "project",
          kind: "org-invite-member",
          summary: "Invite requested (auth pending)",
          payload: { orgId, email, role, deferred: "auth-branch" },
        });
      },
    },
  })),
);

/** Convenience: the active `Organisation` record (or null). */
export function activeOrganisation(): Organisation | null {
  const { organisations, activeOrganisationId } = useOrgStore.getState();
  return organisations.find((o) => o.id === activeOrganisationId) ?? null;
}
