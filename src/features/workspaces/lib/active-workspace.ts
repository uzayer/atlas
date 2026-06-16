import { useWorkspaceStore } from "../stores/workspace-store";

/**
 * The id of the currently-active workspace, or `null` if none is open.
 *
 * This is the key that replaced `webview.label()` for all per-workspace Rust
 * state (file index, git watcher, mention cache, recent files). Every IPC call
 * that targets workspace-scoped state should thread this through as
 * `workspaceId` so the right workspace's resident state is hit — multiple
 * workspaces now share a single window/webview label.
 */
export function activeWorkspaceId(): string | null {
  return useWorkspaceStore.getState().activeWorkspaceId;
}
