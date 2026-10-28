# Reliable worker statistics delivery

The existing worker store owns worker lifetime. The existing statistics
service/SQLite event primary key owns durable deduplication. An internal
renderer recorder owns only currently visible workers, receipts for their
acknowledged sessions and payloads not yet acknowledged by that service.

Completing or disappearing workers produce the same session DTO as before.
Capture an end time once; retries preserve it. A missing service or a rejected
RPC never marks delivery successful or discards its payload. Delivery is
single-flight, in batches of at most 200 (the existing service limit), and
drains newly captured payloads after the current batch succeeds. A failure
retains the whole uncertain batch; retry is safe because durable insertion is
idempotent by stable worker id.

Acknowledged receipts are retained only while their worker remains visible;
disappeared-worker history has the explicit bound zero. Active tracking is
bounded by the current worker list. Undelivered payloads are pending work,
not an acknowledged-history cache; they remain until acknowledged and may
accumulate during a prolonged host outage. No localStorage history is added.
An old id replayed after eviction is harmlessly ignored by the durable owner.

The app-wide hook captures worker changes. Existing service publication and
SAIHOME refresh trigger delivery even when the worker list is unchanged.
Retries use those existing triggers, with no added timer. Rejections are
logged once per changed error; the feed continues to read other sources.
Queue/router reads remain concurrent; statistics reads follow the worker-write
acknowledgement so the same refresh includes the newly recorded sessions.

```mermaid
sequenceDiagram
  participant W as Existing worker store
  participant R as Renderer recorder
  participant S as Existing statistics service
  W->>R: terminal/disappeared worker
  R->>R: capture stable session payload
  R->>S: at most 200 sessions (one in flight)
  alt acknowledged
    S-->>R: inserted/duplicate accepted
    R->>R: remove pending; retain receipt while visible
  else unavailable/rejected
    R->>R: retain pending until existing readiness/refresh retry
  end
```

Before changing behavior, extract the original effect algorithm into the
same callable recorder interface. Preserve and hash that unfixed subject;
the final regression suite must fail against it and pass against the repair.
Acceptance covers unavailable/rejected delivery, disappeared running workers,
stable visible terminal workers, overlapping calls, arrivals during delivery,
100,000 completed/disappeared workers, the 200-item boundary and real SQLite
replay/equivalent stored DTOs. Existing queue/session/runtime ownership,
unmeasured token semantics and UI layout remain unchanged.
