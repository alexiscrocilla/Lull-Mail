@echo off
setlocal
:: Always operate from the project root regardless of the cwd of the caller.
cd /d "%~dp0.."

echo.
echo === Lull Mail - Installation ===
echo.

:: Detecter python ou py launcher
set PYTHON=
where python >nul 2>&1 && set PYTHON=python
if "%PYTHON%"=="" where py >nul 2>&1 && set PYTHON=py
if "%PYTHON%"=="" (
    echo [ERREUR] Python introuvable dans le PATH.
    echo Installez Python 3.11+ depuis https://python.org
    echo Cochez "Add python.exe to PATH" lors de l'installation.
    pause
    exit /b 1
)

%PYTHON% --version
echo [OK] Python detecte.

:: Environnement virtuel
if not exist ".venv" (
    echo.
    echo [1/3] Creation de l'environnement virtuel...
    %PYTHON% -m venv .venv
    if errorlevel 1 (
        echo [ERREUR] Impossible de creer le venv.
        pause
        exit /b 1
    )
    echo [OK] Environnement virtuel cree.
) else (
    echo [OK] Environnement virtuel existant.
)

:: Dependances
echo.
echo [2/3] Installation des dependances...
.venv\Scripts\pip install --upgrade pip -q
.venv\Scripts\pip install -r requirements.txt
if errorlevel 1 (
    echo [ERREUR] Echec pip install.
    pause
    exit /b 1
)
echo [OK] Dependances installees.

:: Dossier data
if not exist "data" mkdir data
echo [OK] Dossier data/ pret.

echo.
echo === Installation terminee ! ===
echo.
echo Toutes les commandes passent par dev.bat a la racine :
echo   .\dev.bat start          ( mode developpeur, console + navigateur )
echo   .\dev.bat build          ( produit dist\LullMail\LullMail.exe )
echo   .\dev.bat installer      ( produit dist\LullMail-Setup-X.Y.Z.exe )
echo   .\dev.bat shortcut       ( raccourci bureau, dev uniquement )
echo.
pause
endlocal
