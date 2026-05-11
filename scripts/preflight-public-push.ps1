<#
.SYNOPSIS
    Preflight checks before syncing the dev repo to the public Lull-Mail mirror.

.DESCRIPTION
    Runs read-only checks against the working tree to catch the kinds of
    mistakes that have bitten us during dev -> public pushes:
      - Hardcoded "Lull-Mail-dev" references in user-facing files
      - Missing LICENSE / CONTRIBUTING / CODE_OF_CONDUCT
      - Broken internal markdown links
      - Private absolute paths leaking into commits
      - Workflow / issue-template slugs pointing to the wrong repo
      - Missing assets referenced from README
    Optionally hits shields.io URLs to verify they 200.

    Designed to be run BEFORE `git filter-repo` and the push to the public
    mirror. Do NOT wire as a pre-commit hook on the dev repo - some checks
    legitimately fail in dev (the runtime code references the public repo
    on purpose) and the script's whitelist is tuned for the staging set.

.PARAMETER All
    Collect every failure and exit at end. Without this, the script exits
    on first failure (faster feedback during fixing).

.PARAMETER Online
    Hit shields.io URLs from README badges to verify they return 200.
    Slow (~5 s per badge); opt-in.

.EXAMPLE
    pwsh scripts\preflight-public-push.ps1
    pwsh scripts\preflight-public-push.ps1 -All
    pwsh scripts\preflight-public-push.ps1 -All -Online
#>

[CmdletBinding()]
param(
    [switch]$All,
    [switch]$Online
)

$ErrorActionPreference = 'Stop'

# Resolve repo root from the script location (scripts\preflight-public-push.ps1 -> repo root).
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

$failures = New-Object System.Collections.Generic.List[string]
$checksRun = 0

function Write-Ok    ($msg) { Write-Host "  [OK]   $msg" -ForegroundColor Green }
function Write-Fail  ($msg) {
    Write-Host "  [FAIL] $msg" -ForegroundColor Red
    $script:failures.Add($msg) | Out-Null
    if (-not $All) {
        Write-Host ""
        Write-Host "Aborting on first failure. Re-run with -All to collect every failure." -ForegroundColor Yellow
        exit 1
    }
}
function Start-Check ($name) {
    $script:checksRun++
    Write-Host ""
    Write-Host "==> $name" -ForegroundColor Cyan
}

# ---------------------------------------------------------------------------
# 1. Forbidden references in user-facing files
# ---------------------------------------------------------------------------
Start-Check '1. Forbidden "Lull-Mail-dev" references in user-facing files'
$publicFiles = @()
$publicFiles += Get-ChildItem -Path 'README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'LICENSE' -ErrorAction SilentlyContinue
$publicFiles += Get-ChildItem -Path 'docs' -Recurse -Include '*.md', '*.html' -ErrorAction SilentlyContinue
$publicFiles += Get-ChildItem -Path '.github' -Recurse -Include '*.md', '*.yml', '*.yaml' -ErrorAction SilentlyContinue

# Whitelist: docs that explicitly document the dev->public flow are
# allowed to name the dev repo. The script itself is also exempt.
$forbiddenWhitelist = @(
    'docs\RELEASE-PROCESS.md'
    'scripts\preflight-public-push.ps1'
)

$forbiddenHits = @()
foreach ($f in $publicFiles) {
    $rel = $f.FullName.Substring($repoRoot.Path.Length + 1)
    if ($forbiddenWhitelist -contains $rel) { continue }
    $matches = Select-String -LiteralPath $f.FullName -Pattern 'Lull-Mail-dev' -SimpleMatch -ErrorAction SilentlyContinue
    foreach ($m in $matches) {
        $forbiddenHits += "${rel}:$($m.LineNumber)"
    }
}
if ($forbiddenHits.Count -eq 0) {
    Write-Ok "No 'Lull-Mail-dev' in user-facing files"
} else {
    foreach ($h in $forbiddenHits) { Write-Fail "Found 'Lull-Mail-dev' at $h" }
}

