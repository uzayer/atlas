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

    /// Subscribe with lag accounting: a slow consumer that falls more than
    /// the ring capacity behind LOSES events (broadcast semantics — the
    /// producer must never block), but the loss is logged and counted
    /// instead of silent (L4). `name` identifies the consumer in logs.
    pub fn subscribe_counted(&self, name: &'static str) -> CountedReceiver<E> {
        CountedReceiver {
            rx: self.tx.subscribe(),
            name,
            dropped: 0,
        }
    }
}

/// A subscriber wrapper that surfaces lag drops. See
/// [`EventBus::subscribe_counted`].
pub struct CountedReceiver<E: Clone + Send + 'static> {
    rx: broadcast::Receiver<E>,
    name: &'static str,
    dropped: u64,
}

impl<E: Clone + Send + 'static> CountedReceiver<E> {
    /// Receive the next event. On lag, logs + counts the skipped events and
    /// continues with the next available one (never errors on lag).
    pub async fn recv(&mut self) -> Option<E> {
        loop {
            match self.rx.recv().await {
                Ok(e) => return Some(e),
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    self.dropped += n;
                    tracing::warn!(
                        target: "atlas_bus",
                        consumer = self.name,
                        skipped = n,
                        total_dropped = self.dropped,
                        "bus subscriber lagged; events were dropped"
                    );
                }
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    }

    /// Total events this subscriber has lost to lag.
    pub fn dropped(&self) -> u64 {
        self.dropped
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
    async fn counted_receiver_logs_and_counts_lag_drops() {
        let bus: EventBus<u32> = EventBus::with_capacity(4);
        let mut rx = bus.subscribe_counted("test");
        // Overflow the ring: 10 events into capacity 4 → the oldest are lost.
        for i in 0..10 {
            bus.publish(i);
        }
        // First recv reports the lag (counted), then yields the oldest
        // retained event; everything still flows afterwards.
        let first = rx.recv().await.unwrap();
        assert!(first >= 6, "oldest retained after overflow, got {first}");
        assert!(rx.dropped() >= 6, "lag must be counted, got {}", rx.dropped());
        drop(bus);
        // Channel closed → None (not an error loop).
        while rx.recv().await.is_some() {}
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
