/**
 * Single entry point for "open this file as a tab". Classifies the file by
 * extension and routes to the editor, media viewer, or unsupported view —
 * use this anywhere a file path needs to become a tab (Cmd+P palette,
 * explorer tree click, drag-and-drop, etc.) so the routing logic stays in
 * one place.
 */

import { useLayoutStore } from "@/features/layout/stores/layout-store";
import { classifyFile, type FileKind } from "@/lib/file-types";

export function openFile(path: string): void {
  const kind = classifyFile(path);
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

function tabTypeFor(kind: FileKind): "editor" | "media" | "pdf" | "unsupported" {
  if (kind === "text") return "editor";
  if (kind === "image" || kind === "video" || kind === "audio") return "media";
  if (kind === "pdf") return "pdf";
  return "unsupported";
}
