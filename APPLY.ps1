$ErrorActionPreference = "Stop"

Set-Location "V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_ZAICODE"

$branch = (git branch --show-current).Trim()
if ($branch -ne "master") {
    throw "Expected current branch 'master', got '$branch'."
}

gh auth status
if ($LASTEXITCODE -ne 0) {
    throw "GitHub CLI is not authenticated. Run: gh auth login"
}

Write-Host ""
Write-Host "[1/5] Pushing current committed master to origin..."
git push -u origin master
if ($LASTEXITCODE -ne 0) {
    throw "Push failed. Working tree was not modified."
}

Write-Host ""
Write-Host "[2/5] Changing GitHub default branch to master..."
gh api --method PATCH repos/vacterro/zaicode -f default_branch=master | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "GitHub API failed to change the default branch."
}

Write-Host ""
Write-Host "[3/5] Updating local origin/HEAD..."
git remote set-head origin master
if ($LASTEXITCODE -ne 0) {
    throw "Could not set origin/HEAD to master."
}

Write-Host ""
Write-Host "[4/5] Verifying GitHub..."
$defaultBranch = gh repo view vacterro/zaicode --json defaultBranchRef --jq ".defaultBranchRef.name"
if ($defaultBranch -ne "master") {
    throw "Verification failed. GitHub still reports '$defaultBranch' as default."
}

Write-Host ""
Write-Host "[5/5] Final state..."
git status --short
git branch -vv
git remote show origin

Write-Host ""
Write-Host "[DONE] master is now the GitHub default branch and origin/HEAD points to master." -ForegroundColor Green