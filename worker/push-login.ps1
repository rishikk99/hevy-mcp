<#
.SYNOPSIS
  Log in to Hevy on this PC and hand the login to the Cloudflare Worker.

.DESCRIPTION
  Use this when Claude reports auth_required. From the project folder:

    .\worker\push-login.ps1

  1. Opens a browser to log in to Hevy (skipped if a fresh login is already
     waiting in .hevy\tokens.json).
  2. Proves the login works with one read-only call to Hevy.
  3. Writes it to the Worker's database.
  4. Deletes the copy on this PC. Hevy rotates the refresh token every time it
     is used, so if both places kept one, whichever refreshed second would be
     holding a dead token.

  The Worker picks the login up on its next sync: within the hour, or at once
  if you ask Claude to sync. Needs Node.js and CLOUDFLARE_API_TOKEN.
#>

$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$tokens = Join-Path $root ".hevy\tokens.json"
$python = Join-Path $root ".venv\Scripts\python.exe"
$sql = Join-Path $env:TEMP "hevy-login-$([guid]::NewGuid()).sql"

if (-not (Test-Path $python)) {
    throw "No Python environment at $python. In the project folder, run 'python -m uv sync' first."
}
if (-not $env:CLOUDFLARE_API_TOKEN) {
    $env:CLOUDFLARE_API_TOKEN = [Environment]::GetEnvironmentVariable("CLOUDFLARE_API_TOKEN", "User")
}

if (-not (Test-Path $tokens)) {
    Write-Host "==> Opening a browser: log in to Hevy there (you have 3 minutes)"
    & (Join-Path $root ".venv\Scripts\hevy-mcp-authenticate.exe")
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tokens)) { throw "The Hevy login didn't complete. Nothing was changed." }
}

Write-Host "==> Checking the login with Hevy"
# A refresh during this check is saved straight back to tokens.json, so the
# file read below always holds the newest pair.
# Through a file: Windows PowerShell 5.1 mangles quotes in arguments to native programs.
$checkFile = Join-Path $env:TEMP "hevy-check-$([guid]::NewGuid()).py"
[IO.File]::WriteAllText($checkFile, "from hevy_mcp.client import HevyClient`nwith HevyClient.from_store() as c:`n    print(c.get_account()['username'])`n")
try { $username = & $python $checkFile } finally { Remove-Item $checkFile -Force -ErrorAction SilentlyContinue }
if ($LASTEXITCODE -ne 0) {
    throw "Hevy rejected this login. Delete .hevy\tokens.json and run this script again."
}

function Quote([object]$value) {
    if ($null -eq $value -or "$value" -eq "") { return "NULL" }
    return "'" + ("$value" -replace "'", "''") + "'"
}

$login = Get-Content $tokens -Raw | ConvertFrom-Json
$statement = "INSERT INTO hevy_auth (id, access_token, refresh_token, user_id, expires_at, updated_at) VALUES " +
    "(1, $(Quote $login.access_token), $(Quote $login.refresh_token), $(Quote $login.user_id), " +
    "$(Quote $login.expires_at), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ON CONFLICT(id) DO UPDATE SET " +
    "access_token = excluded.access_token, refresh_token = excluded.refresh_token, " +
    "user_id = excluded.user_id, expires_at = excluded.expires_at, updated_at = excluded.updated_at; " +
    "DELETE FROM sync_state WHERE key = 'last_sync_error';"

Push-Location $PSScriptRoot
try {
    Write-Host "==> Sending the login to Cloudflare"
    # WriteAllText writes UTF-8 without the byte-order mark PowerShell 5.1 adds elsewhere.
    [IO.File]::WriteAllText($sql, $statement)
    try {
        npx wrangler d1 execute hevy --remote --file $sql --yes | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "Upload failed. The login is still on this PC; run this script again." }
    } finally {
        Remove-Item $sql -Force -ErrorAction SilentlyContinue
    }
} finally {
    Pop-Location
}

Remove-Item $tokens
Write-Host "==> Done: logged in as $username. The Worker holds the login now, and the copy on this PC was removed."
Write-Host "    Ask Claude to sync your workouts, or wait for the hourly sync."
