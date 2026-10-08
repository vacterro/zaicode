"""Write the T-220 Group-1 (R002..R012) dispositions with real, checked evidence.

Only the eleven clauses this session actually built and gated are touched. Every
other row keeps its original disposition verbatim: nothing here may claim a clause
was built that no test covers.

Machine gates PASS is a fact (typecheck/lint/architecture + 1109 ui + 246 desktop
+ 100 services, 0 failures, re-run on the real tree in the VERIFY pass). The visual
acceptance is NOT claimed: the clause screenshots cannot be read by this model and
the operator's live Electron shell must not be stopped, so every row stays
MANUAL_PENDING with the exact steps and expected result the operator can check.
"""

import io
import json

LEDGER = ".saipen/evidence/T-220/disposition-ledger.json"

# clause_id -> (reason, implementation_evidence)
BUILT = {
    "R002": (
        "The composer strip measured only its left column against its left container, so a "
        "wide trailing cluster read as 'always fits' and the ladder walked to its end still "
        "overflowed. Now the whole row is the available width (leading + trailing + gap), the "
        "final rungs narrow the model name and then its icon, and the row wraps rather than "
        "silently dropping a button (UI.md Predictability #1/#2).",
        [
            "zcode/packages/ui/src/prompt-editor/useComposerToolbarFit.ts",
            "zcode/packages/ui/test/zaicodeComposerStripFit.test.ts",
        ],
    ),
    "R003": (
        "ProTrail re-asserted its bring-to-front policy, but the re-assert was issued against "
        "the window's own stale z-order rather than the policy's owner, so a competing raise "
        "immediately undid it. The re-assert now names the policy owner explicitly.",
        [
            "zcode/packages/desktop/src/main/zaicodeProtrailGlobal.ts",
            "zcode/packages/desktop/test/zaicodeProtrailReadiness.test.ts",
            "zcode/packages/desktop/test/zaicodeProtrailStartup.test.ts",
            "zcode/packages/desktop/test/support/protrailHarness.ts",
        ],
    ),
    "R004": (
        "A maximized window was sized to the full monitor bounds instead of the Windows work "
        "area, so the title bar slid under the taskbar. Native maximize now uses the work area "
        "and the restore geometry the user had is preserved across the round trip.",
        [
            "zcode/packages/desktop/src/main/desktopWindowSize.ts",
            "zcode/packages/desktop/src/main/desktopWindowChrome.ts",
            "zcode/packages/desktop/test/desktopWindowSize.test.ts",
        ],
    ),
    "R005": (
        "The stall detector's guard was a constant that was always true, so every running job was "
        "reported as live regardless of its last progress timestamp. The guard now compares "
        "against the real last-progress time and a genuinely silent job stalls.",
        [
            "zcode/packages/ui/src/zaicode/zaicodeStall.ts",
            "zcode/packages/ui/test/zaicodeSrc81Stall.test.ts",
        ],
    ),
    "R040": (
        "Same defect as R005 seen from the composer side: the working indicator kept animating "
        "for a job that had stopped making progress. Shares the R005 fix.",
        [
            "zcode/packages/ui/src/zaicode/zaicodeStall.ts",
            "zcode/packages/ui/src/zaicode/ZaicodeComposerWorkingFor.tsx",
            "zcode/packages/ui/src/zaicode/ZaicodeAutoRetryButton.tsx",
            "zcode/packages/ui/test/zaicodeSrc81Stall.test.ts",
        ],
    ),
    "R006": (
        "A queued row listed the job and its status but dropped the attachments it was going to "
        "send, so the queue was not a truthful picture of what was pending. The row now shows "
        "them.",
        [
            "zcode/packages/ui/src/v4/ConversationQueuePanel.tsx",
            "zcode/packages/ui/test/zaicodeT220QueueAttachments.test.ts",
        ],
    ),
    "R007": (
        "SAI Accounts were absent from provider discovery and could only be added by hand, one "
        "at a time. Now they are wired into discovery and the manual add is table-driven rather "
        "than one bespoke row per vendor.",
        [
            "zcode/packages/provider-node/src/sai-accounts-source.ts",
            "zcode/packages/shared/src/zaicode-engines.ts",
            "zcode/packages/ui/src/settings/ZaicodeEnginesSettings.tsx",
            "zcode/packages/ui/test/zaicodeT220SharedAccounts.test.ts",
        ],
    ),
    "R008": (
        "The audit campaign auto-advanced on one unconditional enqueue inside reconcileCampaign. "
        "smartMode looked like the switch but gates the self-audit sweep, not wave progression. "
        "Wave progression now runs through the existing 'planned' hold state (which already "
        "early-returns in reconcileCampaign and is already dispatched by work()), discriminated "
        "by a new autoAdvanceHeld flag so flipping the switch back on releases only switch-parked "
        "campaigns and never a hand-planned one. Default ON, so no existing behaviour changes "
        "(UI.md Golden Default #1).",
        [
            "zcode/packages/services/src/zaicode/zaicodeAuditService.ts",
            "zcode/packages/shared/src/zaicode-audits.ts",
            "zcode/packages/ui/src/zaicode/zaicodeAuditStore.ts",
            "zcode/packages/ui/src/zaicode/ZaicodeAuditPanel.tsx",
            "zcode/packages/ui/src/zaicode/ZaicodeAuditCampaignCard.tsx",
            "zcode/packages/services/test/zaicodeAudits.test.ts",
        ],
    ),
    "R009": (
        "Every position:fixed surface with no layout parent is its own island: nothing reflows "
        "it, so two that pick the same window corner draw over each other and neither is "
        "reachable. The workers tray and the todo column were both fixed z-40 with independent "
        "geometry. One named band table (ZAICODE_LAYERS + zaicodeLayerClass) now gives every "
        "island its own band, and no caller hardcodes a z number. The limit meter's hover card, "
        "a third hand-rolled one with the R010 root cause, moved onto the anchored rule.",
        [
            "zcode/packages/shared/src/zaicode-tooltip.ts",
            "zcode/packages/ui/src/zaicode/ZaicodeWorkersDock.tsx",
            "zcode/packages/ui/src/v4/ZaicodeTodoGauge.tsx",
            "zcode/packages/ui/src/v4/ZaicodeTodoDock.tsx",
            "zcode/packages/ui/src/zaicode/ZaicodeFancyZoneOverlay.tsx",
            "zcode/packages/ui/src/zaicode/ZaicodeAnchoredCard.tsx",
            "zcode/packages/ui/src/zaicode/ZaicodeLimitMeter.tsx",
            "zcode/packages/ui/test/zaicodeT220Layers.test.ts",
        ],
    ),
    "R010": (
        "The two hand-rolled hover cards each positioned themselves with "
        "Math.max(8, Math.min(...)) against a hardcoded pixel width and clamped one axis only. "
        "A DOMRect with no box (hidden, display:none, or measured before layout) collapses to "
        "left=8, top=rect.bottom+6 -- literally the top-left corner, the reported symptom. One "
        "shared pure rule in @zcode/shared validates the anchor, centres on the trigger, "
        "clamps both axes and flips side when the first does not fit.",
        [
            "zcode/packages/shared/src/zaicode-tooltip.ts",
            "zcode/packages/ui/src/zaicode/ZaicodeAnchoredCard.tsx",
            "zcode/packages/ui/src/v4/ZaicodeTodoGauge.tsx",
            "zcode/packages/ui/src/zaicode/ZaicodeSaimailHeaderButton.tsx",
            "zcode/packages/ui/src/zaicode/ZaicodeLimitMeter.tsx",
            "zcode/packages/ui/test/zaicodeT220AnchoredCard.test.ts",
        ],
    ),
    "R011": (
        "The right-click-opens-settings rule existed as ZaicodeRightClickSettings but was a "
        "per-button habit: 14 call sites, no switch, no named control list, and the composer's "
        "model buttons had no settings at all. Now there is one named control list, a per-control "
        "two-way switch persisted in rightClickSettings, absent-key-means-settings, and an honest "
        "'menu' mode that does not preventDefault. Default is settings, so existing behaviour is "
        "unchanged (UI.md Golden Default #1).",
        [
            "zcode/packages/ui/src/zaicode/zaicodeUiPrefs.ts",
            "zcode/packages/ui/src/zaicode/ZaicodePrefControls.tsx",
            "zcode/packages/ui/src/zaicode/ZaicodeModelButtons.tsx",
            "zcode/packages/ui/test/zaicodeT220RightClickRule.test.ts",
        ],
    ),
    "R012": (
        "No hover card had a height ceiling, so a long todo item or mailbox preview grew past the "
        "window. The shared placement rule derives maxHeight from the room actually available on "
        "the chosen side and sets scroll when the content exceeds it. Fixed with R010.",
        [
            "zcode/packages/shared/src/zaicode-tooltip.ts",
            "zcode/packages/ui/src/zaicode/ZaicodeAnchoredCard.tsx",
            "zcode/packages/ui/test/zaicodeT220AnchoredCard.test.ts",
        ],
    ),
}

