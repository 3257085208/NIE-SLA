#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Config = @{
    ApiBase  = if ($env:NIE_SLA_API_BASE) { $env:NIE_SLA_API_BASE } else { "https://status.example.com" }
    Token    = $env:NIE_SLA_AGENT_TOKEN
    AgentId  = if ($env:NIE_SLA_AGENT_ID) { $env:NIE_SLA_AGENT_ID } else { $env:COMPUTERNAME }
    Interval = 300
}
if (-not $Config.Token) { Write-Host "[ERR] NIE_SLA_AGENT_TOKEN is required" -ForegroundColor Red; exit 1 }
$Config.ApiBase = $Config.ApiBase.TrimEnd('/')
$StateDir = Join-Path $env:ProgramData "NIE-SLA"
if (-not (Test-Path $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
$QueueFile = Join-Path $StateDir "samples-queue.json"

function Get-SystemMetrics {
    $cpu = [math]::Round((Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average, 2)
    $os = Get-CimInstance Win32_OperatingSystem
    $totalMem = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
    $freeMem = [math]::Round($os.FreePhysicalMemory / 1MB, 2)
    $usedMem = [math]::Round($totalMem - $freeMem, 2)
    $memPct = if ($totalMem -gt 0) { [math]::Round($usedMem / $totalMem * 100, 2) } else { 0 }
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
        ForEach-Object { [math]::Round($_.Size,0) } | Measure-Object -Sum
    $diskTotal = [math]::Round($disk.Sum / 1GB, 2)
    $diskFree = (Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
        ForEach-Object { [math]::Round($_.FreeSpace,0) } | Measure-Object -Sum).Sum
    $diskUsed = $diskTotal - [math]::Round($diskFree / 1GB, 2)
    $diskPct = if ($diskTotal -gt 0) { [math]::Round($diskUsed / $diskTotal * 100, 2) } else { 0 }
    $load = [math]::Round($cpu / 100 * [Environment]::ProcessorCount, 2)
    $procs = (Get-Process).Count
    return @{
        ts = [int][double]::Parse((Get-Date -UFormat %s))
        cpu = $cpu; mem = $memPct; disk = $diskPct; load = $load
        process_count = $procs
        net_rx = 0; net_tx = 0; tcp_conns = 0; udp_conns = 0
        disk_read = 0; disk_write = 0
    }
}

function Send-Metrics {
    param([array]$Samples)
    $latest = $Samples[-1]
    $body = @{
        agent_id = $Config.AgentId
        agent_label = $Config.AgentId
        agent_version = "ps1-1.0"
        metrics = @{
            hostname = $env:COMPUTERNAME
            process_count = $latest.process_count
            thread_count = 0
            cpu_percent = $latest.cpu
            memory = @{ total_mb = 0; used_mb = 0; percent = $latest.mem }
            load = @{ load1 = $latest.load; load5 = 0; load15 = 0 }
            disk = @{ total_gb = 0; used_gb = 0; avail_gb = 0; percent = $latest.disk }
            net = @{ rx_bytes_sec = $latest.net_rx; tx_bytes_sec = $latest.net_tx; rx_bytes = 0; tx_bytes = 0; tcp_conns = $latest.tcp_conns; udp_conns = $latest.udp_conns }
            diskio = @{ read_bytes_sec = $latest.disk_read; write_bytes_sec = $latest.disk_write }
            uptime_sec = 0
            samples = $Samples
        }
    } | ConvertTo-Json -Depth 10 -Compress
    $headers = @{ "Authorization" = "Bearer $($Config.Token)"; "Content-Type" = "application/json" }
    try {
        $res = Invoke-RestMethod -Uri "$($Config.ApiBase)/api/agent/metrics" -Method Post -Headers $headers -Body $body -TimeoutSec 30
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] OK ($($Samples.Count) samples)"
        return $true
    } catch {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] FAIL: $_" -ForegroundColor Red
        return $false
    }
}

Write-Host "NIE-SLA Windows Agent started (Agent: $($Config.AgentId))"
$buffer = [System.Collections.Generic.List[hashtable]]::new()
$lastSend = [DateTime]::MinValue
while ($true) {
    $sample = Get-SystemMetrics
    $buffer.Add($sample)
    $elapsed = ((Get-Date) - $lastSend).TotalSeconds
    if ($buffer.Count -ge 1 -and $elapsed -ge $Config.Interval) {
        Send-Metrics -Samples $buffer.ToArray() | Out-Null
        $buffer.Clear()
        $lastSend = Get-Date
    }
    Start-Sleep -Seconds 1
}
