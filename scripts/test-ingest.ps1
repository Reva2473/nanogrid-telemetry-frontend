# ==============================================================================
# Nanogrid Telemetry Ingestion Verification Script (PowerShell)
# Tests the ingest endpoint for compliance with authentication, validation,
# and rate limiting requirements.
#
# Usage:
#   .\scripts\test-ingest.ps1
#
# Custom endpoint and secret via environment variables:
#   $env:INGEST_URL = "https://your-project.supabase.co/functions/v1/ingest"
#   $env:DEVICE_KEY = "your-actual-device-key"
#   .\scripts\test-ingest.ps1
# ==============================================================================

[CmdletBinding()]
param()

Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue

$IngestUrl = if ($env:INGEST_URL) { $env:INGEST_URL } else { "http://localhost:8787/ingest" }
$DeviceKey = if ($env:DEVICE_KEY) { $env:DEVICE_KEY } else { "test-device-key-change-me" }

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "  Dual Nanogrid Telemetry Ingest Verification Test Suite (PowerShell)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "Target URL : $IngestUrl" -ForegroundColor Yellow
Write-Host "Device Key : $(if ($DeviceKey.Length -gt 6) { $DeviceKey.Substring(0, 4) + '...' + $DeviceKey.Substring($DeviceKey.Length - 2) } else { '***' })" -ForegroundColor Yellow
Write-Host ""

$Passed = 0
$Failed = 0

function Send-TestRequest {
    param (
        [string]$Url,
        [hashtable]$Headers,
        [string]$Body
    )
    try {
        $response = Invoke-WebRequest -Uri $Url -Method Post -Headers $Headers -Body $Body -ContentType "application/json" -UseBasicParsing -TimeoutSec 10
        return [PSCustomObject]@{
            StatusCode = [int]$response.StatusCode
            Content    = $response.Content
            Success    = $true
        }
    }
    catch [System.Net.WebException] {
        $resp = $_.Exception.Response
        if ($resp) {
            $stream = $resp.GetResponseStream()
            $reader = New-Object System.IO.StreamReader($stream)
            $content = $reader.ReadToEnd()
            return [PSCustomObject]@{
                StatusCode = [int]$resp.StatusCode
                Content    = $content
                Success    = $false
            }
        }
        return [PSCustomObject]@{
            StatusCode = 0
            Content    = $_.Exception.Message
            Success    = $false
        }
    }
    catch {
        # PowerShell 7 HttpResponseException or generic exception
        if ($_.Exception.Response) {
            $resp = $_.Exception.Response
            $content = ""
            try {
                $reader = New-Object System.IO.StreamReader($resp.Content.ReadAsStream())
                $content = $reader.ReadToEnd()
            } catch {}
            return [PSCustomObject]@{
                StatusCode = [int]$resp.StatusCode
                Content    = $content
                Success    = $false
            }
        }
        return [PSCustomObject]@{
            StatusCode = 0
            Content    = $_.ToString()
            Success    = $false
        }
    }
}

function Run-TestCase {
    param (
        [int]$TestNum,
        [string]$Description,
        [hashtable]$Headers,
        [string]$Payload,
        [int]$ExpectedStatus
    )

    Write-Host "[Test $TestNum] $Description..." -NoNewline
    $res = Send-TestRequest -Url $IngestUrl -Headers $Headers -Body $Payload

    if ($res.StatusCode -eq $ExpectedStatus) {
        Write-Host " [PASS]" -ForegroundColor Green
        Write-Host "        Received HTTP $($res.StatusCode) (Expected $ExpectedStatus)" -ForegroundColor DarkGray
        if ($res.Content) {
            $trimmed = if ($res.Content.Length -gt 140) { $res.Content.Substring(0, 140) + "..." } else { $res.Content }
            Write-Host "        Response: $trimmed" -ForegroundColor DarkGray
        }
        $script:Passed++
        return
    }
    else {
        Write-Host " [FAIL]" -ForegroundColor Red
        Write-Host "        Expected HTTP $ExpectedStatus, but received HTTP $($res.StatusCode)" -ForegroundColor Red
        Write-Host "        Response: $($res.Content)" -ForegroundColor Yellow
        $script:Failed++
        return
    }
}

# ------------------------------------------------------------------------------
# Test 1: Valid POST for Node 2 (Exact sample JSON from requirements)
# ------------------------------------------------------------------------------
$PayloadNode2 = @'
{
  "node": 2,
  "uptime_s": 1234,
  "src": "BATTERY",
  "tie": "EXPORT",
  "soc": 98.0,
  "vbat": 13.12,
  "ibat": -0.123,
  "vpv": 12.40,
  "ipv": 0.105,
  "vbus": 15.01,
  "ibus": -0.210,
  "pv_ok": true,
  "lockout": false,
  "import_bus_ok": false,
  "rssi": -61,
  "fw": "telemetry-1"
}
'@

$HeadersAuth = @{
    "X-Device-Key" = $DeviceKey
}