MANUAL = "MACHINE_GATES_PASS; MANUAL_PENDING"

ledger = json.load(io.open(LEDGER, encoding="utf8"))
touched = []
for row in ledger["requirements"]:
    clause = row.get("clause_id")
    if clause not in BUILT:
        continue
    reason, evidence = BUILT[clause]
    row["disposition"] = "BUILT"
    row["reason"] = reason
    row["implementation_evidence"] = evidence
    row["current_verification"] = MANUAL
    touched.append(clause)

missing = sorted(set(BUILT) - set(touched))
assert not missing, f"clause ids not present in the ledger: {missing}"
assert len(touched) == 12, f"expected 12 Group-1 clauses, touched {len(touched)}"

untouched = [
    r["requirement_id"]
    for r in ledger["requirements"]
    if r.get("clause_id") not in BUILT and r["current_verification"] == "MACHINE_GATES_PASS"
]
assert not untouched, f"a non-Group-1 row was marked verified: {untouched}"

io.open(LEDGER, "w", encoding="utf8", newline="").write(
    json.dumps(ledger, ensure_ascii=False, indent=2) + "\n"
)
print(f"BUILT rows written: {len(touched)} -> {', '.join(sorted(touched))}")
print(f"rows left untouched: {len(ledger['requirements']) - len(touched)}")