# ---------------------------------------------------------------------------
# 2. LICENSE present, valid GPL v3
# ---------------------------------------------------------------------------
Start-Check '2. LICENSE exists and is GPL v3'
$licensePath = Join-Path $repoRoot 'LICENSE'
if (-not (Test-Path $licensePath)) {
    Write-Fail 'LICENSE file is missing at repo root'
} else {
    $licenseContent = Get-Content -LiteralPath $licensePath -Raw
    if ($licenseContent -notmatch 'GNU GENERAL PUBLIC LICENSE' -or $licenseContent -notmatch 'Version 3') {
        Write-Fail 'LICENSE does not contain GNU GENERAL PUBLIC LICENSE / Version 3 markers'
    } else {
        Write-Ok 'LICENSE is GPL v3'
    }
}

# ---------------------------------------------------------------------------
# 3. README has no "To be defined" placeholders
# ---------------------------------------------------------------------------
Start-Check '3. README has no "To be defined" placeholders'
$readmePath = Join-Path $repoRoot 'README.md'
if (-not (Test-Path $readmePath)) {
    Write-Fail 'README.md missing at repo root'
} else {
    $tbd = Select-String -LiteralPath $readmePath -Pattern 'To be defined' -SimpleMatch
    if ($tbd) {
        foreach ($t in $tbd) { Write-Fail "README has 'To be defined' on line $($t.LineNumber)" }
    } else {
        Write-Ok 'No placeholders left in README'
    }
}

# ---------------------------------------------------------------------------
# 4. Internal markdown links resolve
# ---------------------------------------------------------------------------
Start-Check '4. Internal markdown links resolve'
$mdFiles = @($readmePath) + @(Get-ChildItem -Path 'docs' -Recurse -Filter '*.md' | ForEach-Object { $_.FullName })
$brokenLinks = @()
foreach ($mdPath in $mdFiles) {
    $raw = Get-Content -LiteralPath $mdPath -Raw
    # Strip fenced code blocks (``` ... ```)
    $clean = [regex]::Replace($raw, '(?ms)^```.*?^```', '')
    # Strip inline code spans (`...`)
    $clean = [regex]::Replace($clean, '`[^`]*`', '')

    $linkMatches = [regex]::Matches($clean, '\]\(([^)\s]+?)(?:\s+"[^"]*")?\)')
    foreach ($lm in $linkMatches) {
        $target = $lm.Groups[1].Value
        # Skip external URLs, anchors, mailtos, image data URIs
        if ($target -match '^(https?:|mailto:|#|data:|tel:)') { continue }
        # Skip GitHub-relative paths (../../releases, ../../issues, ../../actions, ../../commits, ../../wiki, etc.)
        # These resolve at GitHub render time against the repo URL, not the filesystem.
        if ($target -match '^\.\./\.\./(releases|issues|actions|commits|pulls|wiki|discussions|graphs|network|tags|labels|projects|milestones|security|blob|tree|raw)') { continue }
        # Strip URL fragments (file.md#section -> file.md)
        $cleanTarget = ($target -split '#')[0]
        if ([string]::IsNullOrEmpty($cleanTarget)) { continue }
        $resolved = Join-Path (Split-Path $mdPath -Parent) $cleanTarget
        if (-not (Test-Path -LiteralPath $resolved)) {
            $rel = $mdPath.Substring($repoRoot.Path.Length + 1)
            $brokenLinks += "$rel : -> $target"
        }
    }
}
if ($brokenLinks.Count -eq 0) {
    Write-Ok "All internal markdown links resolve ($($mdFiles.Count) file(s) scanned)"
} else {
    foreach ($b in $brokenLinks) { Write-Fail "Broken link in $b" }
}

# ---------------------------------------------------------------------------
# 5. Required community-health files
# ---------------------------------------------------------------------------
Start-Check '5. Required community-health files exist'
$required = 'LICENSE', 'README.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md'
foreach ($r in $required) {
    if (Test-Path (Join-Path $repoRoot $r)) {
        Write-Ok "$r present"
    } else {
        Write-Fail "$r missing at repo root"
    }
}

