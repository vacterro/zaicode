#!/usr/bin/env pwsh
# saipen conformance validator -- FROZEN portable floor (v7.24.0).
# Kept for hosts without Python; new checks land only in tools/validate.py
# (the canonical validator). Don't extend this file.

$ErrorActionPreference = "Stop"

function Assert-Format($Condition, $Message) {
    if (-not $Condition) {
        Write-Host "FAIL: $Message" -ForegroundColor Red
        exit 1
    }
}

Write-Host "saipen conformance validation starting..." -ForegroundColor Cyan

# 1. Check STATE.md
if (-not (Test-Path ".saipen\STATE.md")) {
    Write-Host "FAIL: STATE.md missing" -ForegroundColor Red
    exit 1
}
$stateContent = Get-Content ".saipen\STATE.md" -Raw
Assert-Format ($stateContent -match "phase:\s+(INIT|PLAN|SCOUT|BUILD|VERIFY|REVIEW|SHIP|DONE|BLOCKED|VALIDATE|HUNT|MARKHUNT|ADD|CLEAN|TRANSLATE|PREPARE)") "STATE.md missing valid phase"
Assert-Format ($stateContent -match "task:") "STATE.md missing task"
Assert-Format ($stateContent -match "next_action:") "STATE.md missing next_action"
Assert-Format ($stateContent -match "blocker:") "STATE.md missing blocker"
Assert-Format ($stateContent -match "agent:") "STATE.md missing agent"
Assert-Format ($stateContent -match "updated:") "STATE.md missing updated"
Assert-Format ($stateContent -match "mode:\s+(full|read-only|no-publish|manual-verify)") "STATE.md missing mode, or mode isn't one of full|read-only|no-publish|manual-verify"
# saipen_version + transition_from complete RFC § 1.2's nine-field required
# set. Absent here until v7.96.0, so a host without Python got a PASS on a
# state tools/validate.py FAILs. transition_from carries the fresh-INIT
# exception: no previous phase exists to name there.
Assert-Format ($stateContent -match "saipen_version:\s+\d+") "STATE.md missing saipen_version (RFC § 1.2)"
if ($stateContent -notmatch "phase:\s+INIT") {
    Assert-Format ($stateContent -match "transition_from:") "STATE.md missing transition_from -- required on all non-INIT states (RFC § 1.2)"
}
Write-Host "PASS: STATE.md schema valid" -ForegroundColor Green

# 1b2. mode/phase basic compatibility (RFC § 1.3) -- not the full matrix,
# just the restriction stated normatively in prose. The old no-publish/SHIP
# ban was REMOVED here, not merely left out: v7.66.0 made SHIP reachable
# under no-publish (git steps skipped, local ones still run) because banning
# the phase left a git-less project unable to close any ticket. This file is
# frozen against NEW checks; correcting one that now contradicts the RFC is
# a bug fix, not an extension.
if ($stateContent -match "mode:\s+read-only" -and $stateContent -match "phase:\s+(INIT|PLAN|SCOUT|BUILD|SHIP|ADD|CLEAN|TRANSLATE|PREPARE)") {
    Assert-Format $false "mode: read-only MUST NOT enter INIT/PLAN/SCOUT/BUILD/SHIP/ADD/CLEAN/TRANSLATE/PREPARE (CORE § 1.3)"
}

# 1b. execution_intent: goal requires the persisted safety-valve counters (RFC § 2.4)
if ($stateContent -match "execution_intent:\s+goal") {
    Assert-Format ($stateContent -match "goal_waves:\s*\d+") "execution_intent: goal but goal_waves counter missing -- safety valve can't survive a restart without it"
    Assert-Format ($stateContent -match "goal_tickets:\s*\d+") "execution_intent: goal but goal_tickets counter missing -- safety valve can't survive a restart without it"
    Write-Host "PASS: goal intent counters present" -ForegroundColor Green
}

