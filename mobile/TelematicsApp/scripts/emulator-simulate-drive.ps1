# Simulate a short "drive" in the Android emulator by sending a sequence of GPS points via ADB.
# Run with: .\emulator-simulate-drive.ps1
# Requires: emulator running, app open with location permission, adb in PATH.

$points = @(
    @{ lat = 33.8938; lng = 35.5018 },   # Start (e.g. Beirut area)
    @{ lat = 33.8945; lng = 35.5025 },
    @{ lat = 33.8952; lng = 35.5032 },
    @{ lat = 33.8959; lng = 35.5040 },
    @{ lat = 33.8966; lng = 35.5048 },
    @{ lat = 33.8973; lng = 35.5056 },
    @{ lat = 33.8980; lng = 35.5064 },
    @{ lat = 33.8987; lng = 35.5072 },
    @{ lat = 33.8994; lng = 35.5080 },
    @{ lat = 33.9001; lng = 35.5088 },
    @{ lat = 33.9008; lng = 35.5096 },
    @{ lat = 33.9015; lng = 35.5104 },
    @{ lat = 33.9022; lng = 35.5112 },
    @{ lat = 33.9029; lng = 35.5120 },
    @{ lat = 33.9036; lng = 35.5128 },
    @{ lat = 33.9043; lng = 35.5136 },
    @{ lat = 33.9050; lng = 35.5144 },
    @{ lat = 33.9057; lng = 35.5152 },
    @{ lat = 33.9064; lng = 35.5160 },
    @{ lat = 33.9071; lng = 35.5168 }
)

$delaySeconds = 2   # ~2 s between points => ~40 s "drive", distance ~1–2 km => ~30–50 km/h computed speed

Write-Host "Sending $($points.Count) GPS points to emulator (every ${delaySeconds}s). Stop with Ctrl+C." -ForegroundColor Cyan
foreach ($i in 0..($points.Count - 1)) {
    $p = $points[$i]
    # adb emu geo fix: longitude first, then latitude
    adb emu geo fix $p.lng $p.lat
    Write-Host "  [$($i+1)/$($points.Count)] lat=$($p.lat) lng=$($p.lng)"
    if ($i -lt $points.Count - 1) {
        Start-Sleep -Seconds $delaySeconds
    }
}
Write-Host "Done. Location is now fixed at last point (speed should decay to ~0)." -ForegroundColor Green
