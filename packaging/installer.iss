#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef PayloadDir
  #error PayloadDir is required
#endif
#ifndef OutputDir
  #error OutputDir is required
#endif

[Setup]
AppId={{2A0F1E28-B637-48F7-BC7D-CF4ED1978B62}
AppName=舰装格局
AppVersion={#AppVersion}
AppPublisher=donlan96
AppPublisherURL=https://github.com/donlan96/evefrontier-fitter
AppSupportURL=https://github.com/donlan96/evefrontier-fitter/issues
AppUpdatesURL=https://github.com/donlan96/evefrontier-fitter/releases
DefaultDirName={localappdata}\Programs\EveFrontierFitter
DefaultGroupName=舰装格局
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.19041
OutputDir={#OutputDir}
OutputBaseFilename=EveFrontierFitter-{#AppVersion}-Setup-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
LicenseFile={#PayloadDir}\LICENSE
UninstallDisplayIcon={app}\EveFrontierFitter.exe
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "chinesesimplified"; MessagesFile: "ChineseSimplified.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "快捷方式："

[Files]
Source: "{#PayloadDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\舰装格局"; Filename: "{app}\EveFrontierFitter.exe"
Name: "{group}\停止舰装格局"; Filename: "{app}\EveFrontierFitter.exe"; Parameters: "--stop"
Name: "{group}\卸载舰装格局"; Filename: "{uninstallexe}"
Name: "{autodesktop}\舰装格局"; Filename: "{app}\EveFrontierFitter.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\EveFrontierFitter.exe"; Description: "启动舰装格局"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\EveFrontierFitter.exe"; Parameters: "--stop --silent"; Flags: runhidden; RunOnceId: "StopFitterServices"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\EveFrontierFitter.exe')) then
  begin
    if not Exec(ExpandConstant('{app}\EveFrontierFitter.exe'), '--stop --silent', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) then
      Result := '无法停止旧版工具，请先关闭舰装格局后重试。';
  end;
end;
