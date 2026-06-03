/** Split a line of text into path / non-path runs so block output can render
 *  file paths as ⌘-clickable spans. Mirrors the xterm link provider's regex. */
const PATH_RE = /[A-Za-z0-9._~@+\-/]*\/[A-Za-z0-9._~@+\-/]*(?::\d+(?::\d+)?)?/g;

export interface PathRun {
  text: string;
  isPath: boolean;
}

export function splitPaths(text: string): PathRun[] {
  const out: PathRun[] = [];
  let last = 0;
  PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PATH_RE.exec(text)) !== null) {
    const raw = m[0];
    // Skip empties and URL tails (`http://host` → the `//host` follows a `:`).
    if (raw.length < 2 || text[m.index - 1] === ":") continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), isPath: false });
    out.push({ text: raw, isPath: true });
    last = m.index + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), isPath: false });
  return out.length ? out : [{ text, isPath: false }];
}
