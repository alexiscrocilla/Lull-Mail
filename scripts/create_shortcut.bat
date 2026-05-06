@echo off
setlocal
cd /d "%~dp0.."

echo.
echo === Lull Mail - Creation du raccourci bureau (dev) ===
echo.
echo Note : pour les utilisateurs finaux, l'installeur (.\dev.bat installer)
echo cree deja un raccourci bureau et menu Demarrer. Ce script est destine
echo aux developpeurs qui veulent un raccourci sans passer par l'installeur.
echo.

set "WORKDIR=%CD%"

:: Privilegie l'exe natif si build a deja tourne, sinon retombe sur le dispatcher dev.bat
set "EXE_TARGET=%CD%\dist\LullMail\LullMail.exe"
set "BAT_TARGET=%CD%\dev.bat"

if exist "%EXE_TARGET%" (
    set "TARGET=%EXE_TARGET%"
    set "ARGS="
    set "ICON=%EXE_TARGET%,0"
    echo [INFO] Cible : application native LullMail.exe
) else (
    if not exist "%BAT_TARGET%" (
        echo [ERREUR] Ni LullMail.exe ni dev.bat n'ont ete trouves.
        echo Lancez .\dev.bat install puis .\dev.bat build.
        pause
        exit /b 1
    )
    set "TARGET=%BAT_TARGET%"
    set "ARGS=start"
    set "ICON=%SystemRoot%\System32\imageres.dll,154"
    echo [INFO] LullMail.exe non trouve - retombee sur dev.bat start
    echo        Lancez .\dev.bat build pour avoir une vraie app native.
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$desktop = [Environment]::GetFolderPath('Desktop');" ^
  "$lnk = Join-Path $desktop 'Lull Mail.lnk';" ^
  "$sc = $ws.CreateShortcut($lnk);" ^
  "$sc.TargetPath = '%TARGET%';" ^
  "$sc.Arguments = '%ARGS%';" ^
  "$sc.WorkingDirectory = '%WORKDIR%';" ^
  "$sc.Description = 'Lull Mail - dashboard local';" ^
  "$sc.IconLocation = '%ICON%';" ^
  "$sc.WindowStyle = 1;" ^
  "$sc.Save();" ^
  "Write-Host \"[OK] Raccourci cree : $lnk\""

if errorlevel 1 (
    echo [ERREUR] Echec de creation du raccourci.
    pause
    exit /b 1
)

echo.
echo Double-clique sur "Lull Mail" sur le bureau pour lancer.
echo.
pause
endlocal
