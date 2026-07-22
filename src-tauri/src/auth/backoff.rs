//! The retry schedule for the INDETERMINATE class (ATL-48).
//!
//! Only failures that told us *nothing* about the credential come here. A 401
//! is answered by signing out and a 403 by doing nothing at all; neither ever
//! reaches this module. See [`crate::auth::AuthFailure`] for the split.
//!
//! The schedule is exponential from one second to a five-minute ceiling, with
//! jitter, and **no attempt limit**: a laptop closed on a plane and opened six
//! hours later must come back signed in on its own, without the user
//! restarting Atlas or redoing the device grant. An attempt cap would turn that
//! into a silent dead end that looks exactly like being signed out.
//!
//! The ceiling is also what keeps the retry path clear of the auth worker's
//! global rate limit — 100 requests per 60-second window across every
//! `/api/auth/*` path, keyed by IP, so an office behind one NAT shares the
//! budget. At the ceiling this loop costs 12 requests an hour. Anyone
//! shortening the ceiling should re-check it against that number.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Delay before the first retry.
pub(crate) const BASE: Duration = Duration::from_secs(1);

/// Longest we will ever wait between attempts.
pub(crate) const CEILING: Duration = Duration::from_secs(300);

/// Where doubling stops mattering. `BASE << 32` is already centuries, so this
/// only exists to keep the shift from overflowing.
const MAX_SHIFT: u32 = 32;

/// An exponential schedule with jitter, bounded above.
pub(crate) struct Backoff {
    base: Duration,
    ceiling: Duration,
    attempt: u32,
}

impl Backoff {
    pub(crate) fn new(base: Duration, ceiling: Duration) -> Self {
        Self {
            base,
            ceiling,
            attempt: 0,
        }
    }

    /// The un-jittered delay for the current attempt.
    fn cap(&self) -> Duration {
        let doubled = self
            .base
            .checked_mul(1u32.checked_shl(self.attempt.min(MAX_SHIFT)).unwrap_or(u32::MAX))
            .unwrap_or(self.ceiling);
        doubled.min(self.ceiling)
    }

    /// Consume one attempt and return how long to wait.
    ///
    /// The delay is drawn from `[cap/2, cap]` rather than the more common
    /// `[0, cap]`. Full jitter can put the tenth retry a millisecond after the
    /// ninth, which throws away the backoff exactly when the server is least
    /// able to absorb it; half jitter still de-synchronises a fleet of clients
    /// that all lost connectivity at the same moment, which is the point.
    pub(crate) fn next(&mut self) -> Duration {
        let cap = self.cap();
        self.attempt = self.attempt.saturating_add(1);
        let half = cap / 2;
        half + half.mul_f64(fraction())
    }

    /// The delay before the next attempt, letting the server overrule it.
    ///
    /// A `Retry-After` is honoured but **clamped into the same window**. It is
    /// a number from the network: taken verbatim, a `0` spins this loop against
    /// a server already asking for quiet, and an `86400` strands a signed-in
    /// user for a day over one bad header. The attempt still advances either
    /// way, so a server that answers every request with `Retry-After: 0` cannot
    /// hold the schedule at its floor.
    pub(crate) fn next_after(&mut self, retry_after: Option<Duration>) -> Duration {
        let jittered = self.next();
        match retry_after {
            Some(asked) => asked.clamp(self.base, self.ceiling),
            None => jittered,
        }
    }
}

/// A fraction in `[0, 1)` from the sub-second part of the clock.
///
/// Deliberately not a PRNG dependency: this only has to stop simultaneous
/// clients from retrying in lockstep, and nothing about it is security
/// relevant — the value is a sleep duration, never a token or a nonce.
fn fraction() -> f64 {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    f64::from(nanos) / 1_000_000_000.0
}
