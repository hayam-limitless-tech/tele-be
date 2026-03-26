# Simulate a short "drive" in the Android emulator by sending a sequence of GPS points
# through the emulator console directly. The older `adb emu geo fix` wrapper is flaky on
# newer emulator builds, so this script authenticates with the console and sends the same
# `geo fix` commands itself.
# Run with: .\emulator-simulate-drive.ps1
# Requires: emulator running, app open with location permission, adb in PATH.

$startLat = 33.8938
$startLng = 35.5018
$pointCount = 24
$delaySeconds = 2

# About 21-22 m per step at Beirut's latitude.
# With 2 s between points, this simulates roughly 38-40 km/h.
$stepLat = 0.00015
$stepLng = 0.00015

$points = @()
for ($i = 0; $i -lt $pointCount; $i++) {
    $points += @{
        lat = [math]::Round($startLat + ($stepLat * $i), 6)
        lng = [math]::Round($startLng + ($stepLng * $i), 6)
    }
}

function Get-EmulatorConsolePort {
    $deviceLine = adb devices | Select-String '^emulator-(\d+)\s+device$' | Select-Object -First 1
    if (-not $deviceLine) {
        throw 'No running Android emulator found.'
    }

    $match = [regex]::Match($deviceLine.Line, 'emulator-(\d+)')
    if (-not $match.Success) {
        throw "Unable to determine emulator console port from '$($deviceLine.Line)'."
    }

    return [int]$match.Groups[1].Value
}

function Read-ConsoleResponse {
    param(
        [Parameter(Mandatory = $true)]
        [System.Net.Sockets.NetworkStream]$Stream,

        [int]$InitialWaitMs = 200
    )

    Start-Sleep -Milliseconds $InitialWaitMs

    $buffer = New-Object byte[] 4096
    $builder = New-Object System.Text.StringBuilder
    $deadline = [DateTime]::UtcNow.AddMilliseconds([Math]::Max($InitialWaitMs, 200))

    while ([DateTime]::UtcNow -lt $deadline) {
        while ($Stream.DataAvailable) {
            $read = $Stream.Read($buffer, 0, $buffer.Length)
            if ($read -le 0) {
                break
            }

            [void]$builder.Append([System.Text.Encoding]::ASCII.GetString($buffer, 0, $read))
            $deadline = [DateTime]::UtcNow.AddMilliseconds(150)
        }

        Start-Sleep -Milliseconds 25
    }

    return $builder.ToString()
}

function Send-ConsoleCommand {
    param(
        [Parameter(Mandatory = $true)]
        [System.IO.StreamWriter]$Writer,

        [Parameter(Mandatory = $true)]
        [System.Net.Sockets.NetworkStream]$Stream,

        [Parameter(Mandatory = $true)]
        [string]$Command,

        [int]$ResponseWaitMs = 200
    )

    $Writer.WriteLine($Command)
    $response = Read-ConsoleResponse -Stream $Stream -InitialWaitMs $ResponseWaitMs

    if ($response -match 'KO:') {
        throw "Emulator console rejected '$Command': $($response.Trim())"
    }

    return $response
}

$consolePort = Get-EmulatorConsolePort
$authTokenPath = Join-Path $env:USERPROFILE '.emulator_console_auth_token'
if (-not (Test-Path $authTokenPath)) {
    throw "Emulator console auth token not found at '$authTokenPath'."
}

$authToken = (Get-Content $authTokenPath -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($authToken)) {
    throw "Emulator console auth token file '$authTokenPath' is empty."
}

$client = [System.Net.Sockets.TcpClient]::new('127.0.0.1', $consolePort)
$stream = $client.GetStream()
$writer = [System.IO.StreamWriter]::new($stream, [System.Text.Encoding]::ASCII)
$writer.NewLine = "`n"
$writer.AutoFlush = $true

try {
    $banner = Read-ConsoleResponse -Stream $stream -InitialWaitMs 300
    if ($banner -match 'Authentication required') {
        $authResponse = Send-ConsoleCommand -Writer $writer -Stream $stream -Command "auth $authToken" -ResponseWaitMs 300
        if ($authResponse -notmatch '\bOK\b') {
            throw "Emulator console authentication failed: $($authResponse.Trim())"
        }
    }

    Write-Host "Sending $($points.Count) GPS points to emulator console port $consolePort (every ${delaySeconds}s). Stop with Ctrl+C." -ForegroundColor Cyan

foreach ($i in 0..($points.Count - 1)) {
    $p = $points[$i]
    # geo fix expects longitude first, then latitude
    Send-ConsoleCommand -Writer $writer -Stream $stream -Command ("geo fix {0} {1}" -f $p.lng, $p.lat) -ResponseWaitMs 200 | Out-Null
    Write-Host "  [$($i+1)/$($points.Count)] lat=$($p.lat) lng=$($p.lng)"
    if ($i -lt $points.Count - 1) {
        Start-Sleep -Seconds $delaySeconds
    }
}

    Write-Host "Done. Location is now fixed at last point (speed should decay to ~0)." -ForegroundColor Green
}
finally {
    try {
        $writer.WriteLine('quit')
    } catch {
    }
    $writer.Dispose()
    $stream.Dispose()
    $client.Dispose()
}
