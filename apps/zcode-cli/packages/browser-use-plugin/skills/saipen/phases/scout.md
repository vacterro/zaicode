# Phase: SCOUT

Claiming is CORE/OPS work; confirm T-### is the claimed top workable ticket.

1. Read relevant KNOWLEDGE first: use its compact INDEX when fresh, match the
   objective against scope/trigger/path, and load only the smallest relevant
   active set. Missing/stale INDEX falls back to targeted search, never a
   whole-tree read. Then read the ticket's files and one similar neighbor.
2. Record naming, errors, imports, reuse points, architecture, and build/test
   commands. Never invent a parallel architecture.
3. On first discovery, store canonical harness/build commands in KNOWLEDGE
   from repository-owned manifests/CI; they are **cited afterwards rather than**
   re-derived. Ambiguous command -> `WAIT: blocked` naming what is missing.
4. Put only promotion-gate-qualified durable findings in KNOWLEDGE; search
   first, and never turn progress/history/protocol into a card.
5. LOG one `RUN: SCOUT -- <scope/findings>` Event Graph line, then use the
   canonical checkpoint.

After SCOUT: STATE -> BUILD.
