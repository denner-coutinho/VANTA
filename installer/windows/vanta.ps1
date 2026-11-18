<#
  VANTA: FRONTLINE, instalação local de teste (Windows).
  Sobe o jogo inteiro neste PC com o Docker Desktop: banco, Redis, API, servidor de jogo e cliente.
  Uso: vanta.ps1 [iniciar|parar|status|logs|apagar-dados] [-SemNavegador] [-SemPausa]
       vanta.ps1 -Teste   (confere o script sem precisar do Docker; usado no CI)
  Nada sai deste PC: as senhas são geradas aqui e ficam em .vanta-local\vanta.env.
#>
param(
  [ValidateSet("iniciar", "parar", "status", "logs", "apagar-dados")]
  [string]$Comando = "iniciar",
  [switch]$SemNavegador,
  [switch]$SemPausa,
  [switch]$Teste
)

# "Continue": no Windows PowerShell 5.1, "Stop" transforma qualquer linha no stderr do docker em erro fatal.
$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$Data = Join-Path $Root ".vanta-local"
$EnvFile = Join-Path $Data "vanta.env"
$Project = "vanta-local"
$ComposeFile = Join-Path $Root "docker-compose.prod.yml"

function Say([string]$msg) { Write-Host "[VANTA] $msg" -ForegroundColor Cyan }
function Warn([string]$msg) { Write-Host "[VANTA] $msg" -ForegroundColor Yellow }
function Pause-End {
  if (-not $SemPausa) { Write-Host ""; Read-Host "Pressione Enter para fechar esta janela" | Out-Null }
}
function Fail([string]$msg) {
  Write-Host "[VANTA] $msg" -ForegroundColor Red
  Pause-End
  exit 1
}

# Letras e números aleatórios (o servidor exige variedade de caracteres).
function New-Secret([int]$length) {
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $out = ""
  while ($out.Length -lt $length) {
    $bytes = New-Object byte[] 64
    $rng.GetBytes($bytes)
    $out += ([Convert]::ToBase64String($bytes) -replace "[^A-Za-z0-9]", "")
  }
  return $out.Substring(0, $length)
}

function Test-PortFree([int]$port) {
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $port)
    $listener.Start(); $listener.Stop(); return $true
  } catch { return $false }
}

function Get-LanIp {
  if ($env:VANTA_LAN_IP) { return $env:VANTA_LAN_IP }
  try {
    $route = Get-NetRoute -DestinationPrefix "0.0.0.0/0" -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1
    $ip = (Get-NetIPAddress -InterfaceIndex $route.ifIndex -AddressFamily IPv4 -ErrorAction Stop | Select-Object -First 1).IPAddress
    if ($ip -match "^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)") { return $ip }
  } catch { }
  return $null
}

function Write-Utf8NoBom([string]$path, [string]$text) {
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false))
}

function Read-EnvValue([string]$key) {
  foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
    if ($line.StartsWith("$key=")) { return $line.Substring($key.Length + 1) }
  }
  return $null
}

# Primeira execução: senhas aleatórias e porta livre. Depois só atualiza o IP da rede local.
function Initialize-Env {
  if (-not (Test-Path $Data)) { New-Item -ItemType Directory -Path $Data | Out-Null }
  if (-not (Test-Path $EnvFile)) {
    $port = 8080
    while (-not (Test-PortFree $port)) {
      $port++
      if ($port -gt 8099) { Fail "Nenhuma porta livre entre 8080 e 8099." }
    }
    $lines = @(
      "# Gerado pela instalação local do VANTA em $((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mmZ')). Não compartilhe este arquivo.",
      "WEB_PORT=$port",
      "POSTGRES_PASSWORD=$(New-Secret 32)",
      "REDIS_PASSWORD=$(New-Secret 32)",
      "JWT_ACCESS_SECRET=$(New-Secret 64)",
      "MFA_ENCRYPTION_KEY=$(New-Secret 43)",
      "PUBLIC_APP_URL=http://localhost:$port",
      "ALLOW_INSECURE_HTTP=true",
      "SEED_ACTIVATE_SEASON=true",
      "SMTP_HOST=mailpit",
      "SMTP_PORT=1025",
      "MAIL_FROM=VANTA local <no-reply@vanta.local>",
      "CORS_ORIGINS=http://localhost:$port"
    )
    Write-Utf8NoBom $EnvFile (($lines -join "`n") + "`n")
    Say "Configuração criada em $EnvFile (porta $port)."
  }
  $port = Read-EnvValue "WEB_PORT"
  $origins = "http://localhost:$port,http://127.0.0.1:$port"
  $ip = Get-LanIp
  if ($ip) { $origins += ",http://${ip}:$port" }
  $updated = foreach ($line in [System.IO.File]::ReadAllLines($EnvFile)) {
    if ($line.StartsWith("CORS_ORIGINS=")) { "CORS_ORIGINS=$origins" } else { $line }
  }
  Write-Utf8NoBom $EnvFile (($updated -join "`n") + "`n")
}

