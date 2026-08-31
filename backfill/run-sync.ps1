# Task Scheduler entry point for the twice-daily BigQuery -> Supabase sync.
# STOPGAP until the Vercel cron (/api/cron/sync-daily) gets its env vars — see
# BACKEND-SETUP.md. Registered tasks: "Saadaa Sourcing Sync 6AM" (full) and
# "Saadaa Sourcing Sync 6PM" (grn only). Runs as the logged-in user via ADC.
# Logs to %LOCALAPPDATA%\saadaa-sourcing-sync\ (one file per month).
param([ValidateSet('full', 'grn')] [string]$Mode = 'full')

$logDir = Join-Path $env:LOCALAPPDATA 'saadaa-sourcing-sync'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir ("sync-{0}.log" -f (Get-Date -Format 'yyyy-MM'))
$node = 'C:\Program Files\nodejs\node.exe'

"[{0}] ===== start mode=$Mode =====" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | Add-Content $log
Set-Location $PSScriptRoot

if ($Mode -eq 'full') {
    & $node sync-daily.mjs *>> $log
    "[sync-daily exit $LASTEXITCODE]" | Add-Content $log
    & $node backfill-grn-qc.mjs *>> $log
    "[backfill-grn-qc exit $LASTEXITCODE]" | Add-Content $log
} else {
    & $node sync-daily.mjs grn *>> $log
    "[sync-daily grn exit $LASTEXITCODE]" | Add-Content $log
}

"[{0}] ===== done =====" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | Add-Content $log
