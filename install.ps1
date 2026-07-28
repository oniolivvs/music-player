# Music Player — Windows installer.
#
#   irm https://raw.githubusercontent.com/oniolivvs/music-player/main/install.ps1 | iex
#
# Downloads the latest (or pinned) release from GitHub and runs the NSIS
# setup.exe, or extracts the portable zip if preferred.
# Env: $env:MP_VERSION = "vX.Y.Z" to pin a version.
#      $env:GITHUB_TOKEN = "ghp_..." for a private repo.
#      $env:MP_PORTABLE = "1" to download the portable zip instead of the installer.

$ErrorActionPreference = 'Stop'

$repo  = 'oniolivvs/music-player'
$app   = 'MusicPlayer'
$api   = "https://api.github.com/repos/$repo/releases"

$headers = @{ Accept = 'application/vnd.github+json' }
if ($env:GITHUB_TOKEN) { $headers['Authorization'] = "Bearer $env:GITHUB_TOKEN" }

function Say($msg)  { Write-Host ":: $msg" -ForegroundColor Magenta }
function Die($msg)  { Write-Host "error: $msg" -ForegroundColor Red; exit 1 }

# --- Prerequisites ---

function Install-VCRedist {
    $regPath = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\x64"
    if (-not (Test-Path $regPath)) {
        Say "Installing Visual C++ Redistributable..."
        $vcUrl = "https://aka.ms/vs/17/release/vc_redist.x64.exe"
        $vcExe = Join-Path $tmp.FullName "vc_redist.x64.exe"
        Invoke-WebRequest -Uri $vcUrl -OutFile $vcExe
        Start-Process -FilePath $vcExe -ArgumentList "/install /quiet /norestart" -Wait
    } else {
        Say "Visual C++ Redistributable is already installed."
    }
}

function Install-WebView2 {
    $regPath1 = "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    $regPath2 = "HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    if (-not (Test-Path $regPath1) -and -not (Test-Path $regPath2)) {
        Say "Installing WebView2 Runtime..."
        $wvUrl = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
        $wvExe = Join-Path $tmp.FullName "MicrosoftEdgeWebview2Setup.exe"
        Invoke-WebRequest -Uri $wvUrl -OutFile $wvExe
        Start-Process -FilePath $wvExe -ArgumentList "/silent /install" -Wait
    } else {
        Say "WebView2 Runtime is already installed."
    }
}

function Install-Tools {
    $binDir = Join-Path $env:LOCALAPPDATA "$app\bin"
    if (-not (Test-Path $binDir)) { New-Item -ItemType Directory -Path $binDir -Force | Out-Null }
    
    # yt-dlp
    $ytdlpExe = Join-Path $binDir "yt-dlp.exe"
    if (-not (Test-Path $ytdlpExe)) {
        Say "Downloading yt-dlp..."
        Invoke-WebRequest -Uri "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" -OutFile $ytdlpExe
    }
    
    # ffmpeg
    $ffmpegExe = Join-Path $binDir "ffmpeg.exe"
    if (-not (Test-Path $ffmpegExe)) {
        Say "Downloading ffmpeg..."
        $ffmpegZip = Join-Path $tmp.FullName "ffmpeg.zip"
        # Download a standard Windows build of ffmpeg from GitHub (faster and more reliable than gyan.dev in PowerShell)
        Invoke-WebRequest -Uri "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip" -OutFile $ffmpegZip
        Say "Extracting ffmpeg..."
        Expand-Archive -Path $ffmpegZip -DestinationPath $tmp.FullName -Force
        $extractedFfmpeg = Get-ChildItem -Path $tmp.FullName -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
        if ($extractedFfmpeg) {
            Copy-Item -Path $extractedFfmpeg.FullName -Destination $ffmpegExe -Force
            $extractedFfprobe = Get-ChildItem -Path $tmp.FullName -Recurse -Filter "ffprobe.exe" | Select-Object -First 1
            if ($extractedFfprobe) {
                Copy-Item -Path $extractedFfprobe.FullName -Destination (Join-Path $binDir "ffprobe.exe") -Force
            }
        }
    }
    
    # Add binDir to User PATH
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    if ($userPath -notlike "*$binDir*") {
        [Environment]::SetEnvironmentVariable('PATH', "$userPath;$binDir", 'User')
        Say "Added $binDir to your PATH."
    }
}

# --- pick the release ---
if ($env:MP_VERSION) {
    $relUrl = "$api/tags/$env:MP_VERSION"
} else {
    $relUrl = "$api/latest"
}

Say "Fetching release info..."
try {
    $json = Invoke-RestMethod -Uri $relUrl -Headers $headers
} catch {
    Die "Cannot reach GitHub (private repo? set `$env:GITHUB_TOKEN)."
}

$assets = $json.assets | Where-Object { $_.browser_download_url } | ForEach-Object { $_.browser_download_url }
if (-not $assets) { Die "No downloadable assets in this release — build one first (push a v* tag)." }

$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "mp-install-$(Get-Random)") -Force

try {
    Install-VCRedist
    Install-WebView2
    Install-Tools

    if ($env:MP_PORTABLE -eq '1') {
        # --- Portable zip mode ---
        $zipUrl = $assets | Where-Object { $_ -match '\.zip$' -and $_ -match 'windows' } | Select-Object -First 1
        if (-not $zipUrl) { Die "No portable Windows zip found in this release." }
        $zipFile = Join-Path $tmp.FullName "music-player.zip"
        Say "Downloading portable zip..."
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipFile -Headers $headers

        $installDir = Join-Path $env:LOCALAPPDATA $app
        Say "Extracting to $installDir..."
        if (Test-Path $installDir) { Remove-Item -Recurse -Force $installDir }
        Expand-Archive -Path $zipFile -DestinationPath $installDir -Force

        # Add to PATH if not already there
        $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
        if ($userPath -notlike "*$installDir*") {
            [Environment]::SetEnvironmentVariable('PATH', "$userPath;$installDir", 'User')
            Say "Added $installDir to your PATH (restart your terminal to use it)."
        }

        Say "Done — portable install at $installDir"
    } else {
        # --- NSIS installer mode (default) ---
        $exeUrl = $assets | Where-Object { $_ -match '-setup\.exe$' -or ($_ -match '\.exe$' -and $_ -match 'setup') } | Select-Object -First 1
        if (-not $exeUrl) {
            # Fallback: try any .exe
            $exeUrl = $assets | Where-Object { $_ -match '\.exe$' } | Select-Object -First 1
        }
        if (-not $exeUrl) { Die "No Windows installer (.exe) found in this release." }

        $exeFile = Join-Path $tmp.FullName "music-player-setup.exe"
        Say "Downloading installer..."
        Invoke-WebRequest -Uri $exeUrl -OutFile $exeFile -Headers $headers

        Say "Running installer..."
        Start-Process -FilePath $exeFile -Wait

        Say "Done — find Music Player in your Start menu."
    }
} finally {
    Remove-Item -Recurse -Force $tmp.FullName -ErrorAction SilentlyContinue
}