function Invoke-Compose([string[]]$composeArgs) {
  # Out-Host: a saída do docker vai para a tela e a função devolve só o código de saída.
  & docker compose -p $Project -f $ComposeFile --env-file $EnvFile --profile local @composeArgs | Out-Host
  return $LASTEXITCODE
}

function Assert-Docker {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Warn "O Docker Desktop não está instalado. Ele é o que roda o servidor do jogo neste PC."
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      $answer = Read-Host "Instalar o Docker Desktop agora pelo winget? (S/N)"
      if ($answer -match "^[sS]") {
        winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
        Fail "Docker Desktop instalado. Reinicie o PC, abra o Docker Desktop uma vez (aceite os termos) e abra o VANTA de novo."
      }
    }
    Start-Process "https://www.docker.com/products/docker-desktop/"
    Fail "Instale o Docker Desktop (abri a página de download), reinicie o PC e abra o VANTA de novo."
  }
  & docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    $desktop = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path $desktop) { Say "Abrindo o Docker Desktop..."; Start-Process $desktop }
    Say "Esperando o Docker ficar pronto (pode levar até 3 minutos)..."
    for ($i = 0; $i -lt 90; $i++) {
      Start-Sleep -Seconds 2
      & docker info *> $null
      if ($LASTEXITCODE -eq 0) { break }
    }
    if ($LASTEXITCODE -ne 0) { Fail "O Docker não respondeu. Abra o Docker Desktop, espere ele dizer que está rodando e abra o VANTA de novo." }
  }
  $info = & docker info --format "{{.OSType}}" 2>$null
  if ($info -and $info.Trim() -ne "linux") { Fail "O Docker está no modo de contêineres Windows. No ícone do Docker, escolha 'Switch to Linux containers' e abra o VANTA de novo." }
}

function Test-Url([string]$url) {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $url).StatusCode -eq 200 } catch { return $false }
}

function Wait-Ready([string]$port) {
  Say "Esperando o jogo responder em http://localhost:$port ..."
  for ($i = 0; $i -lt 120; $i++) {
    if ((Test-Url "http://127.0.0.1:$port/healthz") -and (Test-Url "http://127.0.0.1:$port/api/health")) { return }
    Start-Sleep -Seconds 3
  }
  Invoke-Compose @("ps") | Out-Null
  Fail "O jogo não respondeu a tempo. Veja os registros no atalho 'VANTA - registros'."
}

