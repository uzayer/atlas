/**
 * Single entry point for "open this file as a tab". Classifies the file by
 * extension and routes to the editor, media viewer, or unsupported view —
 * use this anywhere a file path needs to become a tab (Cmd+P palette,
 * explorer tree click, drag-and-drop, etc.) so the routing logic stays in
 * one place.
 */

import { invoke } from "@tauri-apps/api/core";
import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { classifyFile, type FileKind } from "@/lib/file-types";

export async function openFile(path: string): Promise<void> {
  let kind = classifyFile(path);
  // Extension-based classification is an allowlist, so files with unrecognized
  // names fall through to "unsupported". Before giving up, sniff the bytes: if
  // they're UTF-8/ASCII text, open in the editor anyway. This is the only async
  // branch — known kinds resolve synchronously above, so the tab still opens in
  // the same tick for them.
  if (kind === "unsupported") {
    try {
      if (await invoke<boolean>("is_text_file", { path })) kind = "text";
    } catch {
      /* keep "unsupported" if the sniff fails */
    }
  }
  const tabType = tabTypeFor(kind);
  const title = path.split("/").pop() ?? path;
  // `id` is stable per path + tabType so reopening the same file restores
  // its existing tab instead of stacking duplicates.
  const id = `${tabType}:${path}`;
  useLayoutStore.getState().actions.addTab({
    id,
    type: tabType,
    title,
    closable: true,
    dirty: false,
    data: { filePath: path, fileKind: kind },
  });
}

function tabTypeFor(kind: FileKind): "editor" | "media" | "svg" | "pdf" | "unsupported" {
  if (kind === "text") return "editor";
  if (kind === "image" || kind === "video" || kind === "audio") return "media";
  if (kind === "svg") return "svg";
  if (kind === "pdf") return "pdf";
  return "unsupported";
}
