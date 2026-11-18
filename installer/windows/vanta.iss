; Instalador do VANTA: FRONTLINE para Windows (versão de teste local).
; Compilado no CI: ISCC /DSrcDir=<pasta com o código> /DAppVersion=<versão> installer\windows\vanta.iss
; Instala na pasta do usuário, sem administrador. O jogo roda pelo Docker Desktop (veja LEIA-ME.txt).

#ifndef SrcDir
  #define SrcDir "..\.."
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#define Ps "{sys}\WindowsPowerShell\v1.0\powershell.exe"
#define Script "{app}\installer\windows\vanta.ps1"
; Dentro de um parâmetro do Inno, aspas são escritas dobradas ("") e viram uma aspa no atalho.
#define PsArgs '-NoProfile -ExecutionPolicy Bypass -File ""' + Script + '""'

[Setup]
AppId={{8E3A5C1D-6B7F-4E2A-9C0D-5A1B2C3D4E5F}
AppName=VANTA: FRONTLINE (teste)
AppVersion={#AppVersion}
AppPublisher=VANTA: FRONTLINE
DefaultDirName={localappdata}\Programs\VANTA
DefaultGroupName=VANTA FRONTLINE
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=VANTA-Setup
SetupIconFile=vanta.ico
UninstallDisplayIcon={app}\installer\windows\vanta.ico
InfoBeforeFile=LEIA-ME.txt
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "ptbr"; MessagesFile: "compiler:Languages\BrazilianPortuguese.isl"

[Tasks]
Name: "desktopicon"; Description: "Criar atalho na área de trabalho"; GroupDescription: "Atalhos:"

[Files]
Source: "{#SrcDir}\*"; DestDir: "{app}"; Excludes: ".git\*,.vanta-local\*,node_modules\*,installer\dist\*,docs\screenshots\*"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\VANTA FRONTLINE"; Filename: "{#Ps}"; Parameters: "{#PsArgs} iniciar"; WorkingDir: "{app}"; IconFilename: "{app}\installer\windows\vanta.ico"
Name: "{group}\Parar VANTA"; Filename: "{#Ps}"; Parameters: "{#PsArgs} parar"; WorkingDir: "{app}"; IconFilename: "{app}\installer\windows\vanta.ico"
Name: "{group}\VANTA - registros"; Filename: "{#Ps}"; Parameters: "{#PsArgs} logs"; WorkingDir: "{app}"
Name: "{group}\VANTA - apagar dados"; Filename: "{#Ps}"; Parameters: "{#PsArgs} apagar-dados"; WorkingDir: "{app}"
Name: "{group}\Leia-me"; Filename: "{app}\installer\windows\LEIA-ME.txt"
Name: "{group}\Desinstalar VANTA"; Filename: "{uninstallexe}"
Name: "{autodesktop}\VANTA FRONTLINE"; Filename: "{#Ps}"; Parameters: "{#PsArgs} iniciar"; WorkingDir: "{app}"; IconFilename: "{app}\installer\windows\vanta.ico"; Tasks: desktopicon

[Run]
Filename: "{#Ps}"; Parameters: "{#PsArgs} iniciar"; WorkingDir: "{app}"; Description: "Iniciar o VANTA agora"; Flags: postinstall nowait skipifsilent

[UninstallRun]
; Desliga o servidor antes de remover os arquivos. As contas ficam nos volumes do Docker.
Filename: "{#Ps}"; Parameters: "{#PsArgs} parar -SemPausa"; Flags: runhidden waituntilterminated; RunOnceId: "PararVanta"
; A pasta .vanta-local (senhas internas) fica de propósito: sem ela, uma reinstalação não abriria
; mais o banco que continua no Docker. Para remover tudo, use antes o atalho "VANTA - apagar dados".