Run-TestCase -TestNum 1 -Description "Valid Ingest POST for Node 2" `
    -Headers $HeadersAuth -Payload $PayloadNode2 -ExpectedStatus 200

# ------------------------------------------------------------------------------
# Test 2: Valid POST for Node 1
# ------------------------------------------------------------------------------
$PayloadNode1 = @'
{
  "node": 1,
  "uptime_s": 2450,
  "src": "PV",
  "tie": "IMPORT",
  "soc": 85.5,
  "vbat": 12.85,
  "ibat": 0.450,
  "vpv": 12.42,
  "ipv": 0.620,
  "vbus": 15.00,
  "ibus": 0.205,
  "pv_ok": true,
  "lockout": false,
  "import_bus_ok": true,
  "rssi": -58,
  "fw": "telemetry-1"
}
'@

# Small sleep to ensure distinct time from Test 1
Start-Sleep -Milliseconds 200

Run-TestCase -TestNum 2 -Description "Valid Ingest POST for Node 1" `
    -Headers $HeadersAuth -Payload $PayloadNode1 -ExpectedStatus 200

# ------------------------------------------------------------------------------
# Test 3: Wrong X-Device-Key -> HTTP 401 Unauthorized
# ------------------------------------------------------------------------------
$HeadersBadKey = @{
    "X-Device-Key" = "invalid-secret-key-12345"
}

Run-TestCase -TestNum 3 -Description "Reject wrong X-Device-Key with 401" `
    -Headers $HeadersBadKey -Payload $PayloadNode2 -ExpectedStatus 401

# ------------------------------------------------------------------------------
# Test 4: Malformed body (invalid field / schema violation) -> HTTP 400 Bad Request
# ------------------------------------------------------------------------------
$PayloadMalformed = @'
{
  "node": 99,
  "uptime_s": -50,
  "soc": 150.0
}
'@

Run-TestCase -TestNum 4 -Description "Reject malformed body with 400" `
    -Headers $HeadersAuth -Payload $PayloadMalformed -ExpectedStatus 400

# ------------------------------------------------------------------------------
# Test 5: Rapid Duplicate POST (< 1500ms) for Node 2 rate limit
# ------------------------------------------------------------------------------
Write-Host "[Test 5] Rapid duplicate POST (< 1500ms) for Node 2 rate limit..." -NoNewline

$httpClient = New-Object System.Net.Http.HttpClient
$httpClient.DefaultRequestHeaders.Add("X-Device-Key", $DeviceKey)

try {
    # Warm up the TLS connection with the first POST ($msg1) and wait for it
    $content1 = New-Object System.Net.Http.StringContent($PayloadNode2, [System.Text.Encoding]::UTF8, "application/json")
    $post1Task = $httpClient.PostAsync($IngestUrl, $content1)
    $msg1 = $post1Task.GetAwaiter().GetResult()

    # Immediately fire rapid duplicate POST on the same warm HttpClient connection (reuses TLS socket)
    $content2 = New-Object System.Net.Http.StringContent($PayloadNode2, [System.Text.Encoding]::UTF8, "application/json")
    $post2Task = $httpClient.PostAsync($IngestUrl, $content2)
    $msg2 = $post2Task.GetAwaiter().GetResult()

    $status2 = [int]$msg2.StatusCode
    $body2 = $msg2.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    $status1 = [int]$msg1.StatusCode
    $body1 = $msg1.Content.ReadAsStringAsync().GetAwaiter().GetResult()

    # Determine if rapid request hit rate limit
    $rapidStatus = $status2
    $rapidBody = $body2

    if ($rapidStatus -ne 429 -and $status1 -eq 429) {
        $rapidStatus = 429
        $rapidBody = $body1
    }

    # Fall back to concurrent pair if extreme high-latency connection exceeded the window
    if ($rapidStatus -ne 429) {
        $c3 = New-Object System.Net.Http.StringContent($PayloadNode2, [System.Text.Encoding]::UTF8, "application/json")
        $c4 = New-Object System.Net.Http.StringContent($PayloadNode2, [System.Text.Encoding]::UTF8, "application/json")
        $task3 = $httpClient.PostAsync($IngestUrl, $c3)
        $task4 = $httpClient.PostAsync($IngestUrl, $c4)
        [System.Threading.Tasks.Task]::WaitAll($task3, $task4)

        $s3 = [int]$task3.Result.StatusCode
        $s4 = [int]$task4.Result.StatusCode
        if ($s4 -eq 429) {
            $rapidStatus = 429
            $rapidBody = $task4.Result.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        } elseif ($s3 -eq 429) {
            $rapidStatus = 429
            $rapidBody = $task3.Result.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        }
    }

    if ($rapidStatus -eq 429) {
        Write-Host " [PASS]" -ForegroundColor Green
        Write-Host "        Received HTTP 429 Too Many Requests (Rate limit active)" -ForegroundColor DarkGray
        Write-Host "        Response: $rapidBody" -ForegroundColor DarkGray
        $Passed++
    }
    else {
        Write-Host " [FAIL]" -ForegroundColor Red
        Write-Host "        Expected HTTP 429, but received HTTP $rapidStatus" -ForegroundColor Red
        Write-Host "        Response: $rapidBody" -ForegroundColor Yellow
        $Failed++
    }
}
catch {
    Write-Host " [FAIL]" -ForegroundColor Red
    Write-Host "        Exception during rate limit test: $($_.Exception.Message)" -ForegroundColor Red
    $Failed++
}
finally {
    $httpClient.Dispose()
}

# ------------------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------------------
Write-Host ""
Write-Host "----------------------------------------------------------------------" -ForegroundColor Cyan
Write-Host "Test Results: $Passed Passed, $Failed Failed (Total 5)" -ForegroundColor $(if ($Failed -eq 0) { "Green" } else { "Red" })
Write-Host "----------------------------------------------------------------------" -ForegroundColor Cyan

if ($Failed -gt 0) {
    exit 1
} else {
    exit 0
}
