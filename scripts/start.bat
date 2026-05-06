@echo off
setlocal
:: Always run from project root.
cd /d "%~dp0.."

echo.
echo === Lull Mail - Demarrage ===
echo.

if not exist ".venv" (
    echo [ERREUR] Environnement virtuel introuvable.
    echo Lancez d'abord .\dev.bat install
    pause
    exit /b 1
)

set "URL=http://localhost:8000"

echo Dashboard         : %URL%
echo Ouverture du nav. : automatique des que le serveur est pret
echo Ctrl+C pour arreter.
echo.

:: Spawn a detached PowerShell that waits for the server, then opens the browser.
:: -WindowStyle Hidden keeps it invisible. -File avoids any quoting nightmare.
:: Helper sits next to this script in scripts\, so %~dp0open_when_ready.ps1 works.
start "" /B powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0open_when_ready.ps1" "%URL%"

:: Run the server in the foreground (this window shows the logs; Ctrl+C stops it).
.venv\Scripts\python main.py

endlocal
