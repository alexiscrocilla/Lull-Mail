; ───────────────────────────────────────────────────────────────────────────
; Lull Mail — Inno Setup script
;
; Bundles dist\LullMail\ (produced by build.bat) into a single
; LullMail-Setup-<version>.exe that:
;   • installs to %LOCALAPPDATA%\Programs\LullMail (no admin needed)
;   • adds Start Menu + optional desktop shortcuts
;   • registers in Add/Remove Programs (uninstaller)
;   • does NOT touch user data in %APPDATA%\LullMail (use the
;     in-app "Supprimer mes données" button for that)
;
; Build this script via scripts\build_installer.bat (which runs
; build.bat first to refresh the bundle, then invokes ISCC).
;
; Bumping versions: edit MyAppVersion below — the same value flows into
; OutputBaseFilename so each release is uniquely named.
; ───────────────────────────────────────────────────────────────────────────

#define MyAppName        "Lull Mail"
#define MyAppVersion     "0.6.5"
#define MyAppPublisher   "Digila"
#define MyAppExeName     "LullMail.exe"
; AppId is the immutable identity of this product in Add/Remove Programs.
; Do NOT change it across releases — Windows uses it to detect upgrades.
; If you ever fork this project for a derivative, generate a fresh GUID.
#define MyAppId          "{{5933D412-CD2C-42ED-BCB4-9809CF1683F2}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}

; Per-user install — no admin prompt, mirrors how Slack / VS Code / Notion
; install themselves on Windows.
DefaultDirName={localappdata}\Programs\LullMail
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

; Output: dist\LullMail-Setup-X.Y.Z.exe (relative to this .iss file)
OutputDir=..\dist
OutputBaseFilename=LullMail-Setup-{#MyAppVersion}

; Smaller .exe at the cost of a longer compile — worth it for a 150 MB payload.
Compression=lzma2/ultra64
SolidCompression=yes
LZMAUseSeparateProcess=yes

; Modern look + close any running instance before overwriting files.
WizardStyle=modern
CloseApplications=yes
RestartApplications=no

; Brand the installer wizard window + its entry in Add/Remove Programs.
; assets\lull_mail.ico is generated from frontend/assets/lullmail-icon.png
; (multi-resolution: 16/24/32/48/64/128/256).
SetupIconFile=..\assets\lull_mail.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
UninstallDisplayName={#MyAppName}

[Languages]
Name: "french";  MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon";   Description: "{cm:CreateDesktopIcon}"; \
    GroupDescription: "{cm:AdditionalIcons}"
Name: "autostart";     Description: "Lancer Lull Mail au démarrage de Windows"; \
    GroupDescription: "Démarrage :"; Flags: unchecked

[Files]
; The whole onedir bundle goes in {app}. ignoreversion lets future
; updates overwrite older DLLs even if their version metadata regressed.
Source: "..\dist\LullMail\*"; DestDir: "{app}"; \
    Flags: ignoreversion recursesubdirs createallsubdirs
; Ship the .ico inside {app} so shortcut IconFilename can reference it
; without depending on the exe's embedded icon resource (which Windows
; caches aggressively per-path and refuses to refresh on upgrade).
Source: "..\assets\lull_mail.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; Setting IconFilename explicitly to the .ico (rather than letting it
; default to the exe's embedded icon) makes Windows store an explicit
; IconLocation in the .lnk, which side-steps the per-path icon cache.
Name: "{group}\{#MyAppName}";        Filename: "{app}\{#MyAppExeName}"; \
    IconFilename: "{app}\lull_mail.ico"
Name: "{group}\{cm:UninstallProgram,{#MyAppName}}"; Filename: "{uninstallexe}"
Name: "{userdesktop}\{#MyAppName}";  Filename: "{app}\{#MyAppExeName}"; \
    IconFilename: "{app}\lull_mail.ico"; Tasks: desktopicon
Name: "{userstartup}\{#MyAppName}";  Filename: "{app}\{#MyAppExeName}"; \
    IconFilename: "{app}\lull_mail.ico"; Tasks: autostart

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Lancer {#MyAppName}"; \
    Flags: nowait postinstall skipifsilent
