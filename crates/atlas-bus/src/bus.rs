//! The global event broadcaster.

use tokio::sync::broadcast;

/// Default channel capacity. A turn that reads many files can emit dozens of
/// events per frame; 1024 gives slow subscribers ample slack before they lag.
const DEFAULT_CAPACITY: usize = 1024;

/// A cloneable fan-out channel for agent events.
///
/// `publish` never blocks and never fails on "no receivers" — a lagging or
/// absent subscriber simply misses events (observable as `RecvError::Lagged`
/// on the receiver), so the producing hot path is never held up by a slow
/// consumer. This is the seam the plan calls "Event Bus (global, cloud-ready)":
/// the Tauri UI fan-out subscribes today; a cloud streamer can subscribe later
/// with no change to producers.
pub struct EventBus<E: Clone + Send + 'static> {
    tx: broadcast::Sender<E>,
}

impl<E: Clone + Send + 'static> EventBus<E> {
    /// Create a bus with the default capacity.
    pub fn new() -> Self {
        Self::with_capacity(DEFAULT_CAPACITY)
    }

    /// Create a bus with an explicit ring-buffer capacity.
    pub fn with_capacity(capacity: usize) -> Self {
        let (tx, _rx) = broadcast::channel(capacity);
        Self { tx }
    }

    /// Publish an event to all current subscribers. Returns the number of
    /// subscribers it reached (0 if none) — never errors.
    pub fn publish(&self, event: E) -> usize {
        self.tx.send(event).unwrap_or(0)
    }

    /// Subscribe a new receiver. Only events published *after* this call are
    /// delivered to it.
    pub fn subscribe(&self) -> broadcast::Receiver<E> {
        self.tx.subscribe()
    }

    /// Current subscriber count.
    pub fn receiver_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

impl<E: Clone + Send + 'static> Clone for EventBus<E> {
    fn clone(&self) -> Self {
        Self {
            tx: self.tx.clone(),
        }
    }
}

impl<E: Clone + Send + 'static> Default for EventBus<E> {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn delivers_to_all_subscribers() {
        let bus: EventBus<u32> = EventBus::new();
        let mut a = bus.subscribe();
        let mut b = bus.subscribe();
        assert_eq!(bus.publish(7), 2);
        assert_eq!(a.recv().await.unwrap(), 7);
        assert_eq!(b.recv().await.unwrap(), 7);
    }

    #[tokio::test]
    async fn publish_with_no_subscribers_is_ok() {
        let bus: EventBus<u32> = EventBus::new();
        // No receivers → 0 reached, no panic, no error.
        assert_eq!(bus.publish(1), 0);
    }

    #[tokio::test]
    async fn only_events_after_subscribe_are_seen() {
        let bus: EventBus<u32> = EventBus::new();
        bus.publish(1); // dropped — no subscribers yet
        let mut rx = bus.subscribe();
        bus.publish(2);
        assert_eq!(rx.recv().await.unwrap(), 2);
    }
}
