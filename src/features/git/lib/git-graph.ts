export interface RawCommit {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  email: string;
  date: string;
  parents: string[];
  refs: string[];
}

export interface RawRef {
  name: string;
  sha: string;
  kind: "branch" | "remote" | "tag" | string;
  is_current: boolean;
}

export interface RawRefs {
  head: string | null;
  head_ref: string | null;
  refs: RawRef[];
}

export interface RefBadge {
  name: string;
  kind: "branch" | "remote" | "tag";
  isCurrent: boolean;
}

export interface LaneSegment {
  fromLane: number;
  toLane: number;
  fromY: 0 | 0.5; // top (0) or middle (0.5) of the row
  toY: 0.5 | 1; // middle or bottom
  color: string;
}

export interface CommitRow {
  sha: string;
  shortSha: string;
  message: string;
  author: string;
  email: string;
  date: string;
  refs: RefBadge[];
  isHead: boolean;
  commitLane: number;
  commitColor: string;
  segments: LaneSegment[];
}

export interface BuiltGraph {
  rows: CommitRow[];
  laneCount: number;
}

export const LANE_WIDTH = 14;
export const ROW_HEIGHT = 28;
export const GRAPH_LEFT_PAD = 14;

export const LANE_COLORS = [
  "#60a5fa", // blue
  "#34d399", // emerald
  "#f59e0b", // amber
  "#a78bfa", // violet
  "#f472b6", // pink
  "#22d3ee", // cyan
  "#fb7185", // rose
  "#84cc16", // lime
  "#eab308", // yellow
  "#94a3b8", // slate
];

function parseRefName(raw: string): RefBadge | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("HEAD ->")) return null;
  if (trimmed === "HEAD") return null;
  if (trimmed.startsWith("tag:")) {
    return { name: trimmed.slice(4).trim(), kind: "tag", isCurrent: false };
  }
  if (trimmed.includes("/")) {
    return { name: trimmed, kind: "remote", isCurrent: false };
  }
  return { name: trimmed, kind: "branch", isCurrent: false };
}

/**
 * Assigns lanes to a topologically ordered list of commits and produces per-row
 * drawing instructions (small line segments through each row). Pure function.
 */
