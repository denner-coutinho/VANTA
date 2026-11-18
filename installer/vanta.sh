#!/usr/bin/env bash
# VANTA: FRONTLINE, instalação local de teste (Linux e macOS).
# Sobe o jogo inteiro neste computador com o Docker: banco, Redis, API, servidor de jogo e cliente.
# Uso: installer/vanta.sh [iniciar|parar|status|logs|apagar-dados]
# VANTA_LAN_IP=192.168.0.10 força o IP da rede local, se a detecção automática errar.
# Nada sai deste computador: as senhas são geradas aqui e ficam em .vanta-local/vanta.env.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA="$ROOT/.vanta-local"
ENV_FILE="$DATA/vanta.env"
PROJECT="vanta-local"
compose() { docker compose -p "$PROJECT" -f "$ROOT/docker-compose.prod.yml" --env-file "$ENV_FILE" --profile local "$@"; }
say() { printf '\033[1;34m[VANTA]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[VANTA]\033[0m %s\n' "$*" >&2; exit 1; }

# Letras e números aleatórios (o servidor exige variedade de caracteres, então nada de hexadecimal).
secret() { head -c "$(( $1 * 2 ))" /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$(( $1 * 4 / 3 ))"; }

port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

lan_ip() {
  local ip=""
  if command -v ip >/dev/null 2>&1; then ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<NF;i++) if($i=="src"){print $(i+1); exit}}')"; fi
  if [ -z "$ip" ] && command -v ipconfig >/dev/null 2>&1; then ip="$(ipconfig getifaddr en0 2>/dev/null || true)"; fi
  case "$ip" in 10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) echo "$ip" ;; esac
}

need_docker() {
  command -v docker >/dev/null 2>&1 || fail "O Docker não está instalado. Instale o Docker (https://docs.docker.com/get-docker/) e rode de novo."
  docker compose version >/dev/null 2>&1 || fail "Falta o plugin 'docker compose'. Atualize o Docker."
  if ! docker info >/dev/null 2>&1; then
    if [ "$(uname)" = "Darwin" ]; then say "Abrindo o Docker Desktop..."; open -a Docker || true; fi
    say "Esperando o Docker ficar pronto..."
    for _ in $(seq 1 90); do docker info >/dev/null 2>&1 && return 0; sleep 2; done
    fail "O Docker não respondeu. Abra o Docker e rode de novo."
  fi
}

# Primeira execução: senhas aleatórias e porta livre. Depois só atualiza o IP da rede local.
ensure_env() {
  mkdir -p "$DATA"
  if [ ! -f "$ENV_FILE" ]; then
    local port=8080
    while ! port_free "$port"; do port=$((port + 1)); [ "$port" -gt 8099 ] && fail "Nenhuma porta livre entre 8080 e 8099."; done
    umask 077
    cat > "$ENV_FILE" <<ENV
# Gerado pela instalação local do VANTA em $(date -u +%Y-%m-%dT%H:%MZ). Não compartilhe este arquivo.
WEB_PORT=$port
POSTGRES_PASSWORD=$(secret 24)
REDIS_PASSWORD=$(secret 24)
JWT_ACCESS_SECRET=$(secret 48)
MFA_ENCRYPTION_KEY=$(secret 32)
PUBLIC_APP_URL=http://localhost:$port
ALLOW_INSECURE_HTTP=true
SEED_ACTIVATE_SEASON=true
SMTP_HOST=mailpit
SMTP_PORT=1025
MAIL_FROM=VANTA local <no-reply@vanta.local>
CORS_ORIGINS=http://localhost:$port
ENV
    say "Configuração criada em $ENV_FILE (porta $port)."
  fi
  local port ip origins
  port="$(sed -n 's/^WEB_PORT=//p' "$ENV_FILE")"
  ip="${VANTA_LAN_IP:-$(lan_ip || true)}"
  origins="http://localhost:$port,http://127.0.0.1:$port"
  [ -n "$ip" ] && origins="$origins,http://$ip:$port"
  local tmp="$ENV_FILE.tmp"
  umask 077
  sed "s|^CORS_ORIGINS=.*|CORS_ORIGINS=$origins|" "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
}

wait_ready() {
  local port="$1"
  say "Esperando o jogo responder em http://localhost:$port ..."
  for _ in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  compose ps
  fail "O jogo não respondeu a tempo. Veja os registros com: installer/vanta.sh logs"
}

open_browser() {
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then open "$1" || true; fi
}

cmd="${1:-iniciar}"
case "$cmd" in
  iniciar|start)
    need_docker; ensure_env
    port="$(sed -n 's/^WEB_PORT=//p' "$ENV_FILE")"
    say "Subindo o VANTA. Na primeira vez o Docker monta o jogo e isso leva alguns minutos."
    # VANTA_SKIP_BUILD=1 usa as imagens já montadas (útil atrás de proxy, onde o build precisa de ajustes).
    if [ "${VANTA_SKIP_BUILD:-}" = "1" ]; then compose up -d; else compose up -d --build; fi
    wait_ready "$port"
    ip="${VANTA_LAN_IP:-$(lan_ip || true)}"
    say "Pronto! Jogue em http://localhost:$port (Chrome ou Edge, teclado e mouse)."
    [ -n "$ip" ] && say "Na mesma rede (Wi-Fi ou cabo), outros PCs entram por http://$ip:$port"
    say "E-mails de cadastro e de senha chegam em http://localhost:8025"
    [ "${VANTA_NO_BROWSER:-}" = "1" ] || open_browser "http://localhost:$port"
    ;;
  parar|stop)
    need_docker; [ -f "$ENV_FILE" ] || fail "Nada instalado ainda."
    compose down; say "VANTA parado. Contas e progresso continuam salvos." ;;
  status)
    need_docker; [ -f "$ENV_FILE" ] || fail "Nada instalado ainda."; compose ps ;;
  logs)
    need_docker; [ -f "$ENV_FILE" ] || fail "Nada instalado ainda."; compose logs --tail 200 ;;
  apagar-dados|reset)
    need_docker; [ -f "$ENV_FILE" ] || fail "Nada instalado ainda."
    if [ "${VANTA_YES:-}" != "1" ]; then
      read -r -p "Isto apaga TODAS as contas e o progresso desta instalação. Digite APAGAR para confirmar: " ok
      [ "$ok" = "APAGAR" ] || fail "Cancelado."
    fi
    compose down -v; rm -f "$ENV_FILE"; say "Dados apagados." ;;
  *) fail "Comando desconhecido: $cmd (use iniciar, parar, status, logs ou apagar-dados)" ;;
esac
