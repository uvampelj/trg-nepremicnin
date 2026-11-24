# One-time setup of the local data refresh: its own clone of the repository and a daily task
# in Windows Task Scheduler that runs scripts/refresh-local.ps1 from that clone.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-local-refresh.ps1
#
# The task runs as the current user, only while logged on, because gh and git keep their
# credentials in that user's keyring. A missed run starts as soon as the computer is on again.
# The clone stays out of AppData: packaged apps (such as the Claude desktop app) see a private
# copy of AppData, so a clone made from one there would be invisible to Task Scheduler.
# Remove with: Unregister-ScheduledTask -TaskName 'Kataster cen - osvezitev podatkov'
param([string]$Time = '12:30')

$ErrorActionPreference = 'Stop'
$home_ = Join-Path $env:USERPROFILE 'kataster-cen'
$repo = Join-Path $home_ 'repo'
if (-not (Test-Path $repo)) {
    git clone https://github.com/uvampelj/trg-nepremicnin.git $repo
    if ($LASTEXITCODE -ne 0) { throw 'git clone failed' }
}

$script = Join-Path $repo 'scripts\refresh-local.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Kataster cen - osvezitev podatkov' -Action $action -Trigger $trigger `
    -Settings $settings -Force `
    -Description 'Prenese posle GURS, zgradi podatke za uvampelj.github.io/trg-nepremicnin in jih objavi prek GitHuba.' | Out-Null
"Task registered: daily at $Time, clone in $repo, logs in $(Join-Path $home_ 'logs')"
