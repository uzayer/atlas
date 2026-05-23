//! `git_graph_build` — the entire git-graph layout algorithm.
//!
//! Previously lived in `src/features/git/lib/git-graph.ts` as ~300
//! lines of TS that ran on every git signature change (per the
//! "business logic in Rust" rule, JS shouldn't be allocating lane
//! arrays + computing per-row segments for thousands of commits).
//! Now: one Tauri command runs `git log` + `git for-each-ref` in
//! parallel, lays out the graph, returns the row list. Frontend just
//! renders.
//!
//! Pure port of the original JS algorithm — same lane assignment, same
//! segment shape, same color palette — so the React component reads
//! the wire format unchanged.

use serde::Serialize;

use super::git::{git_log_compute, git_refs_compute, GitLogEntry, GitRefs};

const LANE_COLORS: [&str; 10] = [
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefBadge {
    pub name: String,
    pub kind: String,
    pub is_current: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneSegment {
    pub from_lane: usize,
    pub to_lane: usize,
    /// 0.0 = top, 0.5 = middle, 1.0 = bottom.
    pub from_y: f32,
    pub to_y: f32,
    pub color: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRow {
    pub sha: String,
    pub short_sha: String,
    pub message: String,
    pub author: String,
    pub email: String,
    pub date: String,
    pub refs: Vec<RefBadge>,
    pub is_head: bool,
    pub commit_lane: usize,
    pub commit_color: String,
    pub segments: Vec<LaneSegment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltGraph {
    pub rows: Vec<CommitRow>,
    pub lane_count: usize,
}

#[tauri::command]
pub async fn git_graph_build(
    path: String,
    limit: Option<u32>,
    all: Option<bool>,
) -> Result<BuiltGraph, String> {
    let lim = limit.unwrap_or(1000);
    let all_flag = all.unwrap_or(true);
    let path_for_log = path.clone();
    let path_for_refs = path.clone();

    // Two `git` invocations in parallel on the blocking pool. Both
    // are independent reads; serializing them would add a needless
    // ~50ms on warm caches.
    let (log_result, refs_result) = tokio::join!(
        tokio::task::spawn_blocking(move || git_log_compute(&path_for_log, lim, all_flag)),
        tokio::task::spawn_blocking(move || git_refs_compute(&path_for_refs)),
    );
    let commits = log_result.map_err(|e| e.to_string())??;
    let refs_info = refs_result.map_err(|e| e.to_string())??;

    Ok(build_graph(commits, refs_info))
}

/// Port of `buildGraph` from `src/features/git/lib/git-graph.ts`.
/// Pure function — keep semantics identical so the React view code
/// keeps working unchanged.
fn build_graph(commits: Vec<GitLogEntry>, refs_info: GitRefs) -> BuiltGraph {
    // `lanes[L]` = sha each lane is currently waiting for (i.e. the
    // next commit it'll connect to as we scan downward). `None` is a
    // free slot. `lane_colors[L]` mirrors the same indexing.
    let mut lanes: Vec<Option<String>> = Vec::new();
    let mut lane_colors: Vec<Option<&'static str>> = Vec::new();
    let mut color_counter: usize = 0;

    // Build a lookup so we can attach ref badges keyed by sha.
    let mut refs_by_sha: std::collections::HashMap<&str, Vec<&super::git::GitRef>> =
        std::collections::HashMap::new();
    for r in &refs_info.refs {
        refs_by_sha.entry(r.sha.as_str()).or_default().push(r);
    }
    let head_sha = refs_info.head.as_deref().unwrap_or("");

    let mut max_used_lane: usize = 0;
    let mut rows: Vec<CommitRow> = Vec::with_capacity(commits.len());

    for c in &commits {
        // Find any lanes already pointing to this commit.
        let mut incoming: Vec<usize> = Vec::new();
        for (i, owner) in lanes.iter().enumerate() {
            if owner.as_deref() == Some(c.hash.as_str()) {
                incoming.push(i);
            }
        }

        let commit_lane: usize = if incoming.is_empty() {
            allocate_lane(&mut lanes, &mut lane_colors, &mut color_counter, &c.hash)
        } else {
            incoming[0]
        };
        let commit_color = lane_colors
            .get(commit_lane)
            .and_then(|c| *c)
            .unwrap_or_else(|| {
                let col = LANE_COLORS[color_counter % LANE_COLORS.len()];
                color_counter += 1;
                col
            });
        if let Some(slot) = lane_colors.get_mut(commit_lane) {
            *slot = Some(commit_color);
        }

        let mut segments: Vec<LaneSegment> = Vec::new();

        // Top half: every active lane renders from y=0 → y=0.5.
        for (i, owner) in lanes.iter().enumerate() {
            let Some(owner) = owner.as_deref() else { continue };
            let color = lane_colors
                .get(i)
                .and_then(|c| *c)
                .unwrap_or(commit_color);
            if owner == c.hash {
                segments.push(LaneSegment {
                    from_lane: i,
                    to_lane: commit_lane,
                    from_y: 0.0,
                    to_y: 0.5,
                    color: color.to_string(),
                });
            } else {
                segments.push(LaneSegment {
                    from_lane: i,
                    to_lane: i,
                    from_y: 0.0,
                    to_y: 0.5,
                    color: color.to_string(),
                });
            }
        }

        // Clear extra incoming lanes — they're consumed by the commit.
        for i in &incoming {
            if *i != commit_lane {
                lanes[*i] = None;
                lane_colors[*i] = None;
            }
        }

        // Post-commit lane state from parents.
        if c.parents.is_empty() {
            lanes[commit_lane] = None;
            lane_colors[commit_lane] = None;
        } else {
            let first = &c.parents[0];
            let first_existing = lanes
                .iter()
                .position(|l| l.as_deref() == Some(first.as_str()));
            match first_existing {
                None => {
                    lanes[commit_lane] = Some(first.clone());
                }
                Some(idx) if idx == commit_lane => {
                    // already there
                }
                Some(idx) => {
                    let color = lane_colors
                        .get(idx)
                        .and_then(|c| *c)
                        .unwrap_or(commit_color);
                    segments.push(LaneSegment {
                        from_lane: commit_lane,
                        to_lane: idx,
                        from_y: 0.5,
                        to_y: 1.0,
                        color: color.to_string(),
                    });
                    lanes[commit_lane] = None;
                    lane_colors[commit_lane] = None;
                }
            }

            for parent in c.parents.iter().skip(1) {
                let parent_lane = match lanes
                    .iter()
                    .position(|l| l.as_deref() == Some(parent.as_str()))
                {
                    Some(idx) => idx,
                    None => allocate_lane(
                        &mut lanes,
                        &mut lane_colors,
                        &mut color_counter,
                        parent,
                    ),
                };
                let color = lane_colors
                    .get(parent_lane)
                    .and_then(|c| *c)
                    .unwrap_or(commit_color);
                segments.push(LaneSegment {
                    from_lane: commit_lane,
                    to_lane: parent_lane,
                    from_y: 0.5,
                    to_y: 1.0,
                    color: color.to_string(),
                });
            }
        }

        // Bottom half: every still-active lane needs its lower half.
        for (i, owner) in lanes.iter().enumerate() {
            if owner.is_none() {
                continue;
            }
            // Skip if the commit lane already has an outgoing 0.5→1
            // segment (a join into a different lane).
            if i == commit_lane
                && segments
                    .iter()
                    .any(|s| s.from_lane == commit_lane && (s.from_y - 0.5).abs() < f32::EPSILON)
            {
                continue;
            }
            let color = lane_colors
                .get(i)
                .and_then(|c| *c)
                .unwrap_or(commit_color);
            segments.push(LaneSegment {
                from_lane: i,
                to_lane: i,
                from_y: 0.5,
                to_y: 1.0,
                color: color.to_string(),
            });
        }

        // If commit lane survived AND no straight middle→bottom yet,
        // draw it (first-parent stays on the same lane).
        if lanes.get(commit_lane).and_then(|l| l.as_ref()).is_some()
            && !segments.iter().any(|s| {
                s.from_lane == commit_lane
                    && s.to_lane == commit_lane
                    && (s.from_y - 0.5).abs() < f32::EPSILON
            })
        {
            let color = lane_colors
                .get(commit_lane)
                .and_then(|c| *c)
                .unwrap_or(commit_color);
            segments.push(LaneSegment {
                from_lane: commit_lane,
                to_lane: commit_lane,
                from_y: 0.5,
                to_y: 1.0,
                color: color.to_string(),
            });
        }

        // Ref badges (for-each-ref output + git log --decorate fallback).
        let mut badges: Vec<RefBadge> = Vec::new();
        if let Some(list) = refs_by_sha.get(c.hash.as_str()) {
            for r in list {
                badges.push(RefBadge {
                    name: r.name.clone(),
                    kind: r.kind.clone(),
                    is_current: r.is_current,
                });
            }
        }
        for raw in &c.refs {
            if let Some(b) = parse_ref_name(raw) {
                let is_current = refs_info.head_ref.as_deref() == Some(&b.name);
                badges.push(RefBadge {
                    name: b.name,
                    kind: b.kind,
                    is_current: b.is_current || is_current,
                });
            }
        }
        // Dedupe by (name, kind) preserving order.
        let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
        badges.retain(|b| seen.insert((b.name.clone(), b.kind.clone())));

        // Track visible max from this row's drawing extents.
        let mut row_max = commit_lane;
        for s in &segments {
            if s.from_lane > row_max {
                row_max = s.from_lane;
            }
            if s.to_lane > row_max {
                row_max = s.to_lane;
            }
        }
        if row_max > max_used_lane {
            max_used_lane = row_max;
        }

        rows.push(CommitRow {
            sha: c.hash.clone(),
            short_sha: c.short_hash.clone(),
            message: c.message.clone(),
            author: c.author.clone(),
            email: c.email.clone(),
            date: c.date.clone(),
            refs: badges,
            is_head: c.hash == head_sha,
            commit_lane,
            commit_color: commit_color.to_string(),
            segments,
        });
    }

    BuiltGraph {
        rows,
        lane_count: max_used_lane + 1,
    }
}

fn allocate_lane(
    lanes: &mut Vec<Option<String>>,
    lane_colors: &mut Vec<Option<&'static str>>,
    color_counter: &mut usize,
    sha: &str,
) -> usize {
    for i in 0..lanes.len() {
        if lanes[i].is_none() {
            lanes[i] = Some(sha.to_string());
            lane_colors[i] = Some(LANE_COLORS[*color_counter % LANE_COLORS.len()]);
            *color_counter += 1;
            return i;
        }
    }
    lanes.push(Some(sha.to_string()));
    lane_colors.push(Some(LANE_COLORS[*color_counter % LANE_COLORS.len()]));
    *color_counter += 1;
    lanes.len() - 1
}

struct ParsedRef {
    name: String,
    kind: String,
    is_current: bool,
}

fn parse_ref_name(raw: &str) -> Option<ParsedRef> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with("HEAD ->") {
        return None;
    }
    if trimmed == "HEAD" {
        return None;
    }
    if let Some(rest) = trimmed.strip_prefix("tag:") {
        return Some(ParsedRef {
            name: rest.trim().to_string(),
            kind: "tag".to_string(),
            is_current: false,
        });
    }
    if trimmed.contains('/') {
        return Some(ParsedRef {
            name: trimmed.to_string(),
            kind: "remote".to_string(),
            is_current: false,
        });
    }
    Some(ParsedRef {
        name: trimmed.to_string(),
        kind: "branch".to_string(),
        is_current: false,
    })
}