# 2. Check BOARD.md (cycles)
if (-not (Test-Path ".saipen\BOARD.md")) {
    Write-Host "FAIL: BOARD.md missing" -ForegroundColor Red
    exit 1
}
$boardLines = Get-Content ".saipen\BOARD.md"
$deps = @{}
foreach ($line in $boardLines) {
    # `needs:` runs to the next " | " field separator, not to end of line.
    # This read `(.*)` until v7.96.0, so a conformant `| needs: T-1 | verify: x`
    # line parsed its needs as "T-1 | verify: x" and the dangling-reference
    # check below FAILed a legal board. validate.sh always used [^|]* here;
    # the two halves of the portable floor disagreed, and nobody noticed
    # because this repo runs the Python validator.
    if ($line -match "- \[( |x|/)\] (T-\d+).*needs: ([^|]*)") {
        $taskId = $matches[2]
        $needsRaw = $matches[3]
        $needsList = $needsRaw -split "," | ForEach-Object { $_.Trim() }
        $deps[$taskId] = @($needsList | Where-Object { $_ -ne "" })
    }
}

function Detect-Cycle($node, $visited, $stack) {
    $visited[$node] = $true
    $stack[$node] = $true

    if ($deps.ContainsKey($node)) {
        foreach ($neighbor in $deps[$node]) {
            if (-not $visited.ContainsKey($neighbor)) {
                if (Detect-Cycle $neighbor $visited $stack) { return $true }
            } elseif ($stack.ContainsKey($neighbor) -and $stack[$neighbor]) {
                return $true
            }
        }
    }
    $stack[$node] = $false
    return $false
}

$visited = @{}
$stack = @{}
$hasCycle = $false
$cycleNode = ""
foreach ($node in $deps.Keys) {
    if (-not $visited.ContainsKey($node)) {
        if (Detect-Cycle $node $visited $stack) {
            $hasCycle = $true
            $cycleNode = $node
            break
        }
    }
}
# Wording matches validate.sh deliberately: the two halves are one floor in
# two languages, and a human comparing platforms (or anything grepping the
# output) should not have to know which half produced it. They said
# different things for the same defect until v7.101.0, found the moment
# tools/audit_floor.py started auditing this half too.
Assert-Format (-not $hasCycle) "BOARD.md contains cyclic needs: dependencies involving: $cycleNode"
Write-Host "PASS: BOARD.md acyclic" -ForegroundColor Green

# 2b. Check BOARD.md for duplicate ticket IDs -- a status change that
# copied a ticket line instead of moving it (RFC § 1.2) leaves the same
# T-### appearing twice, either within one section or across two.
$idCounts = @{}
foreach ($line in $boardLines) {
    if ($line -match "- \[( |x|/)\] (T-\d+)") {
        $id = $matches[2]
        if ($idCounts.ContainsKey($id)) { $idCounts[$id]++ } else { $idCounts[$id] = 1 }
    }
}
$dupeIds = @($idCounts.GetEnumerator() | Where-Object { $_.Value -gt 1 } | ForEach-Object { $_.Key })
Assert-Format ($dupeIds.Count -eq 0) "BOARD.md has duplicate ticket ID(s): $($dupeIds -join ', ') -- a status change must move the line (cut+paste), never copy it"
Write-Host "PASS: BOARD.md no duplicate tickets" -ForegroundColor Green

# 2c. Check BOARD.md for dangling needs: references -- worse than a cycle:
# a needs: pointing at a T-### that doesn't exist anywhere on the board
# leaves the Pick Rule permanently unsatisfiable with zero diagnostic signal.
$allTicketIds = @{}
foreach ($id in $idCounts.Keys) { $allTicketIds[$id] = $true }
$danglingRefs = @()
foreach ($entry in $deps.GetEnumerator()) {
    foreach ($needed in $entry.Value) {
        if ($needed -ne "" -and -not $allTicketIds.ContainsKey($needed)) {
            $danglingRefs += "$($entry.Key)->$needed"
        }
    }
}
Assert-Format ($danglingRefs.Count -eq 0) "BOARD.md has dangling needs: reference(s): $($danglingRefs -join ', ') -- referenced ticket doesn't exist anywhere on the board"
Write-Host "PASS: BOARD.md no dangling needs: references" -ForegroundColor Green

