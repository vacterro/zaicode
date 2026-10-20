# Message age uses its Host clock

T-338 corrects cross-device clock coordinates in T-335's elapsed message time. Subtracting a renderer wall clock from a CLI timestamp can make a two-minute-old message appear days old or newly sent.

## Clock owner

The existing V4 attachment handshake owns the clock sample. Capture the accepted `hello.serverTime` and renderer `performance.now()` at receipt, and publish that sample only after the existing clientHello succeeds. Cache the receipt point with the same service proxy as the existing handshake; reusing a cached Hello never resets its sample time. Current Host time is serverTime plus monotonic elapsed time. Missing, invalid or backwards monotonic readings are unavailable; renderer `Date.now()` is never an age fallback.

The existing conversation transport exposes a read-only clock projection. Its existing runtime lifecycle/restart invalidates availability and permits one single-flight fresh Hello clock read on recovery, preserving attachment initialization and subscription ownership. A late recovery result cannot resurrect an unavailable generation. Replacement transports delegate to the current owner, and separate Host service proxies keep separate clock samples. Existing SessionDataLayer and row context carry the same reader to both user and assistant metadata.

## Presentation

Extend the existing gated UI clock with an optional explicit reader. Existing two-argument wall-clock consumers retain their API and bucket behavior. Message metadata passes the Host reader and its durable createdAt as the bucket origin; only the metadata leaf updates. Clock loss/recovery is reflected within the existing one-second display tick, without changing message or accepted runtime state.

Both roles retain the original ISO timestamp and exact local date/time. With a known Host clock, calendar and localized elapsed labels use that same coordinate. With an unknown clock, show the full exact local sent time and omit the calculated age. Remount, replay, reconnect, project switches and renderer wall-clock jumps never rewrite createdAt or invent a fresh age.

```mermaid
sequenceDiagram
    participant Host as Existing Host V4 facade
    participant Hello as Existing attachment handshake
    participant Transport as Current transport owner
    participant Layer as Existing layer and row context
    participant Metadata as Message metadata leaf
    Host->>Hello: hello.serverTime
    Note over Hello: Receipt performance.now; publish after clientHello
    Hello->>Transport: Read-only sampled Host time
    Transport->>Layer: Stable clock reader
    Layer->>Metadata: Same reader for user and assistant
    Note over Metadata: Host epoch + monotonic delta - durable createdAt
    Transport->>Metadata: Unavailable after clock/connection loss
    Note over Metadata: Exact sent time remains; calculated age omitted
```

## Acceptance

1. One unchanged native regression rejects independent positive/negative renderer wall-clock skew on the original gated clock and passes the correction; monotonic advancement, unknown/invalid clocks and legacy consumers are covered.
2. Actual V4 handshake and transport supply a sampled Host clock for desktop continuous and web replayable profiles, reuse the receipt point, isolate Host proxies, and reject stale recovery/lifecycle results. Replacement delegates to the new owner.
3. Real browser user and assistant metadata retain exact sent times under renderer wall-clock jumps, advance through the Host clock, survive remount, hide calculated age while unavailable and resume from a fresh Host sample. Existing picker, independent transcript controls and AUTO scope behavior remain green.
4. Current typecheck, lint, architecture and root tests pass. Build and boot an isolated combined Windows app package containing T-335/T-336/T-337/T-338, inspect its actual packaged UI/runtime integration and preserve executable/asar/source identity evidence. This ticket cannot close without that package proof.

No production process replacement, user-data migration, paid provider request or Git publication is part of this clock correction.
