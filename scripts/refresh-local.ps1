# Data refresh on the owner's computer, for as long as GURS refuses GitHub's runners.
#
# GURS still serves this computer, so it downloads the sales and builds the site data here,
# uploads them to the release site-data, records the new state in the repository and lets
# GitHub publish the site. Once a month it also rebuilds the valuation table.
#
# Runs daily from Task Scheduler in its own clone (scripts/install-local-refresh.ps1).
# Logs go next to that clone, in ..\logs. Kept ASCII so Windows PowerShell 5.1 reads it right.
param(
    [switch]$Force,            # build and publish even when GURS has nothing new
    [int]$ValuationDays = 28   # the valuation export is 1 GB, so it is not worth fetching weekly
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$logs = Join-Path (Split-Path -Parent $repo) 'logs'
New-Item -ItemType Directory -Force $logs | Out-Null
Get-ChildItem $logs -Filter *.log | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item
Start-Transcript -Path (Join-Path $logs ('{0:yyyy-MM-dd_HHmm}.log' -f (Get-Date))) | Out-Null

# Native tools report on stderr; only the exit code says whether they failed.
# Plain $args, so flags like -m or --clobber reach the tool instead of PowerShell's binder,
# and always a list, because splatting a lone string does not pass it as one argument.
function Run {
    $exe = $args[0]
    $rest = @($args | Select-Object -Skip 1)
    $ErrorActionPreference = 'Continue'
    & $exe @rest 2>&1 | ForEach-Object { "$_" }
    if ($LASTEXITCODE -ne 0) { throw "$exe $($rest -join ' ') ended with code $LASTEXITCODE" }
}

function Succeeds {
    $exe = $args[0]
    $rest = @($args | Select-Object -Skip 1)
    $ErrorActionPreference = 'Continue'
    & $exe @rest 2>&1 | Out-Null
    return $LASTEXITCODE -eq 0
}

try {
    Set-Location $repo
    $env:PYTHONUTF8 = '1'
    $python = (Get-Command python).Source
    Run git pull --ff-only

    Run gh release download valuation --dir data/valuation --clobber
    $valuation = Get-Content data/valuation/valuation.json -Raw | ConvertFrom-Json
    $age = ((Get-Date) - [datetime]::ParseExact($valuation.date, 'yyyyMMdd', $null)).Days
    if ($age -gt $ValuationDays) {
        "Valuation table is $age days old, rebuilding it"
        Run $python -m pipeline.valuation
        $tables = (Get-ChildItem data/valuation).FullName
        Run gh release upload valuation @tables --clobber
    }

    $check = Run $python -m pipeline.check
    $check
    if (-not ($check -match '^changed=true') -and -not $Force) {
        'GURS has nothing new'
        return
    }

    Run $python -m pipeline.download
    Run $python -m pipeline.build

    if (-not (Succeeds gh release view site-data)) {
        Run gh release create site-data --title 'Podatki za stran' --notes 'Podatki za objavo strani, zgrajeni na lastnikovem racunalniku, dokler GURS ne sprejema zahtev z GitHuba. Vir: Geodetska uprava RS, CC BY 4.0.'
    }
    $data = (Get-ChildItem web/data/*.json).FullName
    Run gh release upload site-data @data --clobber

    Run git add status/latest.json
    if (-not (Succeeds git diff --cached --quiet)) {
        Run git commit -m "Nova razli$([char]0x010D)ica podatkov GURS"
        Run git push
    }

    Run gh workflow run refresh.yml --ref main -f force=true
    'Published, GitHub is deploying the site'
}
catch {
    Write-Output "FAILED: $_"
    $failed = $true
}
finally {
    Stop-Transcript | Out-Null
}
if ($failed) { exit 1 }