# 2d. Check BOARD.md has all four required section headings (RFC § 1.2) --
# the ticket-shape/dangling/cycle checks above never verified the headings
# they scan under actually exist.
foreach ($heading in @("## DOING", "## TODO", "## DONE", "## BLOCKED")) {
    Assert-Format (($boardLines | Where-Object { $_.Trim() -eq $heading }).Count -gt 0) "BOARD.md missing required section heading: $heading"
}
Write-Host "PASS: BOARD.md has all required section headings" -ForegroundColor Green

# 3. Check LOG.md -- date prefix is optional (pre-STYLE.md history has none,
# current entries carry one), everything else is mandatory. The FILE is not
# optional: RFC § 1.2 requires it and § 1.5 Recovery rebuilds from it, so
# absence is a FAIL, not a skip -- otherwise this is a gate that cannot fail
# (phases/verify.md). An EMPTY LOG.md is legal, that is what a fresh INIT
# writes. v7.75.0 closed this in validate.py and validate.sh and missed this
# file; the Windows floor kept the hole one release longer.
if (-not (Test-Path ".saipen\LOG.md")) {
    Assert-Format $false "LOG.md missing -- RFC 1.2 requires it (an empty LOG.md is legal on a fresh project; an absent one is not)"
}
if (Test-Path ".saipen\LOG.md") {
    $logLines = Get-Content ".saipen\LOG.md"
    $logPattern = "^-\s+(\d{2}[.\/]\d{2}[.\/]\d{2}\s+\d{2}:\d{2}\s+)?\[E-\d+\](\s+\[parent:\s+E-\d+\])?"
    foreach ($line in $logLines) {
        if ($line.Trim() -ne "" -and $line -notmatch "^#") {
            Assert-Format ($line -match $logPattern) "LOG.md entry violates Graph Event format: $line"
        }
    }
    Write-Host "PASS: LOG.md format valid" -ForegroundColor Green
}

# 4. Check KNOWLEDGE/ -- recurse into subdirs and scan every file, not just
# *.md at the top level, to match validate.sh's `grep -rE` over the whole tree.
if (Test-Path ".saipen\KNOWLEDGE") {
    $knowledgeFiles = Get-ChildItem ".saipen\KNOWLEDGE" -Recurse -File
    foreach ($file in $knowledgeFiles) {
        $content = Get-Content $file.FullName
        foreach ($line in $content) {
            Assert-Format ($line -notmatch "^-\s+\d{2,4}[-./]\d{2}[-./]\d{2}.*(RUN|DEC|H):") "KNOWLEDGE/ leak: found event journal syntax in $($file.Name)"
        }
    }
    Write-Host "PASS: KNOWLEDGE/ clean" -ForegroundColor Green
}

# 5. Self-check: README.md's version badge vs VERSION. Only applies when run
# from the saipen repo's own clone root (fingerprinted by saipen/RFC.md sitting
# next to VERSION -- a consuming project's .saipen/ never has that) -- this
# exact drift has now happened three times because it only ever gets caught by
# someone remembering a separate manual grep. Riding along on the validator
# that already runs before every ship means it's caught for free instead.
if ((Test-Path "saipen\RFC.md") -and (Test-Path "VERSION") -and (Test-Path "README.md")) {
    $repoVersion = (Get-Content "VERSION" -Raw).Trim()
    $readmeContent = Get-Content "README.md" -Raw
    Assert-Format ($readmeContent -match [regex]::Escape("**v$repoVersion**")) "README.md badge doesn't match VERSION ($repoVersion) -- this has drifted before, update the badge"
    Write-Host "PASS: README.md badge matches VERSION" -ForegroundColor Green
}

# Same correction as the sh half, same wording -- the two halves already
# diverged on their own words once (v7.96.0) and that cost a reader the
# ability to compare platforms.
Write-Host "Portable floor complete: no structural break found." -ForegroundColor Green
Write-Host "This is a SUBSET of tools/validate.py -- run that wherever Python exists." -ForegroundColor Green
