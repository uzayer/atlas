//! Turn identity for race-free turn lifecycle.

use tokio::sync::watch;

/// Monotonic per-session turn counter. A new prompt bumps it; any event or
/// completion still carrying an older `TurnId` belongs to a superseded turn and
/// is dropped by the session actor (`is_same_turn`). This is what makes the
/// stream and the "turn finished" signal race-safe by construction, replacing
/// the old `activity_seq`/quiescence-poll heuristic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct TurnId(pub u64);

impl TurnId {
    /// The next turn identity. Wraps (a session never has 2^64 live turns).
    pub fn next(self) -> TurnId {
        TurnId(self.0.wrapping_add(1))
    }
}

/// The turn currently in flight for a session, held by the actor. Dropping /
/// replacing it (a new `Send`) supersedes the previous turn: its late events
/// fail `is_same_turn` and its cancel signal fires.
pub struct RunningTurn {
    pub id: TurnId,
    /// Fires `true` when this turn is cancelled or superseded. The spawned
    /// prompt task can watch it to abort early; the actor also calls the
    /// connection's `cancel` directly.
    cancel_tx: watch::Sender<bool>,
}

impl RunningTurn {
    pub fn new(id: TurnId) -> Self {
        let (cancel_tx, _rx) = watch::channel(false);
        Self { id, cancel_tx }
    }

    /// A receiver that flips to `true` when this turn is cancelled.
    pub fn cancel_signal(&self) -> watch::Receiver<bool> {
        self.cancel_tx.subscribe()
    }

    /// Mark this turn cancelled/superseded.
    pub fn cancel(&self) {
        let _ = self.cancel_tx.send(true);
    }

    pub fn is_cancelled(&self) -> bool {
        *self.cancel_tx.borrow()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_id_increments_monotonically() {
        let a = TurnId::default();
        let b = a.next();
        let c = b.next();
        assert_eq!(a, TurnId(0));
        assert_eq!(b, TurnId(1));
        assert_eq!(c, TurnId(2));
        assert!(a < b && b < c);
    }

    #[test]
    fn running_turn_cancel_flips_signal() {
        let rt = RunningTurn::new(TurnId(1));
        let rx = rt.cancel_signal();
        assert!(!*rx.borrow());
        assert!(!rt.is_cancelled());
        rt.cancel();
        assert!(*rx.borrow());
        assert!(rt.is_cancelled());
    }
}
