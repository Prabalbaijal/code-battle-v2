# Runs the whole Code Battle dev stack on this machine (Windows PowerShell).
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev-stack.ps1 start     # infra + every service + web
#   powershell -ExecutionPolicy Bypass -File scripts\dev-stack.ps1 status    # what's up
#   powershell -ExecutionPolicy Bypass -File scripts\dev-stack.ps1 stop      # stop the Node processes
#   options for start: -ShortMatch (60 s matches) -NoBuild (skip `pnpm build`) -Fake
#
# Default: REAL services, exactly as configured in the apps' .env files: hosted Judge0 on RapidAPI
# (apps/judge-service/.env) and real emails through Brevo (apps/notification-service/.env). The judge
# is held to the RapidAPI free plan (50 requests a day, 10 kept for matches) so tests can't overspend.
# -Fake: fake-judge0 and the fake email inbox instead (no quota, no emails; what the E2E and load
# tests expect). Logs go to .dev-logs\.
# Needs: Docker Desktop running, `pnpm install` done once, and each app's .env (copy .env.example).
param(
  [Parameter(Position = 0)][ValidateSet('start', 'stop', 'status', 'restart')][string]$Action = 'status',
  [switch]$ShortMatch,
  [switch]$NoBuild,
  [switch]$Fake,
  [int]$JudgeDailyBudget = 50,
  [int]$MatchReserveCalls = 10
)
$ErrorActionPreference = 'Continue'
$repo = Split-Path $PSScriptRoot -Parent
$apps = Join-Path $repo 'apps'
$logs = Join-Path $repo '.dev-logs'

# The processes this script starts, recognised by their exact command line (nothing else is touched).
function Get-StackProcesses {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
    $_.CommandLine -match '--env-file-if-exists=.env --import ./dist/instrument.js dist/(index|worker).js' -or
    $_.CommandLine -match 'next[\\/]dist[\\/]bin[\\/]next start --port 3000'
  }
}

function Test-Url($url) {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 $url).StatusCode -eq 200 } catch { return $false }
}

function Stop-Stack {
  $procs = @(Get-StackProcesses)
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Write-Host "stopped $($procs.Count) processes (Docker infra keeps running; stop it with: pnpm infra:down)"
}

function Show-Status {
  $procs = @(Get-StackProcesses)
  Write-Host "node processes: $($procs.Count) of 19"
  foreach ($u in 'http://localhost:8080/health/upstreams', 'http://localhost:3000/login', 'http://localhost:2358/config_info') {
    $ok = Test-Url $u
    Write-Host ("  {0,-45} {1}" -f $u, $(if ($ok) { 'OK' } else { 'down' }))
  }
}