# Confere o próprio script sem Docker (CI no Windows).
if ($Teste) {
  $Data = Join-Path ([System.IO.Path]::GetTempPath()) ("vanta-teste-" + [guid]::NewGuid().ToString("N"))
  $EnvFile = Join-Path $Data "vanta.env"
  $env:VANTA_LAN_IP = "192.168.0.50"
  Initialize-Env
  Initialize-Env
  $text = [System.IO.File]::ReadAllText($EnvFile)
  if ($text.Contains("`r")) { throw "arquivo de configuração com CRLF" }
  if ([System.IO.File]::ReadAllBytes($EnvFile)[0] -eq 0xEF) { throw "arquivo de configuração com BOM" }
  foreach ($k in @("POSTGRES_PASSWORD", "REDIS_PASSWORD", "JWT_ACCESS_SECRET", "MFA_ENCRYPTION_KEY")) {
    $v = Read-EnvValue $k
    if ($v.Length -lt 32) { throw "$k curto: $($v.Length)" }
    if (($v.ToCharArray() | Select-Object -Unique).Count -lt 16) { throw "$k com pouca variedade" }
    if ($v -notmatch "^[A-Za-z0-9]+$") { throw "$k com caracteres inesperados" }
  }
  if ((Read-EnvValue "JWT_ACCESS_SECRET") -eq (Read-EnvValue "MFA_ENCRYPTION_KEY")) { throw "segredos repetidos" }
  $port = Read-EnvValue "WEB_PORT"
  $cors = Read-EnvValue "CORS_ORIGINS"
  if ($cors -ne "http://localhost:$port,http://127.0.0.1:$port,http://192.168.0.50:$port") { throw "CORS_ORIGINS inesperado: $cors" }
  if (([regex]::Matches($text, "(?m)^CORS_ORIGINS=")).Count -ne 1) { throw "CORS_ORIGINS duplicado" }
  if (-not (Test-Path $ComposeFile)) { throw "docker-compose.prod.yml não encontrado em $Root" }
  Remove-Item -Recurse -Force $Data
  Write-Host "TESTE DO SCRIPT OK (porta $port)"
  exit 0
}

switch ($Comando) {
  "iniciar" {
    Assert-Docker
    Initialize-Env
    $port = Read-EnvValue "WEB_PORT"
    Say "Subindo o VANTA. Na primeira vez o Docker monta o jogo e isso leva de 5 a 15 minutos."
    if ((Invoke-Compose @("up", "-d", "--build")) -ne 0) { Fail "O Docker não conseguiu subir o jogo. Veja a mensagem acima." }
    Wait-Ready $port
    Say "Pronto! Jogue em http://localhost:$port (Chrome ou Edge, teclado e mouse)."
    $ip = Get-LanIp
    if ($ip) { Say "Na mesma rede (Wi-Fi ou cabo), outros PCs entram por http://${ip}:$port (se não abrir, libere a porta $port no Firewall do Windows)." }
    Say "E-mails de cadastro e de senha chegam em http://localhost:8025"
    Say "Para desligar o servidor, use o atalho 'Parar VANTA'."
    if (-not $SemNavegador) { Start-Process "http://localhost:$port" }
    Pause-End
  }
  "parar" {
    if (-not (Test-Path $EnvFile)) { Say "Nada para parar."; Pause-End; exit 0 }
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Say "Docker não encontrado: nada para parar."; Pause-End; exit 0 }
    & docker info *> $null
    if ($LASTEXITCODE -ne 0) { Say "O Docker já está desligado."; Pause-End; exit 0 }
    Invoke-Compose @("down") | Out-Null
    Say "VANTA parado. Contas e progresso continuam salvos."
    Pause-End
  }
  "status" {
    if (-not (Test-Path $EnvFile)) { Fail "Nada instalado ainda." }
    Assert-Docker; Invoke-Compose @("ps") | Out-Null; Pause-End
  }
  "logs" {
    if (-not (Test-Path $EnvFile)) { Fail "Nada instalado ainda." }
    Assert-Docker; Invoke-Compose @("logs", "--tail", "200") | Out-Null; Pause-End
  }
  "apagar-dados" {
    if (-not (Test-Path $EnvFile)) { Fail "Nada instalado ainda." }
    Assert-Docker
    $ok = Read-Host "Isto apaga TODAS as contas e o progresso desta instalação. Digite APAGAR para confirmar"
    if ($ok -ne "APAGAR") { Fail "Cancelado." }
    Invoke-Compose @("down", "-v") | Out-Null
    Remove-Item -Force $EnvFile
    Say "Dados apagados."
    Pause-End
  }
}
