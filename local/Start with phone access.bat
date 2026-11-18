@echo off
rem Lets your phone use this computer over HTTPS via Tailscale.
cd /d "%~dp0"
where tailscale >nul 2>nul && (call "Start Holding Local.bat" --tailscale) || (echo Tailscale not found, using Wi-Fi only. & call "Start Holding Local.bat" --lan)
