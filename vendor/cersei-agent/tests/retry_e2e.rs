//! ATLAS PATCH tests (retry-classified-v1): the runner's classified retry
//! loop, driven end-to-end through `run_stream` with a scripted mock provider.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use cersei_agent::Agent;
use cersei_agent::events::AgentEvent;
use cersei_provider::{CompletionRequest, CompletionStream, Provider, ProviderCapabilities};
use cersei_types::{Message, Result as CerseiResult, StopReason, StreamEvent};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

/// Provider that replays scripted per-call event sequences. When the script
/// runs out, the LAST entry repeats (so an "always 429" mock is one entry).
struct MockProvider {
    script: Mutex<Vec<Vec<StreamEvent>>>,
    calls: AtomicUsize,
}

impl MockProvider {
    fn new(script: Vec<Vec<StreamEvent>>) -> Self {
        Self {
            script: Mutex::new(script),
            calls: AtomicUsize::new(0),
        }
    }
}

#[async_trait]
impl Provider for MockProvider {
    fn name(&self) -> &str {
        "mock"
    }
    fn context_window(&self, _model: &str) -> u64 {
        200_000
    }
    fn capabilities(&self, _model: &str) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            tool_use: true,
            system_prompt: true,
            ..Default::default()
        }
    }
    async fn complete(&self, _request: CompletionRequest) -> CerseiResult<CompletionStream> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let events = {
            let mut script = self.script.lock();
            if script.len() > 1 {
                script.remove(0)
            } else {
                script[0].clone()
            }
        };
        let (tx, rx) = tokio::sync::mpsc::channel(64);
        tokio::spawn(async move {
            for ev in events {
                let _ = tx.send(ev).await;
            }
        });
        Ok(CompletionStream::new(rx))
    }
}

fn rate_limited() -> Vec<StreamEvent> {
    vec![StreamEvent::Error {
        message: "HTTP 429: {\"error\":{\"type\":\"rate_limit_error\"}}".into(),
    }]
}

fn success(text: &str) -> Vec<StreamEvent> {
    vec![
        StreamEvent::MessageStart {
            id: "m1".into(),
            model: "mock-model".into(),
        },
        StreamEvent::ContentBlockStart {
            index: 0,
            block_type: "text".into(),
            id: None,
            name: None,
        },
        StreamEvent::TextDelta {
            index: 0,
            text: text.into(),
        },
        StreamEvent::ContentBlockStop { index: 0 },
        StreamEvent::MessageDelta {
            stop_reason: Some(StopReason::EndTurn),
            usage: None,
        },
        StreamEvent::MessageStop,
    ]
}

fn build_agent(provider: MockProvider, seed: Vec<Message>, token: CancellationToken) -> Arc<Agent> {
    Arc::new(
        Agent::builder()
            .provider_boxed(Box::new(provider))
            .tools(Vec::new())
            .with_messages(seed)
            .cancel_token(token)
            .model("mock-model".to_string())
            .max_turns(5)
            .build()
            .expect("build mock agent"),
    )
}

/// Drain the stream, collecting every event until Complete/Error.
async fn drain(agent: &Arc<Agent>, prompt: &str) -> Vec<AgentEvent> {
    let mut stream = agent.run_stream(prompt);
    let mut events = Vec::new();
    while let Some(ev) = stream.next().await {
        let terminal = matches!(ev, AgentEvent::Complete(_) | AgentEvent::Error(_));
        events.push(ev);
        if terminal {
            break;
        }
    }
    events
}

#[tokio::test(start_paused = true)]
async fn transient_429_retries_then_succeeds_with_history_intact() {
    let seed = vec![
        Message::user("earlier question"),
        Message::assistant("earlier answer"),
    ];
    let agent = build_agent(
        MockProvider::new(vec![rate_limited(), success("recovered")]),
        seed,
        CancellationToken::new(),
    );

    let events = drain(&agent, "follow-up").await;

    // One structured Retry with Zed's 429 schedule (5s exponential, max 4)…
    let retries: Vec<_> = events
        .iter()
        .filter_map(|e| match e {
            AgentEvent::Retry {
                attempt,
                max_attempts,
                delay_ms,
                ..
            } => Some((*attempt, *max_attempts, *delay_ms)),
            _ => None,
        })
        .collect();
    assert_eq!(retries, vec![(1, 4, 5_000)]);
    // …then the turn completes normally.
    assert!(
        events.iter().any(|e| matches!(e, AgentEvent::Complete(_))),
        "turn must succeed after the retry"
    );

    // Resume, not replay: the seed history survives exactly once, followed by
    // the new user prompt and the retried assistant reply.
    let msgs = agent.messages();
    let texts: Vec<String> = msgs
        .iter()
        .filter_map(|m| m.get_text().map(|t| t.to_string()))
        .collect();
    assert_eq!(
        texts.iter().filter(|t| t.contains("earlier question")).count(),
        1,
        "seed history must not be duplicated by the retry"
    );
    assert!(texts.iter().any(|t| t.contains("recovered")));
}

#[tokio::test(start_paused = true)]
async fn auth_error_fails_immediately_without_retry() {
    let agent = build_agent(
        MockProvider::new(vec![vec![StreamEvent::Error {
            message: "HTTP 401: {\"error\":{\"type\":\"authentication_error\"}}".into(),
        }]]),
        Vec::new(),
        CancellationToken::new(),
    );

    let events = drain(&agent, "hi").await;

    assert!(
        !events.iter().any(|e| matches!(e, AgentEvent::Retry { .. })),
        "auth errors must never be retried"
    );
    let err = events.iter().find_map(|e| match e {
        AgentEvent::Error(msg) => Some(msg.clone()),
        _ => None,
    });
    assert!(
        err.as_deref().unwrap_or_default().contains("401"),
        "auth error must surface verbatim: {err:?}"
    );
}

#[tokio::test(start_paused = true)]
async fn cancel_during_backoff_stops_promptly() {
    let token = CancellationToken::new();
    // Always rate-limited — without cancellation this would retry to the cap.
    let agent = build_agent(MockProvider::new(vec![rate_limited()]), Vec::new(), token.clone());

    let mut stream = agent.run_stream("hi");
    let mut retries = 0;
    let mut outcome: Option<String> = None;
    while let Some(ev) = stream.next().await {
        match ev {
            AgentEvent::Retry { .. } => {
                retries += 1;
                // Cancel while the runner is in (or entering) the backoff wait.
                token.cancel();
            }
            AgentEvent::Error(msg) => {
                outcome = Some(msg);
                break;
            }
            AgentEvent::Complete(_) => panic!("must not complete"),
            _ => {}
        }
    }
    assert_eq!(retries, 1, "cancel must interrupt the first backoff");
    assert!(
        outcome.as_deref().unwrap_or_default().contains("ancelled"),
        "backoff must resolve as Cancelled, got {outcome:?}"
    );
}