export function buildGraph(commits: RawCommit[], refsInfo: RawRefs): BuiltGraph {
  // lanes[L] = sha of the commit each lane is currently waiting for (i.e. the
  // next commit it'll connect to as we scan downward). null means free.
  const lanes: (string | null)[] = [];
  const laneColors: (string | null)[] = [];
  let colorCounter = 0;

  const allocateLane = (sha: string): number => {
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null) {
        lanes[i] = sha;
        laneColors[i] = LANE_COLORS[colorCounter++ % LANE_COLORS.length];
        return i;
      }
    }
    lanes.push(sha);
    laneColors.push(LANE_COLORS[colorCounter++ % LANE_COLORS.length]);
    return lanes.length - 1;
  };

  // Build a quick lookup so we can attach ref badges keyed by sha.
  const refsBySha = new Map<string, RawRef[]>();
  for (const r of refsInfo.refs) {
    const list = refsBySha.get(r.sha) ?? [];
    list.push(r);
    refsBySha.set(r.sha, list);
  }
  const headSha = refsInfo.head ?? "";

  // Track the highest lane index that any row actually paints. The internal
  // `lanes` array can grow longer than what's visible (deallocated slots
  // remain as null), so we want the *used* max, not `lanes.length`.
  let maxUsedLane = 0;
  const rows: CommitRow[] = [];

  for (const c of commits) {
    // Find any lanes already pointing to this commit (set by an earlier child).
    const incoming: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === c.hash) incoming.push(i);
    }

    let commitLane: number;
    if (incoming.length === 0) {
      // Brand-new tip — claim a free lane.
      commitLane = allocateLane(c.hash);
    } else {
      commitLane = incoming[0];
    }
    const commitColor =
      laneColors[commitLane] ??
      LANE_COLORS[colorCounter++ % LANE_COLORS.length];
    laneColors[commitLane] = commitColor;

    const segments: LaneSegment[] = [];

    // Top half: every lane that exists *before* we process this commit needs to
    // render from y=0 → y=0.5.
    for (let i = 0; i < lanes.length; i++) {
      const owner = lanes[i];
      if (owner === null) continue;
      const color = laneColors[i] ?? commitColor;
      if (owner === c.hash) {
        // It merges into the commit dot.
        segments.push({
          fromLane: i,
          toLane: commitLane,
          fromY: 0,
          toY: 0.5,
          color,
        });
      } else {
        // It passes straight through.
        segments.push({
          fromLane: i,
          toLane: i,
          fromY: 0,
          toY: 0.5,
          color,
        });
      }
    }

    // Clear "extra" incoming lanes — they're consumed by the commit.
    for (const i of incoming) {
      if (i !== commitLane) {
        lanes[i] = null;
        laneColors[i] = null;
      }
    }

    // Assign parents now to update the post-commit state.
    if (c.parents.length === 0) {
      // Root commit — the lane ends here.
      lanes[commitLane] = null;
      laneColors[commitLane] = null;
    } else {
      // First parent inherits the commit's lane (mainline).
      const first = c.parents[0];
      const firstExisting = lanes.indexOf(first);
      if (firstExisting === -1) {
        lanes[commitLane] = first;
        // color persists
      } else if (firstExisting === commitLane) {
        // Already there — nothing to do.
      } else {
        // First parent already lives in another lane — our lane joins that one.
        segments.push({
          fromLane: commitLane,
          toLane: firstExisting,
          fromY: 0.5,
          toY: 1,
          color: laneColors[firstExisting] ?? commitColor,
        });
        lanes[commitLane] = null;
        laneColors[commitLane] = null;
      }

      // Remaining parents → fresh lanes (or existing if already known).
      for (let p = 1; p < c.parents.length; p++) {
        const parent = c.parents[p];
        let parentLane = lanes.indexOf(parent);
        if (parentLane === -1) {
          parentLane = allocateLane(parent);
        }
        segments.push({
          fromLane: commitLane,
          toLane: parentLane,
          fromY: 0.5,
          toY: 1,
          color: laneColors[parentLane] ?? commitColor,
        });
      }
    }

    // Bottom half: draw every active lane's lower half (top half rendered above).
    for (let i = 0; i < lanes.length; i++) {
      const owner = lanes[i];
      if (owner === null) continue;
      if (i === commitLane && segments.some((s) => s.fromLane === commitLane && s.fromY === 0.5)) {
        // The commit lane has an outgoing segment from middle to bottom already.
        continue;
      }
      segments.push({
        fromLane: i,
        toLane: i,
        fromY: 0.5,
        toY: 1,
        color: laneColors[i] ?? commitColor,
      });
    }

    // If the commit lane survived AND has no outgoing segment from mid to bottom
    // yet (i.e. first parent stayed put), draw the straight middle→bottom.
    if (
      lanes[commitLane] !== null &&
      !segments.some(
        (s) => s.fromLane === commitLane && s.fromY === 0.5 && s.toLane === commitLane
      )
    ) {
      segments.push({
        fromLane: commitLane,
        toLane: commitLane,
        fromY: 0.5,
        toY: 1,
        color: laneColors[commitLane] ?? commitColor,
      });
    }

    // Ref badges (from for-each-ref + git log --decorate fallback).
    const badges: RefBadge[] = (refsBySha.get(c.hash) ?? [])
      .map((r) => ({
        name: r.name,
        kind: (r.kind as RefBadge["kind"]) ?? "branch",
        isCurrent: r.is_current,
      }))
      .concat(
        c.refs
          .map(parseRefName)
          .filter((b): b is RefBadge => Boolean(b))
          .map((b) =>
            refsInfo.head_ref === b.name ? { ...b, isCurrent: true } : b
          )
      )
      .filter(
        (b, idx, all) =>
          all.findIndex((x) => x.name === b.name && x.kind === b.kind) === idx
      );

    rows.push({
      sha: c.hash,
      shortSha: c.short_hash,
      message: c.message,
      author: c.author,
      email: c.email,
      date: c.date,
      refs: badges,
      isHead: c.hash === headSha,
      commitLane,
      commitColor,
      segments,
    });

    // Update visible max from this row's actual drawing extents.
    let rowMax = commitLane;
    for (const s of segments) {
      if (s.fromLane > rowMax) rowMax = s.fromLane;
      if (s.toLane > rowMax) rowMax = s.toLane;
    }
    if (rowMax > maxUsedLane) maxUsedLane = rowMax;
  }

  return { rows, laneCount: maxUsedLane + 1 };
}
