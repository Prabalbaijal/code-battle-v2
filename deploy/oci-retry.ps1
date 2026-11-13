# Keeps asking Oracle for the free ARM server until it gets one (Mumbai's Always Free pool is often
# full). Needs the OCI CLI set up (`oci setup config`, API key uploaded) and the SSH *public* key.
#
#   powershell -ExecutionPolicy Bypass -File deploy\oci-retry.ps1 -SshPublicKey C:\path\to\ssh-key.pub
#   options: -Ocpus 1 -MemoryGb 6 (default; smallest fits gaps best, resize later) -IntervalSec 90
#
# Safe: it only ever launches VM.Standard.A1.Flex (Always Free), and the quota policy in your account
# blocks anything paid anyway. Stops by itself on success or on any error other than "out of capacity".
param(
  [Parameter(Mandatory = $true)][string]$SshPublicKey,
  [int]$Ocpus = 1,
  [int]$MemoryGb = 6,
  [int]$BootGb = 100,
  [int]$IntervalSec = 90,
  [string]$Name = 'code-battle'
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $SshPublicKey)) { throw "SSH public key not found: $SshPublicKey" }
if ((Get-Content $SshPublicKey -Raw) -notmatch '^ssh-') { throw "$SshPublicKey doesn't look like a public key (should start with ssh-rsa or ssh-ed25519)" }

$config = Get-Content "$env:USERPROFILE\.oci\config" -Raw
$tenancy = ([regex]'(?m)^tenancy\s*=\s*(\S+)').Match($config).Groups[1].Value
if (-not $tenancy) { throw 'No tenancy in ~/.oci/config: run `oci setup config` first' }

Write-Host 'Looking up the availability domain, image and subnet...'
$ad = oci iam availability-domain list --compartment-id $tenancy --query 'data[0].name' --raw-output
$image = oci compute image list --compartment-id $tenancy --operating-system 'Canonical Ubuntu' `
  --operating-system-version '24.04' --shape 'VM.Standard.A1.Flex' --sort-by TIMECREATED --sort-order DESC `
  --query 'data[0].id' --raw-output
$subnet = oci network subnet list --compartment-id $tenancy --query 'data[0].id' --raw-output
if (-not $subnet) { throw 'No subnet: create the network first (Networking > Virtual cloud networks > Start VCN Wizard)' }
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
    --boot-volume-size-in-gbs $BootGb 2>&1 | Out-String
  if ($LASTEXITCODE -eq 0) {
    Write-Host "[$stamp] Got it on try $try!" -ForegroundColor Green
    $id = ($out | ConvertFrom-Json).data.id
    Write-Host 'Waiting for it to start and get a public IP...'
    Start-Sleep 90
    $ip = oci compute instance list-vnics --instance-id $id --query 'data[0].\"public-ip\"' --raw-output
    Write-Host "Public IP: $ip   (ssh -i <your private key> ubuntu@$ip)" -ForegroundColor Green
    break
  }
  if ($out -match 'Out of host capacity|OutOfCapacity|out of capacity') {
    Write-Host "[$stamp] try ${try}: out of capacity, retrying in $IntervalSec s"
    Start-Sleep ($IntervalSec + (Get-Random -Maximum 30))
    continue
  }
  if ($out -match 'TooManyRequests|429') {
    Write-Host "[$stamp] try ${try}: rate limited by Oracle, waiting 5 minutes"
    Start-Sleep 300
    continue
  }
  Write-Host "[$stamp] Stopped on an unexpected error (not capacity):" -ForegroundColor Red
  Write-Host $out
  break
}
