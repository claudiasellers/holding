@echo off
cd /d "%~dp0"
set "PATH=%USERPROFILE%\.local\bin;%LOCALAPPDATA%\Programs\Ollama;%PATH%"
uv run --quiet holding-local start %*
pause
