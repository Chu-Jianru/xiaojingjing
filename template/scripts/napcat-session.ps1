# Shared read-only configuration / session helpers. Never print credentials.
function Get-NapcatWebuiConfigPath {
    if ($env:NAPCAT_WEBUI_CONFIG) { return $env:NAPCAT_WEBUI_CONFIG }
    $versions = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'NapCat-p1\shell\versions'
    $candidates = @(Get-ChildItem -LiteralPath $versions -Directory -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | ForEach-Object {
            $path = Join-Path $_.FullName 'resources\app\napcat\config\webui.json'
            if (Test-Path -LiteralPath $path) { $path }
        })
    foreach ($path in $candidates) {
        try {
            $config = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
            if ([int]$config.port -eq 6099) { return $path }
        } catch { }
    }
    throw 'NapCat WebUI config unavailable; set NAPCAT_WEBUI_CONFIG'
}

function Get-NapcatWebuiToken {
    if ($env:NAPCAT_WEBUI_TOKEN) { return $env:NAPCAT_WEBUI_TOKEN }
    $config = Get-Content -LiteralPath (Get-NapcatWebuiConfigPath) -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not ($config.token -is [string]) -or -not $config.token) { throw 'NapCat WebUI token unavailable' }
    return [string]$config.token
}

function Enter-CompanionMutex([string]$Name, [int]$WaitMs = 0) {
    $mutex = New-Object System.Threading.Mutex($false, ('Local\DSH-p1-' + $Name))
    try { if ($mutex.WaitOne($WaitMs)) { return $mutex } }
    catch [System.Threading.AbandonedMutexException] { return $mutex }
    $mutex.Dispose()
    return $null
}

function Test-CompanionProcessLock([string]$Path, [string]$ScriptPath) {
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $file = Get-Item -LiteralPath $Path
        $text = [IO.File]::ReadAllText($file.FullName).TrimStart([char]0xFEFF).Trim()
        $processId = 0
        if (-not [int]::TryParse(($text -split '\s+')[0], [ref]$processId) -or $processId -le 0) { return $false }
        $process = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $processId) -ErrorAction Stop
        if (-not $process -or $process.Name -notin @('powershell.exe','pwsh.exe')) { return $false }
        if (-not $process.CommandLine -or $process.CommandLine.IndexOf($ScriptPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $false }
        # A PID reused after the lock was written does not own this operation.
        if ($process.CreationDate -gt $file.LastWriteTime.AddSeconds(1)) { return $false }
        return $true
    } catch { return $false }
}

function Read-CompanionLoginAttempts([string]$Path, [datetimeoffset]$Now = [datetimeoffset]::Now) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try { $parsed = ConvertFrom-Json ([IO.File]::ReadAllText($Path).TrimStart([char]0xFEFF)) }
    catch { return }
    # foreach enumerates the JSON array in Windows PowerShell 5.1 as well;
    # @(ConvertFrom-Json ...) there can wrap the entire array as one item.
    foreach ($value in $parsed) {
        $when = [datetimeoffset]::MinValue
        $valid = if ($value -is [datetime]) { $when = [datetimeoffset]$value; $true }
            elseif ($value -is [datetimeoffset]) { $when = $value; $true }
            elseif ($value -is [string]) { [datetimeoffset]::TryParse($value, [ref]$when) }
            else { $false }
        if ($valid -and $when -gt $Now.AddMinutes(-120) -and $when -le $Now.AddMinutes(5)) { $when }
    }
}

function Test-NapcatOneBotOnline([string]$Account = '__BOT_QQ__', [int]$TimeoutSec = 4) {
    try {
        $path = Join-Path (Split-Path (Get-NapcatWebuiConfigPath) -Parent) ('onebot11_' + $Account + '.json')
        $config = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
        $server = $config.network.httpServers | Where-Object {$_.enable -eq $true} | Select-Object -First 1
        if (-not $server) { return $false }
        $h = @{'Content-Type' = 'application/json'}
        if ($server.token) { $h.Authorization = 'Bearer ' + $server.token }
        $baseUri = 'http://127.0.0.1:' + [int]$server.port
        $state = Invoke-RestMethod -Uri ($baseUri + '/get_status') -Method Post -Headers $h -Body '{}' -TimeoutSec $TimeoutSec
        if ($state.retcode -ne 0 -or $state.data.online -ne $true) { return $false }
        $identity = Invoke-RestMethod -Uri ($baseUri + '/get_login_info') -Method Post -Headers $h -Body '{}' -TimeoutSec $TimeoutSec
        return ($state.retcode -eq 0 -and $state.data.online -eq $true -and $identity.retcode -eq 0 -and [string]$identity.data.user_id -eq $Account)
    } catch { return $false }
}
