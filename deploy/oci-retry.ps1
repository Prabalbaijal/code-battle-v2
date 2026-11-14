# Keeps asking Oracle for the free ARM server until it gets one (Mumbai's Always Free pool is often
# full). Needs the OCI CLI set up (`oci setup config`, API key uploaded) and the SSH *public* key.
#
#   powershell -ExecutionPolicy Bypass -File deploy\oci-retry.ps1 -SshPublicKey C:\path\to\ssh-key.pub
#   options: -Ocpus 1 -MemoryGb 6 (default; smallest fits gaps best, resize later) -IntervalSec 90
#
# Safe: it only ever launches VM.Standard.A1.Flex (Always Free), and the quota policy in your account
# blocks anything paid anyway. Retries on "out of capacity", rate limits, 5xx and network drops;
# stops by itself on success or on any other error.
param(
  [Parameter(Mandatory = $true)][string]$SshPublicKey,
  [int]$Ocpus = 1,
  [int]$MemoryGb = 6,
  [int]$BootGb = 100,
  [int]$IntervalSec = 90,
  [string]$Name = 'code-battle'
)
# Continue, not Stop: in Windows PowerShell 5.1, Stop turns every line oci prints on stderr (like the
# "out of capacity" reply we retry on) into a fatal error. Real failures `throw` explicitly below.
$ErrorActionPreference = 'Continue'
$env:SUPPRESS_LABEL_WARNING = 'True'
if (-not (Test-Path $SshPublicKey)) { throw "SSH public key not found: $SshPublicKey" }
if ((Get-Content $SshPublicKey -Raw) -notmatch '^ssh-') { throw "$SshPublicKey doesn't look like a public key (should start with ssh-rsa or ssh-ed25519)" }

if (-not (Get-Command oci -ErrorAction SilentlyContinue)) {
  # pip install into a venv (DEPLOY.md) leaves oci.exe off PATH
  foreach ($dir in "$env:USERPROFILE\oci-cli\Scripts", "$env:USERPROFILE\bin") {
    if (Test-Path "$dir\oci.exe") { $env:PATH = "$dir;$env:PATH"; break }
  }
  if (-not (Get-Command oci -ErrorAction SilentlyContinue)) { throw 'OCI CLI not found: install it first (DEPLOY.md, A1)' }
}
if (-not (Test-Path "$env:USERPROFILE\.oci\config")) { throw 'No ~/.oci/config: run `oci setup config` first' }
$config = Get-Content "$env:USERPROFILE\.oci\config" -Raw
$tenancy = ([regex]'(?m)^tenancy\s*=\s*(\S+)').Match($config).Groups[1].Value
if (-not $tenancy) { throw 'No tenancy in ~/.oci/config: run `oci setup config` first' }

