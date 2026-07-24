//! Fetching and caching the profile photo.
//!
//! The photo is fetched **once**, when the remote URL first appears or changes,
//! and read from disk on every launch after that. The point is not speed: the
//! provider URL points at Google or GitHub, and re-fetching on every launch
//! would hand one of them a beacon carrying the user's IP and a rough activity
//! log, for a picture we already have. That is the opposite of what a
//! local-first app should do, and it would also blank the title bar on a plane.
//!
//! The claim is precisely "never for a photo we already have", not "never".
//! When there is no cached file — a first sign-in, or a photo that has failed
//! to download so far — every launch does try again, unbounded. That is the
//! deliberate side of the trade: caching a *failure* would mean one CDN outage
//! during sign-in costs the user their photo until they next change it. The
//! request only recurs while we have nothing to show, and a launch already
//! talks to the Atlas auth server twice regardless.
//!
//! The remote URL is therefore the cache key, and it never crosses to the
//! frontend — an `<img src>` pointed at the provider would reinstate exactly
//! the per-launch request this module exists to avoid. The frontend gets a
//! local path.
//!
//! Every failure here is non-fatal by construction: the caller gets `None` and
//! renders initials. A photo is never worth blocking or failing a sign-in for.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};

/// Enough for any provider avatar (GitHub's largest is well under 1 MB) and
/// small enough that a hostile or misconfigured host cannot fill the disk.
const MAX_BYTES: usize = 2 * 1024 * 1024;

/// The whole fetch, bounded. A photo is decoration; it does not get to hold
/// sign-in open, and this is the entire budget including connect and TLS.
const TIMEOUT: Duration = Duration::from_secs(5);

/// What we are willing to write into a directory the asset protocol serves.
///
/// SVG is deliberately absent. `<img>` does not execute script in an SVG, so
/// this is not load-bearing, but there is no provider that needs it and no
/// reason to be the first app to find out otherwise.
fn extension_for(content_type: &str) -> Option<&'static str> {
    let base = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    match base.as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        _ => None,
    }
}

/// Cache file for a given remote URL.
///
/// The URL is hashed into the name so that a changed photo lands at a *changed
/// path*. That matters beyond tidiness: the webview caches by URL, so reusing
/// one filename would leave a stale face on screen until a restart.
fn cache_path(dir: &Path, url: &str, ext: &str) -> PathBuf {
    let digest = Sha256::digest(url.as_bytes());
    let short: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    dir.join(format!("avatar-{short}.{ext}"))
}

/// A photo we hold, as the remote URL it came from and where it landed.
///
/// The two travel together because neither means anything alone: the URL is the
/// cache key and the path is the payload, and it is the *pair* that has to be
/// written back or left alone atomically. Splitting them is what makes it
/// possible to record a new URL against an old file — a state that reads as
/// "cached" and never re-fetches.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct CachedAvatar {
    pub url: Option<String>,
    pub path: Option<String>,
}

impl CachedAvatar {
    pub(crate) fn new(url: Option<String>, path: Option<String>) -> Self {
        Self { url, path }
    }

    /// The cached file, if it is actually still on disk. A user or a cleanup
    /// tool can delete it behind our back, and a path to nothing would render
    /// as a broken image.
    fn existing_path(&self) -> Option<&str> {
        self.path.as_deref().filter(|p| Path::new(p).exists())
    }
}

