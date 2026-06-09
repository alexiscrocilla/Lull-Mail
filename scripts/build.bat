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
setlocal enabledelayedexpansion
if defined LULLMAIL_VERSION (
    set _VER=%LULLMAIL_VERSION%
) else (
    set _VER=0.0.0-dev
    for /f "tokens=*" %%i in ('git describe --tags --abbrev^=0 2^>nul') do (
        set _GIT_TAG=%%i
        set _VER=!_GIT_TAG:v=!
    )
)
endlocal & set _VER=%_VER%
echo __version__ = "%_VER%" > src\_version.py
echo [version] %_VER% bake dans src\_version.py

echo [1/4] Mise a jour des dependances GUI / build...
.venv\Scripts\pip install -r requirements.txt -q
.venv\Scripts\pip install pyinstaller==6.11.1 -q
if errorlevel 1 (
    echo [ERREUR] Echec pip install.
    pause
    exit /b 1
)

:: Backend LLM local. Sans ce wheel, le spec PyInstaller skip le bundle
:: de llama_cpp et l'installeur publie une app inutilisable en mode Local
:: (ModuleNotFoundError au runtime, observe sur la v0.7.0). On installe
:: systematiquement sauf si LULLMAIL_SKIP_LOCAL=1 (build OpenAI-only).
:: NB : a l'interieur d'un bloc IF (...), CMD parse les ( et ) des chaines
:: echo comme des delimiteurs de bloc. Toujours echapper avec ^( ^) sinon
:: erreur "... was unexpected at this time" (vu sur le run v0.7.1).
if not "%LULLMAIL_SKIP_LOCAL%"=="1" (
    echo [2/4] Backend local llama-cpp-python ^(CPU wheel^)...
    .venv\Scripts\pip install -r requirements-local.txt -q ^
        --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cpu
    if errorlevel 1 (
        echo [ERREUR] Echec pip install -r requirements-local.txt.
        echo Pour un build OpenAI-only sans backend local : set LULLMAIL_SKIP_LOCAL=1
        pause
        exit /b 1
    )
) else (
    echo [2/4] LULLMAIL_SKIP_LOCAL=1, skip backend local llama-cpp-python.
)

echo [3/4] Compilation avec PyInstaller (peut prendre 1-2 min)...
if exist "build" rmdir /s /q "build"
if exist "dist" rmdir /s /q "dist"
:: Sauf opt-out explicite, on force le spec a fail si llama_cpp n'est pas
:: dans le venv. Ca evite de republier un installeur casse comme la v0.7.0.
if not "%LULLMAIL_SKIP_LOCAL%"=="1" set LULLMAIL_REQUIRE_LOCAL=1
.venv\Scripts\pyinstaller lull_mail.spec --noconfirm --clean
if errorlevel 1 (
    echo [ERREUR] Build PyInstaller a echoue.
    pause
    exit /b 1
)

echo [4/4] Verification du resultat...
if not exist "dist\LullMail\LullMail.exe" (
    echo [ERREUR] LullMail.exe introuvable apres le build.
    pause
    exit /b 1
)
if not "%LULLMAIL_SKIP_LOCAL%"=="1" (
    if not exist "dist\LullMail\_internal\llama_cpp" (
        echo [ERREUR] dist\LullMail\_internal\llama_cpp introuvable.
        echo Le bundle llama_cpp a ete skip par PyInstaller alors qu'il
        echo aurait du etre embarque. Verifie que requirements-local.txt
        echo a bien installe llama-cpp-python dans .venv.
        pause
        exit /b 1
    )
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