function Start-Stack {
  if (@(Get-StackProcesses).Count -gt 0) { Write-Host 'already running: use restart, or stop first'; return }
  docker info *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Docker is not running: start Docker Desktop first' }
  foreach ($app in 'identity-service', 'user-service', 'notification-service', 'problem-service', 'judge-service',
    'battle-service', 'rating-service', 'realtime-service', 'ai-service', 'gateway') {
    if (-not (Test-Path "$apps\$app\.env")) { throw "apps\$app\.env is missing: copy apps\$app\.env.example to .env" }
  }

  Write-Host '==> infra (postgres, redis, redpanda, fake-judge0, jaeger)'
  Push-Location $repo
  docker compose -f infra/docker-compose.yml up -d --wait 2>&1 | Out-Null
  if (-not $NoBuild) {
    Write-Host '==> pnpm build (a few minutes the first time; -NoBuild skips it)'
    pnpm build *> (Join-Path $env:TEMP 'cb-build.log')
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "build failed: see $env:TEMP\cb-build.log" }
  }
  Pop-Location

  New-Item -ItemType Directory -Force $logs | Out-Null

  Write-Host '==> database migrations (each service, idempotent)'
  foreach ($dir in Get-ChildItem $apps -Directory) {
    if (-not (Test-Path "$($dir.FullName)\dist\db\migrate.js") -or -not (Test-Path "$($dir.FullName)\.env")) { continue }
    Push-Location $dir.FullName
    node --env-file-if-exists=.env dist/db/migrate.js *> "$logs\migrate-$($dir.Name).log"
    if ($LASTEXITCODE -ne 0) { Pop-Location; throw "migration failed for $($dir.Name): see $logs\migrate-$($dir.Name).log" }
    Pop-Location
  }

  function Start-Svc($app, $entry, $name, $envs = @{}) {
    foreach ($k in $envs.Keys) { Set-Item "env:$k" $envs[$k] }
    Start-Process -FilePath 'node' -ArgumentList '--env-file-if-exists=.env', '--import', './dist/instrument.js', $entry `
      -WorkingDirectory "$apps\$app" -WindowStyle Hidden `
      -RedirectStandardOutput "$logs\$name.out.log" -RedirectStandardError "$logs\$name.err.log" | Out-Null
    foreach ($k in $envs.Keys) { Remove-Item "env:$k" }
  }
  if ($Fake) {
    Write-Host '    mode: FAKE judge (fake-judge0), FAKE email inbox and FAKE AI answers'
    $judge = @{ JUDGE0_URL = 'http://localhost:2358'; JUDGE0_AUTH = 'none' }
    $mail = @{ EMAIL_PROVIDER = 'fake' }
    $ai = @{ AI_PROVIDER = 'fake'; EMBEDDINGS = 'hash' }
  } else {
    $aiEnv = if (Test-Path "$apps\ai-service\.env") { Get-Content "$apps\ai-service\.env" -Raw } else { '' }
    if ($aiEnv -notmatch '(?m)^GROQ_API_KEY=\S') {
      Write-Host '    note: no GROQ_API_KEY in apps\ai-service\.env, so the AI features stay off' -ForegroundColor Yellow
    }
    $ai = @{}
    $judgeEnv = Get-Content "$apps\judge-service\.env" -Raw
    $mailEnv = Get-Content "$apps\notification-service\.env" -Raw
    if ($judgeEnv -match '(?m)^JUDGE0_URL=\s*http://localhost' -or $judgeEnv -notmatch '(?m)^JUDGE0_API_KEY=\S') {
      throw 'Real judge: set JUDGE0_URL=https://judge0-ce.p.rapidapi.com, JUDGE0_AUTH=rapidapi and JUDGE0_API_KEY in apps\judge-service\.env (or use -Fake)'
    }
    if ($mailEnv -notmatch '(?m)^EMAIL_PROVIDER=brevo' -or $mailEnv -notmatch '(?m)^BREVO_API_KEY=\S' -or $mailEnv -notmatch '(?m)^EMAIL_FROM=\S') {
      throw 'Real email: set EMAIL_PROVIDER=brevo, BREVO_API_KEY and EMAIL_FROM in apps\notification-service\.env (or use -Fake)'
    }
    Write-Host "    mode: REAL Judge0 (budget $JudgeDailyBudget requests/day, $MatchReserveCalls kept for matches) and REAL email (Brevo)"
    $judge = @{ JUDGE0_DAILY_BUDGET = "$JudgeDailyBudget"; MATCH_RESERVE_CALLS = "$MatchReserveCalls" }
    $mail = @{}
  }
  $battle = if ($ShortMatch) { @{ MATCH_DURATION_SECONDS = '60' } } else { @{} }

  Write-Host '==> services'
  Start-Svc identity-service dist/index.js identity
  Start-Svc identity-service dist/worker.js identity-worker
  Start-Svc user-service dist/index.js user
  Start-Svc user-service dist/worker.js user-worker
  Start-Svc notification-service dist/index.js notification $mail
  Start-Svc notification-service dist/worker.js notification-worker $mail
  Start-Svc problem-service dist/index.js problem
  Start-Svc problem-service dist/worker.js problem-worker
  Start-Svc judge-service dist/index.js judge $judge
  Start-Svc judge-service dist/worker.js judge-worker $judge
  Start-Svc battle-service dist/index.js battle $battle
  Start-Svc battle-service dist/worker.js battle-worker $battle
  Start-Svc rating-service dist/index.js rating
  Start-Svc rating-service dist/worker.js rating-worker
  Start-Svc realtime-service dist/index.js realtime
  Start-Svc ai-service dist/index.js ai $ai
  Start-Svc ai-service dist/worker.js ai-worker $ai
  Start-Svc gateway dist/index.js gateway
  Start-Process -FilePath 'node' -ArgumentList 'node_modules/next/dist/bin/next', 'start', '--port', '3000' `
    -WorkingDirectory "$apps\web" -WindowStyle Hidden `
    -RedirectStandardOutput "$logs\web.out.log" -RedirectStandardError "$logs\web.err.log" | Out-Null

  Write-Host '==> waiting for the gateway and the web app'
  foreach ($i in 1..40) { if (Test-Url 'http://localhost:8080/health/upstreams') { break }; Start-Sleep 3 }
  foreach ($i in 1..20) { if (Test-Url 'http://localhost:3000/login') { break }; Start-Sleep 2 }
  Show-Status
  Write-Host "`nOpen http://localhost:3000   (logs: $logs)"
}

switch ($Action) {
  'start' { Start-Stack }
  'stop' { Stop-Stack }
  'status' { Show-Status }
  'restart' { Stop-Stack; Start-Sleep 2; Start-Stack }
}