# ---------------------------------------------------------------------------
# 6. No private absolute paths in tracked files
# ---------------------------------------------------------------------------
Start-Check '6. No private absolute paths leaking in tracked files'
$privatePatterns = @('Données Utilisateur', 'C:\\\\Users\\\\Alexis', 'd:\\\\Donn')
$privateHits = @()
$scanFiles = @()
$scanFiles += $publicFiles
$scanFiles += Get-ChildItem -Path 'src', 'frontend', 'tests', 'scripts' -Recurse -Include '*.py', '*.js', '*.md', '*.html', '*.bat', '*.sh', '*.ps1', '*.iss' -ErrorAction SilentlyContinue
foreach ($f in $scanFiles | Sort-Object FullName -Unique) {
    foreach ($pat in $privatePatterns) {
        $hits = Select-String -LiteralPath $f.FullName -Pattern $pat -ErrorAction SilentlyContinue
        foreach ($h in $hits) {
            $privateHits += "$($f.FullName.Substring($repoRoot.Path.Length + 1)):$($h.LineNumber) -> $pat"
        }
    }
}
if ($privateHits.Count -eq 0) {
    Write-Ok "No private absolute paths found"
} else {
    foreach ($h in $privateHits) { Write-Fail "Private path: $h" }
}

# ---------------------------------------------------------------------------
# 7. Workflow + issue-template slug sanity
# ---------------------------------------------------------------------------
Start-Check '7. Workflow + issue-template slugs point to public repo'
$slugFiles = @(
    Join-Path $repoRoot '.github\workflows\release.yml'
    Join-Path $repoRoot '.github\workflows\ci.yml'
    Join-Path $repoRoot '.github\ISSUE_TEMPLATE\config.yml'
)
foreach ($sf in $slugFiles) {
    if (-not (Test-Path $sf)) { continue }
    $devHits = Select-String -LiteralPath $sf -Pattern 'Lull-Mail-dev' -SimpleMatch
    if ($devHits) {
        foreach ($d in $devHits) { Write-Fail "$($sf.Substring($repoRoot.Path.Length + 1)):$($d.LineNumber) references 'Lull-Mail-dev'" }
    } else {
        Write-Ok "$($sf.Substring($repoRoot.Path.Length + 1)) clean"
    }
}

# ---------------------------------------------------------------------------
# 8. Asset existence for README image references
# ---------------------------------------------------------------------------
Start-Check '8. README asset references resolve'
$readmeRaw = Get-Content -LiteralPath $readmePath -Raw
$assetPatterns = @(
    '<img[^>]+src="([^"]+)"',
    '!\[[^\]]*\]\(([^)\s]+)\)'
)
$missingAssets = @()
foreach ($pat in $assetPatterns) {
    $assetMatches = [regex]::Matches($readmeRaw, $pat)
    foreach ($am in $assetMatches) {
        $src = $am.Groups[1].Value
        if ($src -match '^(https?:|data:)') { continue }
        $resolved = Join-Path $repoRoot $src
        if (-not (Test-Path -LiteralPath $resolved)) {
            $missingAssets += $src
        }
    }
}
if ($missingAssets.Count -eq 0) {
    Write-Ok "All assets present"
} else {
    foreach ($m in $missingAssets) { Write-Fail "Missing asset: $m" }
}

# ---------------------------------------------------------------------------
# 9. Online check (shields.io URLs return 200)
# ---------------------------------------------------------------------------
if ($Online) {
    Start-Check '9. shields.io badge URLs return 200 (online)'
    $shieldUrls = ([regex]::Matches($readmeRaw, 'https?://img\.shields\.io/[^\s)\]"]+') | ForEach-Object { $_.Value } | Sort-Object -Unique)
    foreach ($url in $shieldUrls) {
        try {
            $resp = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -TimeoutSec 10
            if ($resp.StatusCode -eq 200) {
                Write-Ok "$url"
            } else {
                Write-Fail "$url -> HTTP $($resp.StatusCode)"
            }
        } catch {
            Write-Fail "$url -> $($_.Exception.Message)"
        }
    }
} else {
    Write-Host ""
    Write-Host "==> 9. shields.io badge URLs (skipped; pass -Online to enable)" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host ("=" * 60) -ForegroundColor DarkGray
if ($failures.Count -eq 0) {
    Write-Host "PASS - $checksRun checks ran, no failures." -ForegroundColor Green
    exit 0
} else {
    Write-Host "FAIL - $($failures.Count) failure(s) across $checksRun checks:" -ForegroundColor Red
    foreach ($f in $failures) { Write-Host "  - $f" -ForegroundColor Red }
    exit 1
}
