ZAICODE

T-113 RECOVERY — CORRECT FALSE VOLUME BLOCKER AND RESUME SAITRANSLATE

Do not create a new ticket.
Resume T-113.

CURRENT TRUTH

T-111 is DONE.
T-112 is DONE.

T-112 Quick3/A3 acceptance is strong:
- two independent live three-wave campaigns passed;
- real local qwen3.5:9b auditor was used;
- malformed/invalid wave outputs were refused;
- same-wave retry preserved the wave index;
- Core, Second and Performance artifacts were saved;
- __00_AUDIT_ALL_3.md was synthesized and digest-verified;
- Fix with SAIPEN consumed the exact combined artifact;
- current gates passed.

T-113 is currently BLOCKED by a volume calculation that is mathematically wrong.

The recorded measurement is:

30 locale bodies
5848 keys each
30 keys translated in 152 seconds
~0.197 keys/second

Correct arithmetic:

5848 / (30 / 152)
= approximately 29,630 seconds per locale
= approximately 8.23 hours per locale

30 locales:
~246.9 hours total
= approximately 10.3 days continuous at the measured single-model throughput

NOT 243 days.

The existing blocker therefore overstates the measured duration by
approximately 24x.

Also correct the second blocker assumption:

The exact-parity gate correctly prevents an INCOMPLETE locale from being
integrated into the product tree.

It does NOT imply that translation work cannot make durable partial progress.

The SAITRANSLATE charter explicitly owns:

.saipen/saitranslate/kitchen/

for locale drafts/work-in-progress and only requires the final READY package
to be complete before collection.

Therefore:
- partial locale work must never be shipped as a complete locale;
- but deterministic draft progress may be checkpointed inside the producer
  namespace and resumed.

STEP 1 — CORRECT MACHINE TRUTH

Through canonical SAIPEN lifecycle operations:

- remove the false 243-day blocker;
- record the corrected measured estimate;
- record that producer drafts are resumable even though incomplete locales are
  not collectable;
- resume T-113 from BUILD.

Do not manually edit protocol history except through supported repair/lifecycle
operations.

STEP 2 — SPLIT OWNERSHIP CORRECTLY

Current language truth:

Existing language locales:
- English
- zh-CN

DED exists as the intentional voice variant.

Missing language locales: 30.

Protocol ownership:
- Core owns EN / RU / EE / DED.
- SAITRANSLATE owns the other 29 language locales.

Therefore of the 30 currently missing locales:
- RU and EE are Core work;
- 28 are missing SAITRANSLATE-owned locales;
- zh-CN is already one completed SAITRANSLATE-owned language locale.

Do not ask SAITRANSLATE to author RU or EE.

STEP 3 — CLOSE CORE-OWNED RU AND EE FIRST

Generate complete Russian and Estonian catalogs directly under Core authority.

Requirements:
- exact 5848-current-key parity or whatever the recomputed HEAD count is;
- no extra keys;
- placeholder/token parity;
- command names, paths, code identifiers and product tokens preserved;
- actual translation, never copied English filler;
- UI and CLI locale mapping correct;
- switcher selectable;
- persistence survives restart;
- locale freshness/source digest recorded.

Do not integrate partial RU or EE files.

Run the locale parity gate after each complete locale.

This should also immediately improve the mandatory default-six coverage.

STEP 4 — FIX THE SAITRANSLATE EXECUTION STRATEGY

The measured qwen3.5:9b attempt returned non-parseable JSON for only 30 keys.

Treat that as a runner defect/strategy problem, not merely "the model is slow."

Inspect the actual producer implementation and introduce a robust deterministic
translation runner.

Requirements:

1. RESUMABLE DRAFTS

Persist translation progress under:

.saipen/saitranslate/kitchen/

A draft must include at minimum:
- locale id;
- source identity;
- source tree fingerprint;
- source catalog digest;
- exact translated key set;
- pending key set;
- batch identities;
- model/provider identity;
- validation status.

A restart must resume from the remaining keys rather than retranslating the
whole locale.

2. DETERMINISTIC SHARDING

Do not send one key at a time.

Batch keys deterministically.

Choose batch size empirically based on parse reliability and throughput.