/// The photo to hold for `url`, fetching it only if we do not already have it.
///
/// Returns the pair to persist. There is no error case: a photo is decoration,
/// and no failure here has a decision the user could make about it. What varies
/// is *which* pair comes back —
///
/// - no URL: nothing, and the old file is deleted. The user cleared their photo
///   and we should not keep a face they removed.
/// - URL unchanged and the file is there: `previous`, untouched, no request.
/// - fetched: the new pair, and the superseded file is deleted.
/// - **fetch failed: `previous`, untouched, and nothing is deleted.** We learned
///   nothing about the new photo, so a five-second blip must not cost the
///   known-good one — that file is the whole reason an offline launch renders a
///   face. Leaving the *old URL* recorded is what makes the next launch see a
///   mismatch and try again, instead of filing the new URL against an old file
///   and never re-fetching.
pub(crate) async fn resolve(
    http: &reqwest::Client,
    dir: &Path,
    url: Option<&str>,
    previous: &CachedAvatar,
) -> CachedAvatar {
    let Some(url) = url else {
        prune(previous.path.as_deref(), None);
        return CachedAvatar::default();
    };

    if previous.url.as_deref() == Some(url) {
        if let Some(path) = previous.existing_path() {
            return CachedAvatar::new(Some(url.to_string()), Some(path.to_string()));
        }
    }

    let Some(fetched) = fetch(http, dir, url).await else {
        // Keep what we have, minus any path that has gone missing — recording a
        // path to nothing would just defer the failure to the `<img>`.
        return CachedAvatar::new(
            previous.url.clone(),
            previous.existing_path().map(str::to_string),
        );
    };

    prune(previous.path.as_deref(), Some(&fetched));
    CachedAvatar::new(Some(url.to_string()), Some(fetched))
}

/// Download and write, or `None`.
async fn fetch(http: &reqwest::Client, dir: &Path, url: &str) -> Option<String> {
    let mut res = http.get(url).timeout(TIMEOUT).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }

    let ext = extension_for(res.headers().get(reqwest::header::CONTENT_TYPE)?.to_str().ok()?)?;

    // A declared length over the cap saves us downloading it to find out. It is
    // only a hint — absent or dishonest lengths are caught by the loop below.
    if res.content_length().is_some_and(|n| n > MAX_BYTES as u64) {
        return None;
    }

    let mut bytes: Vec<u8> = Vec::new();
    loop {
        match res.chunk().await {
            Ok(Some(chunk)) => {
                if bytes.len() + chunk.len() > MAX_BYTES {
                    return None;
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            // A truncated body would be written as a half image, which renders
            // as the broken-image glyph — worse than initials.
            Err(_) => return None,
        }
    }

    if bytes.is_empty() {
        return None;
    }

    std::fs::create_dir_all(dir).ok()?;
    let path = cache_path(dir, url, ext);
    std::fs::write(&path, &bytes).ok()?;
    Some(path.to_string_lossy().into_owned())
}

/// Every extension [`extension_for`] can produce. Used to find an already-cached
/// file for a URL without a directory scan: the name is a pure function of the
/// URL plus one of these four.
const EXTENSIONS: [&str; 4] = ["png", "jpg", "webp", "gif"];

/// The cached file for `url` if we already hold it — four `stat`s, no request.
fn cached_for(dir: &Path, url: &str) -> Option<String> {
    EXTENSIONS.iter().find_map(|ext| {
        let path = cache_path(dir, url, ext);
        path.exists().then(|| path.to_string_lossy().into_owned())
    })
}

/// A photo for someone who is **not** the signed-in user — an organisation
/// member — as a local path.
///
/// Separate from [`resolve`] because the bookkeeping is different: there is no
/// per-member `CachedAvatar` persisted anywhere, so the cache key is the file's
/// own existence. The URL hash makes that sound — a changed photo is a changed
/// URL is a different filename — and it means a members list that is opened
/// twice costs four `stat`s per person the second time, not a request.
///
/// Nothing is ever pruned here. A member's old file is not ours to reason
/// about: the same photo may back a row in another org, and the signed-in
/// user's own avatar lives in this directory under the same scheme.
pub(crate) async fn resolve_member(
    http: &reqwest::Client,
    dir: &Path,
    url: Option<&str>,
) -> Option<String> {
    let url = url?;
    if let Some(path) = cached_for(dir, url) {
        return Some(path);
    }
    fetch(http, dir, url).await
}

/// Drop a cached photo we are done with — sign-out, where the face on disk
/// outlives the credential unless something deletes it.
pub(crate) fn discard(path: Option<&str>) {
    prune(path, None);
}

/// Remove a superseded cache file. Best-effort, and never removes the file we
/// just wrote (a URL that hashes to the same name is the same photo).
fn prune(old: Option<&str>, keep: Option<&str>) {
    if let Some(old) = old {
        if Some(old) != keep {
            let _ = std::fs::remove_file(old);
        }
    }
}
