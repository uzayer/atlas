import { useEffect, useState } from "react";

/**
 * True while the native window is in macOS fullscreen. In fullscreen the
 * traffic-light controls are hidden, so chrome that normally dodges them
 * (e.g. the workspace sidebar's top-bar buttons) can reclaim the left edge.
 */
export function useFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        setFullscreen(await win.isFullscreen());
        unlisten = await win.onResized(async () => {
          setFullscreen(await win.isFullscreen());
        });
      } catch {
        // not in a Tauri context
      }
    })();
    return () => unlisten?.();
  }, []);
  return fullscreen;
}