$existing = oci compute instance list --compartment-id $tenancy --display-name $Name `
  --lifecycle-state RUNNING --query 'data[0].id' --raw-output 2>$null
if ($existing) { Write-Host "An instance named '$Name' is already running ($existing): nothing to do." -ForegroundColor Green; exit 0 }

Write-Host 'Looking up the availability domain, image and subnet...'
$ad = oci iam availability-domain list --compartment-id $tenancy --query 'data[0].name' --raw-output
$image = oci compute image list --compartment-id $tenancy --operating-system 'Canonical Ubuntu' `
  --operating-system-version '24.04' --shape 'VM.Standard.A1.Flex' --sort-by TIMECREATED --sort-order DESC `
  --query 'data[0].id' --raw-output
if (-not $ad -or $ad -notmatch 'AD-') { throw "Couldn't read the availability domain (is the API key uploaded?): $ad" }
if (-not $image -or $image -notmatch '^ocid1\.image') { throw "No Ubuntu 24.04 ARM image found: $image" }
# A public subnet; prefer one whose name contains $Name (e.g. "public subnet-code-battle").
# JSON parsing instead of --query: Windows PowerShell 5.1 mangles quoted JMESPath keys like "display-name".
$subnets = @((oci network subnet list --compartment-id $tenancy --all | Out-String | ConvertFrom-Json).data |
  Where-Object { -not $_.'prohibit-public-ip-on-vnic' -and $_.'lifecycle-state' -eq 'AVAILABLE' })
$pick = @($subnets | Where-Object { $_.'display-name' -like "*$Name*" }) + $subnets | Select-Object -First 1
if (-not $pick) { throw 'No public subnet: create the network first (Networking > Virtual cloud networks > Start VCN Wizard)' }
$subnet = $pick.id
Write-Host "  subnet name: $($pick.'display-name')"
Write-Host "  AD: $ad`n  image: $image`n  subnet: $subnet"

$shape = Join-Path $env:TEMP 'cb-shape.json'
@{ ocpus = $Ocpus; memoryInGBs = $MemoryGb } | ConvertTo-Json | Set-Content -Encoding ascii $shape

$try = 0
while ($true) {
  $try++
  $stamp = Get-Date -Format 'HH:mm:ss'
  $out = oci compute instance launch --compartment-id $tenancy --availability-domain $ad `
    --shape 'VM.Standard.A1.Flex' --shape-config "file://$shape" --image-id $image --subnet-id $subnet `
    --assign-public-ip true --display-name $Name --ssh-authorized-keys-file $SshPublicKey `
    --boot-volume-size-in-gbs $BootGb --no-retry 2>&1 | Out-String
  # --no-retry: one attempt per call. The CLI's own retries burst on 500s and get us rate limited (429).
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[$stamp] Got it on try $try!" -ForegroundColor Green
    $id = ($out | ConvertFrom-Json).data.id
    Write-Host 'Waiting for it to start and get a public IP...'
    Start-Sleep 90
    $ip = (oci compute instance list-vnics --instance-id $id | Out-String | ConvertFrom-Json).data[0].'public-ip'
    Write-Host "Public IP: $ip   (ssh -i <your private key> ubuntu@$ip)" -ForegroundColor Green
    break
  }
  # Read Oracle's own fields; a bare '429' could also appear inside a request id or a timestamp.
  $status = ([regex]'"status":\s*(\d+)').Match($out).Groups[1].Value
  $msg = ([regex]'"message":\s*"([^"]*)"').Match($out).Groups[1].Value
  if ($out -match 'Out of host capacity|OutOfCapacity|out of capacity') {
    Write-Host "[$stamp] try ${try}: out of capacity ($msg), retrying in about $IntervalSec s"
    Start-Sleep ($IntervalSec + (Get-Random -Maximum 30))
    continue
  }
  if ($status -eq '429' -or $out -match '"code":\s*"TooManyRequests"') {
    Write-Host "[$stamp] try ${try}: rate limited by Oracle ($msg), waiting 5 minutes"
    Start-Sleep 300
    continue
  }
  if ($status -match '^5\d\d$') {
    # other temporary server-side errors: keep trying, but say what they were
    Write-Host "[$stamp] try ${try}: Oracle error $status ($msg), retrying in about $IntervalSec s"
    Start-Sleep ($IntervalSec + (Get-Random -Maximum 30))
    continue
  }
  if (-not $status -and $out -match 'timed out|RequestException|ConnectionError|Max retries exceeded|NewConnectionError|NameResolution|getaddrinfo|Connection (reset|aborted|refused)') {
    # our side: Wi-Fi dropped, the laptop slept, DNS hiccup. The launch may still have gone through, so
    # look for the instance before asking again.
    Write-Host "[$stamp] try ${try}: network problem ($msg), checking again in 2 minutes"
    Start-Sleep 120
    $list = oci compute instance list --compartment-id $tenancy --display-name $Name 2>$null | Out-String
    $made = $null
    if ($list.Trim()) {
      try {
        $made = (($list | ConvertFrom-Json).data |
          Where-Object { $_.'lifecycle-state' -in 'PROVISIONING', 'STARTING', 'RUNNING' } |
          Select-Object -First 1).id
      } catch { $made = $null }
    }
    if ($made) {
      Write-Host "An instance named '$Name' exists after all ($made). Find its public IP in the Oracle console." -ForegroundColor Green
      break
    }
    continue
  }
  Write-Host "[$stamp] Stopped on an unexpected error (not capacity):" -ForegroundColor Red
  Write-Host $out
  break
}
