@echo off
setlocal
cd /d "%~dp0.."

echo.
echo === Lull Mail - Build de l'application Windows ===
echo.

if not exist ".venv" (
    echo [ERREUR] Environnement virtuel introuvable.
    echo Lancez d'abord .\dev.bat install
    pause
    exit /b 1
)

:: --- Génération de src\_version.py ---
:: En CI, LULLMAIL_VERSION est injecté par le workflow.
:: En local, on essaie de dériver la version du dernier tag git.
if defined LULLMAIL_VERSION (
    set _VER=%LULLMAIL_VERSION%
) else (
    set _VER=
    for /f "tokens=*" %%i in ('git describe --tags --abbrev^=0 2^>nul') do set _GIT_TAG=%%i
    if defined _GIT_TAG (
        set _VER=%_GIT_TAG:v=%
    )
    if not defined _VER set _VER=0.0.0-dev
)
echo __version__ = "%_VER%" > src\_version.py
echo [version] %_VER% bake dans src\_version.py

echo [1/3] Mise a jour des dependances GUI / build...
.venv\Scripts\pip install -r requirements.txt -q
.venv\Scripts\pip install pyinstaller==6.11.1 -q
if errorlevel 1 (
    echo [ERREUR] Echec pip install.
    pause
    exit /b 1
)

echo [2/3] Compilation avec PyInstaller (peut prendre 1-2 min)...
if exist "build" rmdir /s /q "build"
if exist "dist" rmdir /s /q "dist"
.venv\Scripts\pyinstaller lull_mail.spec --noconfirm --clean
if errorlevel 1 (
    echo [ERREUR] Build PyInstaller a echoue.
    pause
    exit /b 1
)

echo [3/3] Verification du resultat...
if not exist "dist\LullMail\LullMail.exe" (
    echo [ERREUR] LullMail.exe introuvable apres le build.
    pause
    exit /b 1
)

:: Nettoyage du dossier intermediaire build\ pour eviter de lancer
:: par erreur build\lull_mail\LullMail.exe (qui n'a pas ses DLLs).
if exist "build" rmdir /s /q "build"

echo.
echo === Build termine ! ===
echo.
echo Executable final : dist\LullMail\LullMail.exe
echo.

:: Quand un script parent (build_installer.bat, CI) nous appelle, on ne
:: veut ni explorer qui pop, ni pause qui bloque. LULLMAIL_NOINTERACT=1
:: court-circuite ces deux finales.
if not "%LULLMAIL_NOINTERACT%"=="1" (
    echo Pour l'usage final : passer par l'installeur Windows.
    echo Pour produire l'installeur : .\dev.bat installer
    echo.
    start "" explorer "%CD%\dist\LullMail"
    pause
)

endlocal
