# Instalação local de teste

Sobe o VANTA: FRONTLINE inteiro num PC com o Docker, usando a mesma pilha de produção
(`docker-compose.prod.yml`): PostgreSQL, Redis, API, servidor de jogo, cliente (nginx) e o Mailpit para os e-mails.
Não é o lançamento: não há servidor na internet, e as compras com dinheiro real ficam desligadas.

| Arquivo | Para quê |
| --- | --- |
| `vanta.sh` | Launcher para Linux e macOS: `iniciar`, `parar`, `status`, `logs`, `apagar-dados` |
| `windows/vanta.ps1` | O mesmo launcher para Windows (Windows PowerShell 5.1, sem administrador) |
| `windows/vanta.iss` | Instalador do Windows (Inno Setup): copia o jogo para `%LOCALAPPDATA%\Programs\VANTA` e cria os atalhos |
| `windows/LEIA-ME.txt` | Texto mostrado antes de instalar |

## Como funciona

- Na primeira execução o launcher gera senhas aleatórias (banco, Redis, JWT, chave da 2FA) em
  `.vanta-local/vanta.env`, com permissão só para o usuário, e escolhe uma porta livre entre 8080 e 8099.
  Esse arquivo nunca entra no git nem nas imagens (`.gitignore` e `.dockerignore`).
- `ALLOW_INSECURE_HTTP=true`: o jogo roda em http, então o cookie de sessão deixa de ser `Secure` (senão o navegador
  o descartaria ao entrar pelo IP da rede local). `SEED_ACTIVATE_SEASON=true` deixa a Temporada 1 ativa.
- O IP da rede local é detectado a cada `iniciar` e entra em `CORS_ORIGINS`; dá para forçar com `VANTA_LAN_IP`.
  No Windows, outros PCs podem precisar que a porta seja liberada no Firewall.
- `parar` mantém contas e progresso (volumes do Docker). `apagar-dados` remove tudo depois de pedir confirmação.

## Como é testado

O workflow `.github/workflows/installer.yml` roda em PRs que mexem aqui e na main:

- **Linux:** sobe pelo `vanta.sh` montando as imagens do zero e roda `scripts/e2e-local-install.mjs`
  (cadastro, sessão que sobrevive à recarga pelo IP da rede, temporada ativa, fila 1v1 e partida aberta nos dois
  navegadores); depois para, sobe de novo conferindo que as contas continuam e apaga os dados.
- **Windows:** confere a sintaxe e roda `vanta.ps1 -Teste` no Windows PowerShell 5.1, compila o `VANTA-Setup.exe`,
  instala em silêncio, confere arquivos e atalhos, roda o teste do launcher instalado e desinstala.
  O runner do GitHub não roda contêineres Linux, então a subida do jogo pelo Docker Desktop no Windows não é
  exercitada no CI: ela usa os mesmos comandos `docker compose` testados no job do Linux.
- **Release:** na main, publica `VANTA-Setup.exe` e `VANTA-teste-linux-mac.zip` numa release `teste-v0.1.N`.
