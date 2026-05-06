@echo off
:: Lull Mail — single-entry dispatcher for dev tasks.
::
:: Usage:
::   dev.bat install       Install Python venv + dependencies (run once)
::   dev.bat start         Start the app in dev mode (console + browser)
::   dev.bat build         Build dist\LullMail\LullMail.exe (PyInstaller)
::   dev.bat installer     Build dist\LullMail-Setup-X.Y.Z.exe (Inno Setup)
::   dev.bat shortcut      Create a desktop shortcut (dev convenience only)
::
:: All real scripts live in scripts\ — this file just routes.
:: End users never see this; they install via the .exe from the Releases page.

setlocal
cd /d "%~dp0"

if "%~1"==""          goto :usage
if /i "%~1"=="help"   goto :usage
if /i "%~1"=="-h"     goto :usage
if /i "%~1"=="--help" goto :usage

if /i "%~1"=="install"   ( call scripts\install.bat         & exit /b %ERRORLEVEL% )
if /i "%~1"=="start"     ( call scripts\start.bat           & exit /b %ERRORLEVEL% )
if /i "%~1"=="build"     ( call scripts\build.bat           & exit /b %ERRORLEVEL% )
if /i "%~1"=="installer" ( call scripts\build_installer.bat & exit /b %ERRORLEVEL% )
if /i "%~1"=="shortcut"  ( call scripts\create_shortcut.bat & exit /b %ERRORLEVEL% )

echo [ERREUR] Commande inconnue : %~1
echo.

:usage
echo Lull Mail - dispatcher de scripts dev
echo.
echo Usage : dev.bat ^<commande^>
echo.
echo Commandes :
echo   install      Cree .venv et installe les dependances (a lancer une fois)
echo   start        Lance l'app en mode developpeur (console + navigateur)
echo   build        Compile dist\LullMail\LullMail.exe (PyInstaller)
echo   installer    Compile dist\LullMail-Setup-X.Y.Z.exe (Inno Setup)
echo   shortcut     Cree un raccourci bureau (utile en dev sans installeur)
echo.
echo Pour les utilisateurs finaux : telechargez l'installeur sur la page Releases.
exit /b 1
