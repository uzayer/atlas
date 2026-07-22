import { logEvent } from "@/features/log/lib/log";
import { flushAll } from "@/features/workspaces/lib/flush-registry";
import { useWorkspaceStore } from "@/features/workspaces/stores/workspace-store";
import {
  useProjectStore,
  flushAppStateSave,
  scheduleAppStateSave,
} from "@/features/project/stores/project-store";
import { useOrgStore } from "../stores/org-store";

/** Minimum time the "Loading Organisation…" overlay stays up, so a fast switch
 *  doesn't flash it. */
const MIN_OVERLAY_MS = 450;

/** Guards re-entrant org switches while a teardown/reload is in flight. */
let switchingOrg = false;

/**
 * Switch the active Organisation. Tears down the OUTGOING org's entire mounted
 * workspace set (RAM freed, Rust watchers stopped), then brings the INCOMING
 * org's last-active (or most-recent) workspace online — the same cold-load path
 * as boot hydration — behind a full-app "Loading Organisation…" overlay.
 *
 * Mirrors the workspace `switchTo` contract: the active workspace is flushed
 * (awaited) before teardown so no unsaved KB/editor state is stranded.
 */
export async function switchOrg(id: string): Promise<void> {
  const orgActions = useOrgStore.getState().actions;
  const { activeOrganisationId, organisations } = useOrgStore.getState();

  if (id === activeOrganisationId) return;
  if (switchingOrg) return; // coalesce: ignore rapid double-clicks
  const target = organisations.find((o) => o.id === id);
  if (!target) return;

  switchingOrg = true;
  orgActions.setSwitching(true);
  const startedAt = Date.now();

  try {
    const wsActions = useWorkspaceStore.getState().actions;
    const projectActions = useProjectStore.getState().actions;
    const outgoingActiveWs =
      useWorkspaceStore.getState().activeWorkspaceId;
    const outgoingPath =
      useProjectStore.getState().currentProject?.path ?? null;

    // 1) Remember the outgoing org's active workspace so switching back
    //    restores the user where they left off.
    if (activeOrganisationId) {
      orgActions.setActiveWorkspaceForOrg(activeOrganisationId, outgoingActiveWs);
    }

    // 2) Flush the active workspace's unsaved state (KB buffer, editor tabs)
    //    BEFORE teardown — awaited, exactly like `switchTo`. Then persist the
    //    workspace list + org active-ws pointers to disk.
    if (outgoingActiveWs) {
      await flushAll({ workspaceId: outgoingActiveWs, path: outgoingPath });
    }
    await flushAppStateSave();

    // 3) Tear down the whole outgoing hot set + clear the active workspace.
    //    Setting the project to null fires the App-level Rust lifecycle
    //    effects' null-branch (file index / git watch / recent files / mention
    //    cache all close), stopping the old org's watchers.
    wsActions.teardownForOrgSwitch();
    projectActions.setActiveProject(null);

    // 4) Make the org swap authoritative.
    orgActions.setActiveOrganisation(id);

    // 5) Resolve the incoming org's target workspace and bring it online via
    //    the normal cold-load path. `switchTo` runs `loadProjectStores` + the
    //    App Rust-lifecycle effects for the new active workspace.
    const targetWsId = resolveTargetWorkspace(id, target.activeWorkspaceId);
    if (targetWsId) {
      await wsActions.switchTo(targetWsId);
    } else {
      // Empty org → Welcome screen (project already null).
      projectActions.setActiveProject(null);
    }

    scheduleAppStateSave();
    logEvent({
      source: "project",
      kind: "org-switch",
      summary: target.name,
      payload: { orgId: id, workspaceId: targetWsId ?? null },
    });
  } finally {
    // Keep the overlay up for a minimum time so it never flashes.
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(0, MIN_OVERLAY_MS - elapsed);
    setTimeout(() => {
      orgActions.setSwitching(false);
      switchingOrg = false;
    }, remaining);
  }
}

/**
 * Pick the workspace to open when entering an org: its remembered
 * `activeWorkspaceId` if it still exists, else the most-recently-active
 * workspace in that org, else none (empty org).
 */
function resolveTargetWorkspace(
  orgId: string,
  savedActiveWs: string | undefined,
): string | null {
  const { workspaces } = useWorkspaceStore.getState();
  const inOrg = workspaces.filter((w) => w.orgId === orgId);
  if (savedActiveWs && inOrg.some((w) => w.id === savedActiveWs)) {
    return savedActiveWs;
  }
  const mostRecent = [...inOrg].sort((a, b) =>
    (b.lastActiveAt ?? "").localeCompare(a.lastActiveAt ?? ""),
  )[0];
  return mostRecent?.id ?? null;
}
