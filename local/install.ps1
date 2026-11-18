# Holding Local installer for Windows. Safe to run again.
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
function Say($m) { Write-Host "`n$m" -ForegroundColor Cyan }

Say "Holding Local: free, private AI that runs on this computer"
Write-Host "This downloads about 7-10 GB the first time (the chat model is most of it)."

$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Say "Installing uv (Python manager)"
  powershell -ExecutionPolicy ByPass -NoProfile -c "irm https://astral.sh/uv/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}

$ollamaExe = "$env:LOCALAPPDATA\Programs\Ollama\ollama.exe"
if (-not (Get-Command ollama -ErrorAction SilentlyContinue) -and -not (Test-Path $ollamaExe)) {
  Say "Installing Ollama"
  $ok = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements
    $ok = $LASTEXITCODE -eq 0
  }
  if (-not $ok) {
    $setup = Join-Path $env:TEMP "OllamaSetup.exe"
    Invoke-WebRequest -Uri "https://ollama.com/download/OllamaSetup.exe" -OutFile $setup
    Start-Process -FilePath $setup -ArgumentList "/VERYSILENT", "/NORESTART" -Wait
  }
}
$env:Path = "$env:LOCALAPPDATA\Programs\Ollama;$env:Path"

Say "Setting up the voice and listening engines"
uv sync --extra stt --quiet

# Desktop shortcut
try {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut("$([Environment]::GetFolderPath('Desktop'))\Holding Local.lnk")
  $lnk.TargetPath = Join-Path $PSScriptRoot "Start Holding Local.bat"
  $lnk.WorkingDirectory = $PSScriptRoot
  $lnk.Save()
} catch { }

Say "Downloading models for this computer"
uv run --quiet holding-local setup