Start with a bounded range such as 50-200 entries per request, measure it, and
adjust from evidence.

Each batch has a stable identity derived from:
locale + source digest + ordered key range/key set.

Retrying a batch must not duplicate translated keys.

3. ROBUST OUTPUT FORMAT

Do not depend on the model returning one giant fragile JSON object.

Prefer a format that can be validated incrementally, for example deterministic
JSONL or another schema that preserves one source key per record.

The runner must:
- reject unknown keys;
- reject missing required keys from the requested batch;
- reject duplicate keys;
- reject malformed placeholders;
- preserve template tokens;
- repair only transport/serialization syntax when safe;
- never invent a translation for a missing model output.

A failed batch retries that same batch.

4. VALIDATION BEFORE ACCEPTANCE

Every translated entry must preserve:
- ICU/template placeholders;
- printf-style tokens if present;
- code/path literals where designated immutable;
- newline/markup constraints where required.

A completed locale is valid only after exact full-catalog parity.

5. NO PRODUCT-TREE PARTIALS

Incomplete producer locales stay only in the SAITRANSLATE workspace.

Do not add half-translated locale files to the product locale catalog merely to
show progress.

Only collect a locale/package after its required completeness boundary is met.

STEP 5 — USE AVAILABLE PARALLELISM SAFELY

Inspect the existing SAIFREN / crew / producer mechanisms.

If multiple eligible workers/models are available, parallelize by independent
locale or deterministic shard.

Prefer locale-level parallelism because it minimizes merge conflicts.

If sharding one locale across workers:
- shards must own disjoint key sets;
- merge must be deterministic;
- duplicate key ownership is an error;
- every shard must share the same frozen source digest.

Do not introduce uncontrolled concurrency.

Concurrency must increase throughput without weakening exactness.

STEP 6 — BENCHMARK THE RUNNER AGAIN

Before projecting total completion time, benchmark at least:

- one small batch;
- one medium batch;
- enough repeated batches to measure parse success rate.

Record:
- keys/second;
- tokens/request if available;
- parse success rate;
- retry rate;
- validation rejection rate;
- effective accepted keys/second.

Use ACCEPTED validated keys, not raw model output, for throughput.

Recompute ETA from the measured accepted throughput.

Never convert hours into days incorrectly again.

STEP 7 — DEFAULT SIX FIRST

The installed protocol states that the mandatory/default set is:

- English
- Russian
- Estonian
- Ukrainian
- Japanese
- DED

After Core completes RU and EE, prioritize producer work so Ukrainian and
Japanese become the next completed producer locales.

That gives the product its required default set early while full 32-language
coverage continues.

This is prioritization only.
It does not reduce final Wave 6 acceptance.

STEP 8 — COMPLETE THE REMAINING PRODUCER LOCALES

Produce the remaining real translations in deterministic locale batches.

For every locale:
- full source parity;
- placeholder parity;
- current source digest;
- selectable locale;
- persistent locale choice;
- UI/CLI identifier agreement or explicit mapping;
- no English placeholder-copy masquerading as translation.

RTL locales, if present in the authoritative protocol list, must propagate
direction through the design system.

STEP 9 — FINAL WAVE 6 ACCEPTANCE

T-113 remains open until:

- exact authoritative 32-language locale set exists;
- DED variant remains valid;
- all locales pass exact key parity;
- placeholders/tokens pass;
- switch/persist works;
- UI and CLI localization agree;
- representative long-string layouts do not clip primary actions;
- RTL behavior passes where applicable;
- SAITRANSLATE freshness/digests match current source;
- normal repository gates pass.

IMPORTANT

Do not declare BLOCKED merely because the whole batch cannot finish in one
agent turn.

This is a resumable producer workload.

A legitimate blocker requires something external that prevents forward progress,
not merely a large amount of deterministic work.

Checkpoint progress after each complete locale or stable translation batch so a
cold agent can continue exactly where the previous one stopped.

FINAL REPORT

Report:
- corrected throughput arithmetic;
- RU status;
- EE status;
- default-six coverage;
- producer locales complete / 29;
- producer locales remaining;
- accepted keys/second;
- parse/retry rate;
- current source digest;
- exact next locale/batch.