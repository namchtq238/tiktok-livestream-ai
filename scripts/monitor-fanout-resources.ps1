# Monitor FFmpeg + Node resources for fanout runner.
# Prints 1 summary line every N seconds. Use during long-running stability tests.
# Ctrl+C to stop. No external deps.
# Docs: ../docs/requirements/note10-test-fanout-without-tiktok.md

param(
    [int]$IntervalSeconds = 60,
    [switch]$ShowPerProcess
)

Write-Host "Fanout Resource Monitor"
Write-Host "  interval:  $IntervalSeconds seconds"
Write-Host "  processes: ffmpeg, node"
Write-Host "  per-proc:  $ShowPerProcess"
Write-Host "  Ctrl+C to stop"
Write-Host "----"

while ($true) {
    $now = Get-Date -Format "HH:mm:ss"

    $ffmpeg = @(Get-Process ffmpeg -ErrorAction SilentlyContinue)
    $node = @(Get-Process node -ErrorAction SilentlyContinue)

    $ffCount = $ffmpeg.Count
    $ffRam = if ($ffCount -gt 0) { [math]::Round((($ffmpeg | Measure-Object WorkingSet -Sum).Sum) / 1MB, 1) } else { 0 }
    $ffCpu = if ($ffCount -gt 0) { [math]::Round((($ffmpeg | Measure-Object CPU -Sum).Sum), 1) } else { 0 }

    $nodeCount = $node.Count
    $nodeRam = if ($nodeCount -gt 0) { [math]::Round((($node | Measure-Object WorkingSet -Sum).Sum) / 1MB, 1) } else { 0 }

    # System totals
    $cs = Get-CimInstance Win32_OperatingSystem
    $freeRam = [math]::Round($cs.FreePhysicalMemory / 1MB, 1)

    Write-Host "[$now] ffmpeg=${ffCount} RAM=${ffRam}MB CPU_cum=${ffCpu}s | node=${nodeCount} RAM=${nodeRam}MB | system free=${freeRam}GB"

    if ($ShowPerProcess -and $ffCount -gt 0) {
        foreach ($p in $ffmpeg) {
            $ram = [math]::Round($p.WorkingSet / 1MB, 1)
            $cpu = [math]::Round($p.CPU, 1)
            $responding = if ($p.Responding) { "OK" } else { "FROZEN" }
            Write-Host "         - ffmpeg PID=$($p.Id) RAM=${ram}MB CPU=${cpu}s $responding"
        }
    }

    Start-Sleep -Seconds $IntervalSeconds
}
