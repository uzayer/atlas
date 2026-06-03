import type { Terminal, ILink, ILinkProvider } from "@xterm/xterm";
import { invoke } from "@tauri-apps/api/core";
import { openFile } from "@/lib/open-file";

/**
 * xterm link provider that makes file paths in terminal output ⌘-clickable
 * (VS Code behavior): ⌘-hover underlines, ⌘-click opens the file. Path
 * resolution (strip `:line:col`, expand `~`, join the shell's live cwd for
 * relative paths, verify existence) happens in Rust (`terminal_resolve_path`),
 * so this only detects candidate tokens and routes activations.
 */

// Path-ish run containing at least one `/`, made of safe path chars, with an
// optional `:line[:col]` suffix. Colons are excluded from the body so URLs
// (`http://…`) don't match as paths (guarded again by the `:` look-behind).
const PATH_RE = /[A-Za-z0-9._~@+\-/]*\/[A-Za-z0-9._~@+\-/]*(?::\d+(?::\d+)?)?/g;

// ⌘/Ctrl-held state, shared across all terminals; drives the hover underline.
let metaHeld = false;
let hoveredLink: ILink | null = null;
let listenersInstalled = false;

function decor() {
  return { pointerCursor: metaHeld, underline: metaHeld };
}
function refreshHoverDecor() {
  // `ILink.decorations` is live-tracked by xterm, so mutating it updates the
  // rendered underline immediately as ⌘ is pressed/released while hovering.
  if (hoveredLink) hoveredLink.decorations = decor();
}
function installModListeners() {
  if (listenersInstalled) return;
  listenersInstalled = true;
  const onMod = (e: KeyboardEvent) => {
    const held = e.metaKey || e.ctrlKey;
    if (held !== metaHeld) {
      metaHeld = held;
      refreshHoverDecor();
    }
  };
  window.addEventListener("keydown", onMod, true);
  window.addEventListener("keyup", onMod, true);
  // Clear if focus leaves (so a stuck ⌘ doesn't leave links underlined).
  window.addEventListener("blur", () => {
    if (metaHeld) {
      metaHeld = false;
      refreshHoverDecor();
    }
  });
}

export function createPathLinkProvider(term: Terminal, terminalId: string): ILinkProvider {
  installModListeners();
  return {
    provideLinks(lineNo, callback) {
      const line = term.buffer.active.getLine(lineNo - 1);
      if (!line) {
        callback(undefined);
        return;
      }
      const text = line.translateToString(true);
      const links: ILink[] = [];
      PATH_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = PATH_RE.exec(text)) !== null) {
        const raw = m[0];
        // Skip empties / URL tails (`http://host` → the `//host` part follows a `:`).
        if (raw.length < 2 || text[m.index - 1] === ":") continue;
        const startX = m.index;
        const endX = m.index + raw.length;
        links.push({
          text: raw,
          range: {
            start: { x: startX + 1, y: lineNo },
            end: { x: endX, y: lineNo },
          },
          decorations: decor(),
          activate: (event) => {
            // Require ⌘ (mac) / Ctrl (win/linux) so normal clicks/selection work.
            if (!(event.metaKey || event.ctrlKey)) return;
            void invoke<string | null>("terminal_resolve_path", {
              id: terminalId,
              raw,
            })
              .then((abs) => {
                if (abs) openFile(abs);
              })
              .catch(() => {});
          },
          hover: (_e, _t) => {
            hoveredLink = links.find((l) => l.text === raw) ?? null;
            refreshHoverDecor();
          },
          leave: () => {
            hoveredLink = null;
          },
        });
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}
