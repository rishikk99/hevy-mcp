<#
.SYNOPSIS
  Choose the password for the Hevy connector's sign-in page.

.DESCRIPTION
  Prompts for the password twice (nothing is shown as you type), hashes it with
  PBKDF2-SHA256 here on this PC, and uploads only the hash as the Worker secret
  OWNER_PASSWORD_HASH. The password itself is never stored or sent anywhere.

  Run it again any time to change the password. Clients already connected stay
  connected; the new password applies to the next sign-in.

  Needs Node.js and the CLOUDFLARE_API_TOKEN environment variable.

.EXAMPLE
  .\worker\set-password.ps1
#>

$ErrorActionPreference = "Stop"
# Short is fine here: sign-in allows only 10 wrong guesses an hour, and the hash
# lives in a Worker secret, not anywhere it could be copied and cracked offline.
$minLength = 8

function Read-Plain([string]$prompt) {
    $secure = Read-Host -Prompt $prompt -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
}

$first = Read-Plain "New connector password (at least $minLength characters)"
if ($first.Length -lt $minLength) { throw "Too short: use at least $minLength characters." }
$second = Read-Plain "Type it again"
if ($first -ne $second) { throw "The two entries didn't match. Nothing was changed." }

if (-not $env:CLOUDFLARE_API_TOKEN) {
    $env:CLOUDFLARE_API_TOKEN = [Environment]::GetEnvironmentVariable("CLOUDFLARE_API_TOKEN", "User")
}

# Same format and parameters src/auth.ts verifies. The password reaches Node in
# an environment variable, not on the command line, and only for this process.
$hashScript = @'
const { pbkdf2Sync, randomBytes } = require("node:crypto");
const salt = randomBytes(16);
const hash = pbkdf2Sync(process.env.HEVY_CONNECTOR_PASSWORD, salt, 100000, 32, "sha256");
process.stdout.write(`pbkdf2-sha256$100000$${salt.toString("base64")}$${hash.toString("base64")}`);
'@

# The script goes through a file, not `node -e`: Windows PowerShell 5.1 strips
# double quotes from arguments it passes to native programs.
$hashFile = Join-Path $env:TEMP "hevy-hash-$([guid]::NewGuid()).cjs"
[IO.File]::WriteAllText($hashFile, $hashScript)
$env:HEVY_CONNECTOR_PASSWORD = $first
try {
    $hash = node $hashFile
    if ($LASTEXITCODE -ne 0 -or $hash -notmatch '^pbkdf2-sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$') {
        throw "Hashing failed."
    }
} finally {
    Remove-Item Env:\HEVY_CONNECTOR_PASSWORD
    Remove-Item $hashFile -Force -ErrorAction SilentlyContinue
    $first = $null; $second = $null
}

$secrets = Join-Path $env:TEMP "hevy-password-$([guid]::NewGuid()).json"
Push-Location $PSScriptRoot
try {
    # WriteAllText writes UTF-8 without the byte-order mark PowerShell 5.1 adds elsewhere.
    [IO.File]::WriteAllText($secrets, (@{ OWNER_PASSWORD_HASH = $hash } | ConvertTo-Json -Compress))
    npx wrangler secret bulk $secrets | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Uploading the hash failed; the old password (if any) still applies." }
} finally {
    Remove-Item $secrets -Force -ErrorAction SilentlyContinue
    Pop-Location
}

Write-Host "Done. The new password applies the next time you connect the Hevy connector."
