param(
  [string]$Api = $env:NSTATUS_API_BASE,
  [string]$Token = $env:NSTATUS_AGENT_TOKEN,
  [string]$AgentId = $env:NSTATUS_AGENT_ID,
  [string]$AgentLabel = $env:NSTATUS_AGENT_LABEL,
  [string]$PingTargets = $(if ($env:NSTATUS_PING_TARGETS) { $env:NSTATUS_PING_TARGETS } else { "*" }),
  [string]$PingSec = $(if ($env:NSTATUS_PING_SEC) { $env:NSTATUS_PING_SEC } else { "20" }),
  [string]$DownloadBase = $(if ($env:DOWNLOAD_BASE) { $env:DOWNLOAD_BASE } else { "https://sla.niekaixiang.com" }),
  [string]$InstallDir = $(Join-Path $env:ProgramData "NStatus"),
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$TaskName = "NStatusMetrics"
$DefaultSha256SumsSha256 = "db90eb9037185aa463926e9c3cf1428519af903b6b82c120b5669da466fac9c5"
$DefaultExpectedVersion = "v1.0.14"
$CacheKey = $(if ($env:NSTATUS_SHA256SUMS_SHA256) { $env:NSTATUS_SHA256SUMS_SHA256 -replace '[^A-Za-z0-9._-]', '' } else { [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString() })

function Need-Value($Value, $Prompt) {
  if ($Value) { return $Value }
  $entered = Read-Host $Prompt
  if (-not $entered) { throw "$Prompt 不能为空" }
  return $entered
}

function Get-ExpectedSha256($DownloadBase, $FileName) {
  if ($env:NSTATUS_EXPECTED_SHA256) { return $env:NSTATUS_EXPECTED_SHA256.Trim() }
  $checksumsUrl = "$($DownloadBase.TrimEnd('/'))/bin/SHA256SUMS?v=$CacheKey"
  $checksumsFile = Join-Path $env:TEMP "nstatus-SHA256SUMS-$PID"
  Invoke-WebRequest -Uri $checksumsUrl -OutFile $checksumsFile -UseBasicParsing
  $expectedManifest = $(if ($env:NSTATUS_SHA256SUMS_SHA256) { $env:NSTATUS_SHA256SUMS_SHA256.Trim() } else { $DefaultSha256SumsSha256 })
  try {
    $actualManifest = (Get-FileHash -Algorithm SHA256 -LiteralPath $checksumsFile).Hash.ToLowerInvariant()
    if ($actualManifest -ne $expectedManifest.ToLowerInvariant()) {
      throw "校验清单验证失败。期望 $expectedManifest，实际 $actualManifest"
    }
    $checksums = Get-Content -LiteralPath $checksumsFile -Raw
  } finally {
    Remove-Item -LiteralPath $checksumsFile -Force -ErrorAction SilentlyContinue
  }
  foreach ($line in ($checksums -split "`n")) {
    $parts = $line.Trim() -split '\s+'
    if ($parts.Length -ge 2 -and ($parts[1] -eq $FileName -or $parts[1] -eq "bin/$FileName")) { return $parts[0] }
  }
  throw "校验清单中缺少 $FileName"
}

function Test-Sha256($Path, $Expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    throw "$Path 的 SHA-256 不匹配。期望 $Expected，实际 $actual"
  }
}

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "聶.NET Agent 已卸载"
  exit 0
}

$Api = (Need-Value $Api "NSTATUS API URL").TrimEnd("/")
$Token = Need-Value $Token "Agent Token"
if (-not $AgentId) { $AgentId = $env:COMPUTERNAME }
if (-not $AgentLabel) { $AgentLabel = $AgentId }
$ProtectedToken = ConvertFrom-SecureString (ConvertTo-SecureString -String $Token -AsPlainText -Force)

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$ExePath = Join-Path $InstallDir "nstatus-metrics.exe"
$RunPath = Join-Path $InstallDir "run-agent.ps1"
$FileName = "nstatus-metrics-windows-amd64.exe"
$Url = "$($DownloadBase.TrimEnd('/'))/bin/$FileName?v=$CacheKey"
$DownloadPath = "$ExePath.download-$PID.exe"

Write-Host "正在下载 $Url"
try {
  Invoke-WebRequest -Uri $Url -OutFile $DownloadPath -UseBasicParsing
  $ExpectedSha256 = Get-ExpectedSha256 $DownloadBase $FileName
  Test-Sha256 $DownloadPath $ExpectedSha256
  $ExpectedVersion = $(if ($env:NSTATUS_EXPECTED_VERSION) { $env:NSTATUS_EXPECTED_VERSION.Trim() } else { $DefaultExpectedVersion })
  $DownloadedVersion = & $DownloadPath --version
  if ($ExpectedVersion -and "$DownloadedVersion" -notlike "*$ExpectedVersion*") {
    throw "Agent 版本不匹配。期望 $ExpectedVersion，实际 $DownloadedVersion"
  }
  Write-Host "SHA-256 与版本校验通过：$DownloadedVersion"
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  Move-Item -LiteralPath $DownloadPath -Destination $ExePath -Force
} finally {
  Remove-Item -LiteralPath $DownloadPath -Force -ErrorAction SilentlyContinue
}

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
# Prefer boot-time SYSTEM task so headless VPS stays online without interactive login.
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$Triggers = @(New-ScheduledTaskTrigger -AtStartup)
try { $Triggers += New-ScheduledTaskTrigger -AtLogOn } catch {}
if ($isAdmin) {
  $Principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
} else {
  Write-Warning "Not running as Administrator; falling back to current-user AtLogOn task (may go offline after reboot until login)."
  $Triggers = @(New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)
  $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel LeastPrivilege
}
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Triggers -Principal $Principal -Settings $Settings -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "聶.NET Agent 安装完成"
Write-Host "Note: scheduled task (AtStartup/SYSTEM when elevated), not a full Windows Service SCM entry."
Write-Host "版本：$(& $ExePath --version)"
Write-Host "状态：Get-ScheduledTask -TaskName $TaskName"
Write-Host "日志：事件查看器 > Windows 日志 > 应用程序，或手动运行 $RunPath"
