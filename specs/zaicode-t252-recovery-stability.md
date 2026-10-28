# Queue recovery and shutdown stability

The shared job transition matrix owns legal state edges. The SQLite job
repository admits each edge atomically; the job service owns its runtime
handles and heartbeat lifetime. Agent, job and statistics repositories each
own one SQLite connection and its initialization generation.

A blocked job requires the existing Resume command before a new dispatch.
Claim SQL derives admission from the shared matrix; a waiting runtime resumes
its existing attempt and is never claimed as a new run. Resume exposes a clean
queued projection: prior start/finish time, session, actual model, result and
error are absent. A new claim clears those same previous-attempt facts before
the executor can attach its own session/model. Attempt count and the previous
run id remain available through resume for stale-write discrimination; a claim
increments the count and installs a new run id. Terminal rows remain immutable
and old completion/attach commands cannot overwrite the new attempt.

The queue UI consequently shows a resumed job without the previous duration,
answer/session link or actual-model badge. Current facts appear only after the
new run supplies them. No UI cache or alternate session owner is introduced.

Close increments the repository generation. An initializer suspended at the
asynchronous directory preparation must check its captured generation before
opening SQLite or applying migrations. A superseded initializer rejects and
cannot close or clear a newer initializer. Calling `ensureReady` explicitly
after close may open a new generation; old work cannot do so accidentally.

Job-service disposal is terminal for that service instance. Every asynchronous
repository admission checks the service lifetime before and after the await;
the startup continuation checks it again before starting a heartbeat. Pending
startup, autopump or reaper work cannot reopen storage after disposal. Disposal
still releases this host's existing leases through the same repository path.
Concurrency reads/writes use that admission as well: a cold workspace can
request its settings alongside the first queue fetch without reading an
uninitialized repository.

```mermaid
sequenceDiagram
  participant C as Caller
  participant S as Job service
  participant R as Existing repository
  C->>S: ensureReady
  S->>R: initialize generation N
  R->>R: await directory preparation
  C->>S: dispose (terminal)
  C->>R: close (generation N+1)
  R-->>S: reject stale generation N
  S-->>C: startup cancelled; no heartbeat/open
```

Acceptance uses real temporary SQLite on Windows, covering blocked-dispatch
denial, legal resume/claim/attach, clean current-attempt fields, every existing
repository mutation against the shared matrix, stale completion, terminal
irreversibility, three repo close races, single-flight startup and intentional
fresh reopen. Immediate service startup/shutdown is exercised both before the
initial open and with an already-ready repo. Directory removal after shutdown
asserts no reopened database remains. No schema migration or delivery contract
change is required.
