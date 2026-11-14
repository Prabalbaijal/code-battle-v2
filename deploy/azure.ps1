# Turn the Azure demo server on before an interview and off after it, so the student credit lasts.
#
#   powershell -ExecutionPolicy Bypass -File deploy\azure.ps1 up       # ~5 min: SSD, IP, start, wait for the site
#   powershell -ExecutionPolicy Bypass -File deploy\azure.ps1 down     # ~2 min: stop, delete the IP, disk to HDD
#   powershell -ExecutionPolicy Bypass -File deploy\azure.ps1 status
#
# Off, the server costs only its disk on HDD (~$3.3/month): the VM is deallocated (no compute bill) and
# the public IP is deleted ($3.65/month saved). `up` recreates the IP with the same DNS label, so the
# address stays https://<label>.<region>.cloudapp.azure.com. Needs the Azure CLI, logged in (az login).
param(
  [Parameter(Mandatory = $true, Position = 0)][ValidateSet('up', 'down', 'status')][string]$Action,
  [string]$ResourceGroup = 'code-battle-rg',
  [string]$Name = 'code-battle',
  [string]$DnsLabel = 'codebattle',
  [string]$Location = 'centralindia'
)
$ErrorActionPreference = 'Stop'
$ip = "$Name-ip"
$site = "https://$DnsLabel.$Location.cloudapp.azure.com"

$azCmd = (Get-Command az -ErrorAction SilentlyContinue).Source
if (-not $azCmd) { $azCmd = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd' }
if (-not (Test-Path $azCmd)) { throw 'Azure CLI not found: winget install Microsoft.AzureCLI' }
function az {
  # Continue here: in Windows PowerShell 5.1, Stop turns any stderr line from a native tool into a crash
  $ErrorActionPreference = 'Continue'
  $out = & $azCmd @args --only-show-errors 2>&1
  if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed:`n$out" }
  $out
}
function step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

try { az account show -o none } catch { throw 'Not logged in to Azure: run  az login --use-device-code' }

$vm = az vm show -g $ResourceGroup -n $Name -d -o json | Out-String | ConvertFrom-Json
$disk = $vm.storageProfile.osDisk.name
$nicName = ($vm.networkProfile.networkInterfaces[0].id -split '/')[-1]
$nic = az network nic show -g $ResourceGroup -n $nicName -o json | Out-String | ConvertFrom-Json
$ipConfig = $nic.ipConfigurations[0].name
$pipId = $nic.ipConfigurations[0].publicIPAddress.id

function Show-Status {
  $vm = az vm show -g $ResourceGroup -n $Name -d -o json | Out-String | ConvertFrom-Json
  $sku = az disk show -g $ResourceGroup -n $disk --query sku.name -o tsv
  Write-Host "server: $($vm.powerState)   disk: $sku   public IP: $(if ($vm.publicIps) { $vm.publicIps } else { 'none (deleted while off)' })"
  if ($vm.powerState -eq 'VM running') { Write-Host "site:   $site" }
}

switch ($Action) {
  'status' { Show-Status }

  'down' {
    step 'Stopping (deallocating) the server: no compute bill from now on'
    az vm deallocate -g $ResourceGroup -n $Name -o none
    if ($pipId) {
      $pipName = ($pipId -split '/')[-1]
      step "Deleting the public IP $pipName (saves `$3.65/month; up makes a new one with the same address)"
      az network nic ip-config update -g $ResourceGroup --nic-name $nicName -n $ipConfig --remove publicIpAddress -o none
      az network public-ip delete -g $ResourceGroup -n $pipName -o none
    }
    step 'Switching the disk to Standard HDD while off ($5.28 -> $3.31/month; your data stays)'
    az disk update -g $ResourceGroup -n $disk --sku Standard_LRS -o none
    Show-Status
    Write-Host 'Off. Run "deploy\azure.ps1 up" about 10 minutes before you need it.' -ForegroundColor Green
  }

  'up' {
    if ($vm.powerState -ne 'VM deallocated' -and $vm.powerState -ne 'VM stopped') {
      Write-Host "The server is '$($vm.powerState)'." -ForegroundColor Yellow
    }
    $sku = az disk show -g $ResourceGroup -n $disk --query sku.name -o tsv
    if ($sku -ne 'StandardSSD_LRS') {
      if ($vm.powerState -eq 'VM running') { throw 'The disk can only change type while the server is off: run down first.' }
      step 'Switching the disk back to Standard SSD (faster for the demo)'
      az disk update -g $ResourceGroup -n $disk --sku StandardSSD_LRS -o none
    }
    if (-not $pipId) {
      step "Creating a public IP with the address $DnsLabel.$Location.cloudapp.azure.com"
      try {
        az network public-ip create -g $ResourceGroup -n $ip -l $Location --sku Standard `
          --allocation-method Static --dns-name $DnsLabel -o none
      } catch {
        throw "Couldn't get the DNS name '$DnsLabel' (someone else may have taken it). Run again with -DnsLabel <another-name>, and update DOMAIN/SITE_ADDRESS in infra/prod/.env on the server.`n$_"
      }
      az network nic ip-config update -g $ResourceGroup --nic-name $nicName -n $ipConfig --public-ip-address $ip -o none
    }
    step 'Starting the server'
    az vm start -g $ResourceGroup -n $Name -o none
    step "Waiting for $site to answer (containers start by themselves, usually 2-4 minutes)"
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $ok = $false
    foreach ($i in 1..60) {
      try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 "$site/login"
        if ($r.StatusCode -eq 200) { $ok = $true; break }
      } catch { }
      Start-Sleep 10
    }
    Show-Status
    if ($ok) {
      Write-Host "Up: $site   (when you're done: deploy\azure.ps1 down)" -ForegroundColor Green
    } else {
      Write-Host "The server is on but the site isn't answering yet. Check: ssh codebattle-azure, then in code-battle-v2: sudo docker compose -f infra/compose.prod.yml --env-file infra/prod/.env ps" -ForegroundColor Yellow
    }
  }
}
