/**
 * Minimal ANSI (SGR) → styled-segment renderer for static, completed-command
 * block output. Handles the SGR subset that ordinary CLI
 * output uses: reset, bold/dim/italic/underline/inverse, and 16 / 256 /
 * truecolor foreground+background. Cursor-movement / erase / alt-screen
 * sequences are STRIPPED here — anything interactive runs in xterm instead, so
 * a static block never contains them.
 *
 * Returns an array of `{ text, style }` runs that React renders as <span>s — no
 * dangerouslySetInnerHTML.
 */
import type { CSSProperties } from "react";

export interface AnsiSegment {
  text: string;
  style?: CSSProperties;
}

// Standard 16-color palette (xterm-ish, tuned to read on the black terminal bg).
const PALETTE_16 = [
  "#1a1a1a", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#cccccc",
  "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff",
];

function color256(n: number): string {
  if (n < 16) return PALETTE_16[n];
  if (n >= 232) {
    const v = 8 + (n - 232) * 10; // grayscale ramp
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const r = Math.floor(i / 36);
  const g = Math.floor((i % 36) / 6);
  const b = i % 6;
  const c = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${c(r)},${c(g)},${c(b)})`;
}

interface SgrState {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

function styleOf(s: SgrState): CSSProperties | undefined {
  const fg = s.inverse ? s.bg : s.fg;
  const bg = s.inverse ? s.fg : s.bg;
  const style: CSSProperties = {};
  if (fg) style.color = fg;
  if (bg) style.background = bg;
  if (s.bold) style.fontWeight = 600;
  if (s.dim) style.opacity = 0.6;
  if (s.italic) style.fontStyle = "italic";
  if (s.underline) style.textDecoration = "underline";
  return Object.keys(style).length ? style : undefined;
}

function applySgr(state: SgrState, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) {
      state.fg = state.bg = undefined;
      state.bold = state.dim = state.italic = state.underline = state.inverse = false;
    } else if (p === 1) state.bold = true;
    else if (p === 2) state.dim = true;
    else if (p === 3) state.italic = true;
    else if (p === 4) state.underline = true;
    else if (p === 7) state.inverse = true;
    else if (p === 22) state.bold = state.dim = false;
    else if (p === 23) state.italic = false;
    else if (p === 24) state.underline = false;
    else if (p === 27) state.inverse = false;
    else if (p >= 30 && p <= 37) state.fg = PALETTE_16[p - 30];
    else if (p >= 90 && p <= 97) state.fg = PALETTE_16[p - 90 + 8];
    else if (p >= 40 && p <= 47) state.bg = PALETTE_16[p - 40];
    else if (p >= 100 && p <= 107) state.bg = PALETTE_16[p - 100 + 8];
    else if (p === 39) state.fg = undefined;
    else if (p === 49) state.bg = undefined;
    else if (p === 38 || p === 48) {
      const isFg = p === 38;
      const mode = params[i + 1];
      if (mode === 5) {
        const col = color256(params[i + 2] ?? 0);
        if (isFg) state.fg = col;
        else state.bg = col;
        i += 2;
      } else if (mode === 2) {
        const col = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`;
        if (isFg) state.fg = col;
        else state.bg = col;
        i += 4;
      }
    }
  }
}

const ESC = 0x1b;

/** Convert a string containing ANSI/SGR escapes into styled text runs. */
export function ansiToSegments(input: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  const state: SgrState = {};
  let buf = "";

  const flush = () => {
    if (buf) {
      segments.push({ text: buf, style: styleOf(state) });
      buf = "";
    }
  };

  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input.charCodeAt(i);
    if (ch === ESC && input[i + 1] === "[") {
      // CSI — read params up to the final byte.
      let j = i + 2;
      while (j < n && !/[@-~]/.test(input[j])) j++;
      const final = input[j];
      const body = input.slice(i + 2, j);
      if (final === "m") {
        flush();
        const params = body.split(";").map((x) => (x === "" ? 0 : parseInt(x, 10)));
        applySgr(state, params.length ? params : [0]);
      }
      // Any other CSI (cursor/erase) is dropped — static output only.
      i = j + 1;
      continue;
    }
    if (ch === ESC && (input[i + 1] === "]" || input[i + 1] === ")" || input[i + 1] === "(")) {
      // OSC or charset designation — skip to terminator (BEL or ST).
      let j = i + 2;
      while (j < n && input.charCodeAt(j) !== 0x07 && !(input.charCodeAt(j) === ESC && input[j + 1] === "\\")) j++;
      i = input.charCodeAt(j) === ESC ? j + 2 : j + 1;
      continue;
    }
    if (ch === ESC) {
      i += 2; // unknown 2-byte escape
      continue;
    }
    if (ch === 0x0d) {
      // CR — drop (we keep \n only; CRLF → LF).
      i++;
      continue;
    }
    if (ch === 0x07 || ch === 0x08) {
      i++; // bell / backspace — ignore in static output
      continue;
    }
    buf += input[i];
    i++;
  }
  flush();
  return segments;
}
