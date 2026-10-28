# Bounded rolling-window starter

SRC-175 / SRC-176: start idle vendor quota windows automatically with the smallest
supported real request. The later request permits minimal token use and requires
a bounded answer. Reading quota still generates no model tokens.

The existing engines owner admits and persists one request per quota pool, keeps
the crash/retry cooldown and confirms the vendor's fixed reset on a later read.
An exhausted independent pool cannot gate a usable pool. A spent weekly limit
in the same pool and a disabled rolling-window preference remain authoritative.

Claude uses Haiku with tools/MCP/hooks disabled, an eight-token output ceiling,
thinking disabled and a $0.005 CLI budget. A one-token ceiling caused automatic
length retries in the installed CLI; eight tokens leave space to finish `ok`.
Codex uses a minimal instructions file, low effort/verbosity,
and a schema admitting only `{"ok":true}`. Antigravity uses an advertised Flash
model, disables skill expansion, applies that same schema and a print deadline.
ZCode keeps its trusted Coding Plan endpoint and provider-side `max_tokens: 1`.
The CLIs do not all expose a provider token ceiling; schema/deadline are not a
claim of zero input/reasoning tokens. Failed requests stay visible and retry
only after the existing cooldown. Never fake a countdown from a local attempt.

Argument/env regression tests precede changes. Native isolated fixtures disable
paid starts. An explicitly authorized live one-request check records counts
and real reset evidence without logging authentication or model response text.
