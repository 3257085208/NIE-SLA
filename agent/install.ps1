param(
  [string]$Api = $env:NSTATUS_API_BASE,
  [string]$Token = $env:NSTATUS_AGENT_TOKEN,
  [string]$AgentId = $env:NSTATUS_AGENT_ID,
  [string]$AgentLabel = $env:NSTATUS_AGENT_LABEL,
  [string]$PingTargets = $(if ($env:NSTATUS_PING_TARGETS) { $env:NSTATUS_PING_TARGETS } else { "*" }),
  [string]$PingSec = $(if ($env:NSTATUS_PING_SEC) { $env:NSTATUS_PING_SEC } else { "20" }),
  [string]$DownloadBase = $(if ($env:DOWNLOAD_BASE) { $env:DOWNLOAD_BASE } else { "https://your-domain.com" }),
  [string]$InstallDir = $(Join-Path $env:ProgramData "NStatus"),
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "NStatusMetrics"
$DefaultSha256SumsSha256 = "e9ca6fa4a31f91efaacfc8e3dfcf65c524f1a2e8c5024babc6b67883b46a58be"

function Need-Value($Value, $Prompt) {
  if ($Value) { return $Value }
  $entered = Read-Host $Prompt
  if (-not $entered) { throw "$Prompt is required" }
  return $entered
}

function Get-ExpectedSha256($DownloadBase, $FileName) {
  if ($env:NSTATUS_EXPECTED_SHA256) { return $env:NSTATUS_EXPECTED_SHA256.Trim() }
  $checksumsUrl = "$($DownloadBase.TrimEnd('/'))/bin/SHA256SUMS"
  $checksumsFile = Join-Path $env:TEMP "nstatus-SHA256SUMS-$PID"
  Invoke-WebRequest -Uri $checksumsUrl -OutFile $checksumsFile -UseBasicParsing
  $expectedManifest = $(if ($env:NSTATUS_SHA256SUMS_SHA256) { $env:NSTATUS_SHA256SUMS_SHA256.Trim() } else { $DefaultSha256SumsSha256 })
  try {
    $actualManifest = (Get-FileHash -Algorithm SHA256 -LiteralPath $checksumsFile).Hash.ToLowerInvariant()
    if ($actualManifest -ne $expectedManifest.ToLowerInvariant()) {
      throw "Checksum manifest verification failed. Expected $expectedManifest, got $actualManifest"
    }
    $checksums = Get-Content -LiteralPath $checksumsFile -Raw
  } finally {
    Remove-Item -LiteralPath $checksumsFile -Force -ErrorAction SilentlyContinue
  }
  foreach ($line in ($checksums -split "`n")) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Length -ge 2 -and $parts[1] -eq "bin/$FileName") { return $parts[0] }
  }
  throw "Missing checksum for $FileName"
}

function Test-Sha256($Path, $Expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "Checksum mismatch for $Path. Expected $Expected, got $actual"
  }
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "NStatus Agent removed"
  exit 0
}

$Api = (Need-Value $Api "NSTATUS API URL").TrimEnd("/")
$Token = Need-Value $Token "Agent token"
if (-not $AgentId) { $AgentId = $env:COMPUTERNAME }
if (-not $AgentLabel) { $AgentLabel = $AgentId }
$ProtectedToken = ConvertFrom-SecureString (ConvertTo-SecureString -String $Token -AsPlainText -Force)

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$ExePath = Join-Path $InstallDir "nstatus-metrics.exe"
$RunPath = Join-Path $InstallDir "run-agent.ps1"
$FileName = "nstatus-metrics-windows-amd64.exe"
$Url = "$($DownloadBase.TrimEnd('/'))/bin/$FileName"

Write-Host "Downloading $Url"
Invoke-WebRequest -Uri $Url -OutFile $ExePath -UseBasicParsing
$ExpectedSha256 = Get-ExpectedSha256 $DownloadBase $FileName
Test-Sha256 $ExePath $ExpectedSha256
Write-Host "SHA256 checksum verified"

@"
`$env:NSTATUS_API_BASE = "$Api"
`$secureToken = ConvertTo-SecureString "$ProtectedToken"
`$tokenPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(`$secureToken)
try {
  `$env:NSTATUS_AGENT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(`$tokenPtr)
} finally {
  if (`$tokenPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR(`$tokenPtr) }
}
`$env:NSTATUS_AGENT_ID = "$AgentId"
`$env:NSTATUS_AGENT_LABEL = "$AgentLabel"
`$env:NSTATUS_INTERVAL_SEC = "300"
`$env:NSTATUS_SAMPLE_SEC = "1"
`$env:NSTATUS_PING_SEC = "$PingSec"
`$env:NSTATUS_PING_TARGETS = "$PingTargets"
& "$ExePath"
"@ | Set-Content -LiteralPath $RunPath -Encoding UTF8

$Action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy RemoteSigned -File `"$RunPath`""
$Trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel LeastPrivilege
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Days 3650)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "NStatus Agent installed"
Write-Host "Version: $(& $ExePath --version)"
Write-Host "Status:  Get-ScheduledTask -TaskName $TaskName"
Write-Host "Logs:    Event Viewer > Windows Logs > Application, or run $RunPath manually"
