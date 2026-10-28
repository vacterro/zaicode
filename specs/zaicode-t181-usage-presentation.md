# Usage presentation (T-181 / SRC-120)

Eliminate bright default button fills and opaque route identifiers in the Usage
view without changing the router's metrics or the operator's selected theme.

## Behavior and ownership

- Reuse the existing Button ghost/outline variants and semantic theme tokens.
  Period, metric and breakdown selections expose their selected state to both
  accessibility APIs and the existing raised/sunken bevel renderer.
- 9router remains the sole owner of usage metrics and provider/account identity.
  The view reads the existing read-only catalog endpoints once per mount.
  Unmount discards late responses; catalog failure uses existing router metadata.
- Pure display helpers resolve catalog names, reject UUID/opaque hexadecimal
  route identifiers before shortening display text, and bound retained metadata.
  Unidentified breakdown entries merge into Other providers/accounts; all metric
  fields are summed and the original input rows remain unchanged.
- Recent/active requests display useful model names and readable outcomes, not
  raw provider IDs. Unknown catalog entries must never expose identifiers in
  visible text or tooltips. Request bodies and credentials are never retained.
- Numeric cells wrap rather than overlap in a narrow sidebar. Full values remain
  available; totals, periods and recent-history bounds are unchanged.
- Existing page/sidebar/close controls and Ctrl+Alt+B retain their behavior.
  Existing Live refresh remains an explicit on/off control with one mounted
  polling owner. This presentation change adds no polling or persistence writer.

```text
9router -> existing desktop bridge -> mounted Usage view -> pure labels -> table
                                unmount -> ignore late catalog/metric responses
```

## Acceptance

Regression tests cover catalog resolution, missing/opaque/overlong identities,
metric-preserving grouping, immutable inputs and readable statuses. UI checks
exercise all breakdown tabs and period controls, selected state, page/sidebar,
close/reopen, a 640x540 viewport and a narrow sidebar with large token counts.
No global palette or renderer setting is changed; Chromium text rasterization
remains the existing documented platform limitation. Run typecheck, lint,
architecture check, relevant tests and the full pre-push gate; report unobserved
packaged/live-router acceptance as NOT RUN rather than substituting fixtures.
