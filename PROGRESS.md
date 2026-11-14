# Progresso — VANTA: FRONTLINE

Legenda: ✅ pronto e testado · 🟡 parcial · ⏳ planejado

## Fase 1 — Fundação ✅ (14/11/2026)

| Item | Status | Evidência |
|---|---|---|
| Análise do ambiente | ✅ | Ambiente vazio, sem código a preservar e sem repositório GitHub conectado. Node 22, PostgreSQL 16 e Redis 7 locais. |
| Arquitetura | ✅ | `docs/ARCHITECTURE.md` |
| Monorepo pnpm (client, server, shared, db) | ✅ | `pnpm typecheck` e `pnpm build` limpos |
| Banco de dados (40 modelos, índices, FKs) | ✅ | `packages/db/prisma/schema.prisma`, migrations `init` + `integrity_constraints` |
| Integridade financeira no banco | ✅ | Testes: saldo nunca negativo, razão somente-inserção, idempotência única |
| Seed de conteúdo | ✅ | 15 patentes, 8 personagens com história, 10 armas balanceadas (5 categorias), 5 mapas, 5 pacotes de VC, missões e conquistas |
| Cadastro (idade mínima 13, termos, nomes reservados) | ✅ | `apps/server/test/auth.test.ts` |
| Login por e-mail ou nome de jogador | ✅ | idem |
| JWT curto + refresh rotativo com detecção de reuso | ✅ | idem |
| Verificação de e-mail e recuperação de senha | ✅ | idem (tokens de uso único, expiração, sessões derrubadas no reset) |
| Proteção contra força bruta e rate limit (Redis) | ✅ | idem |
| Banimento/suspensão com efeito imediato | ✅ | idem |
| Tela de inicialização (progresso real) | ✅ | E2E + `docs/screenshots/01-boot.png` |
| Login, cadastro, recuperação, redefinição, verificação | ✅ | E2E + capturas 02, 03, 07 |
| Menu principal com operador 3D animado | ✅ | E2E + capturas 04, 05 |
| Perfil (dados reais, reenviar verificação, sair de todos os dispositivos) | ✅ | E2E + captura 06 |
| Configurações (qualidade gráfica Baixo/Médio/Alto/Ultra, volume) | ✅ | Manual |
| Identidade visual (logo, 15 emblemas, paleta, tipografia, sons de UI) | ✅ | Original, gerada em código |

**Testes:** 32 de integração na API (PostgreSQL e Redis reais), 4 unitários de patentes/XP, 4 unitários do cliente HTTP, E2E com 10 passos no navegador.

### O que é provisório (e por quê)
- **Operador 3D do menu**: procedural, animado em idle (respiração, peso, cabeça seguindo o cursor). Não é um personagem final. Os modelos rigados entram na Fase 4 pelo mesmo contrato `OperatorRig`.
- **Botões RANQUEADO, SALAS, LOJA, INVENTÁRIO**: visíveis e marcados com a fase em que serão liberados; ao clicar, avisam isso. Nenhum finge funcionar. (JOGAR abre o treinamento desde a Fase 2.)
- **Amigos online / eventos**: leem dados reais (hoje vazios). Não há jogadores ou eventos inventados.
- **Temporada 1** criada inativa; ativação pelo painel admin (Fase 5).

### Pendências que dependem de você
- **Repositório GitHub**: o código está na pasta do projeto, mas sem um repositório ele não tem histórico remoto nem backup. Crie um repositório vazio e me diga o nome.
- **SMTP** para e-mails reais (qualquer provedor: Resend, SES, Brevo, etc.).
- **Stripe** (Fase 6): conta, chave secreta de teste e segredo do webhook.
- **Hospedagem** (Fase 8): API e servidor de jogo precisam de um servidor com WebSocket (VPS, Fly.io, Railway etc.); o cliente pode ficar em CDN.

## Fase 2 — Gameplay ✅ (14/11/2026)

| Item | Status | Evidência |
|---|---|---|
| Simulação determinística compartilhada (`packages/shared/src/game`) | ✅ | Mesmo código rodará no servidor autoritativo da Fase 3. 22 testes unitários |
| Tick fixo de 60 Hz com interpolação de render e limite de FPS | ✅ | `GameRuntime.ts`, configurável (30–240 ou ilimitado) |
| Pointer lock, sensibilidade, FOV, filtro de picos do mouse | ✅ | E2E |
| Movimento: andar, correr, agachar, pular, gravidade, subir degraus, anti-bunny-hop | ✅ | Testes de velocidade, degrau, teto ao levantar, sem atravessar parede |
| Colisão AABB com grade espacial + raycast | ✅ | Testes |
| Hitbox humanoide cabeça/corpo/pernas, paredes bloqueiam tiro | ✅ | Testes + E2E |
| 10 armas lidas do banco (`/content/weapons`): cadência, semi/auto, dispersão, *bloom*, padrão de recuo, queda de dano, multiplicador de cabeça | ✅ | Testes de cadência, TTK, falloff, escopeta com projéteis determinísticos |
| Munição, recarga (tática mais rápida), recarga automática, troca de arma (1/2/3, roda), mira (ADS) e luneta de sniper | ✅ | E2E (recarga e troca) |
| Mapa Neon District (64×64 m, simétrico por rotação, galeria interna, passarela elevada, coberturas) | ✅ | Teste de simetria e spawns livres |
| Arma em primeira pessoa animada (recuo, balanço, corrida, recarga, troca, clarão) | ✅ | Capturas 09–11 |
| Áudio sintetizado espacial (tiros por categoria, passos, impacto, acerto, eliminação) | ✅ | Manual (sem áudio no navegador do teste) |
| Efeitos: faíscas, marcas de bala, traçantes | ✅ | Capturas |
| HUD: mira dinâmica, hitmarker, indicador de dano, vida, munição, killfeed, estatísticas (precisão, headshots, TTK) | ✅ | E2E confere HUD × estado |
| Modo treinamento: 9 alvos (2 móveis), drone sentinela que revida, terminal de arsenal, pausa com ajustes | ✅ | E2E `scripts/e2e-training.mjs` (9/9) + capturas 12–13 |

**Testes:** 62 automatizados (32 API, 26 shared, 4 cliente) + E2E Fase 1 (10 passos) + E2E Fase 2 (9 passos), todos passando.

### Limites honestos da Fase 2
- **Não há outros jogadores ainda.** Os alvos e o drone sentinela são do treinamento, identificados como tal na tela; nenhum é apresentado como jogador real. Partidas contra pessoas chegam na Fase 3.
- **Modelos de arma e personagem são procedurais** (geometria gerada em código). Personagens animados com rig entram na Fase 4.
- **Ctrl agacha**, mas o navegador não deixa um site bloquear Ctrl+W (fechar aba). Por isso **C** também agacha, e as teclas são remapeáveis na Fase 7.
- **Desempenho real não foi medido em GPU.** O navegador do contêiner renderiza por software (≈10–14 FPS no Baixo/Médio); em máquina com placa de vídeo o esperado é muito acima, mas só vou afirmar números depois de medir.

## Fase 3 — Multiplayer ✅ (14/11/2026)

| Item | Status | Evidência |
|---|---|---|
| Servidor de jogo separado (`apps/server/src/game`, processo `dev:game`, porta 4100, WebSocket `/game`) | ✅ | `test/game-server.test.ts` |
| Autenticação com o mesmo JWT da API, conta revalidada a cada 30 s (banimento derruba a conexão), uma conexão por conta, bloqueio de Origin de terceiros | ✅ | idem |
| Fila 1v1, 2v2 e 3v3 **só com jogadores reais** (a partida começa quando a fila completa; nenhum bot) | ✅ | idem (3v3 só abre com 6 pessoas) + E2E |
| Simulação autoritativa a 60 Hz reutilizando `@vanta/shared` (movimento, armas, dispersão com semente secreta, dano) | ✅ | `test/match.test.ts` |
| Predição no cliente + reconciliação (reaplica comandos não confirmados) | ✅ | Teste de determinismo + E2E (erro predição × servidor ≈ 0 m) |
| Interpolação dos outros jogadores (100 ms) | ✅ | E2E confere posição vista × posição real |
| Compensação de latência no hitscan (rebobina até 250 ms) | ✅ | Teste acerta com `viewTick` antigo e erra sem ele |
| Rounds: aquecimento, congelamento (4 s), round (100 s), fim por eliminação ou tempo, vitória ao atingir 5/6/7 rounds | ✅ | Testes |
| Anti-cheat básico: só intenções vão ao servidor; seq contínuo; relógio de comandos (anti speed-hack); cadência no servidor; validação zod; limite de mensagens e de tamanho; vida de inimigos não é enviada | ✅ | Testes |
| Reconexão (60 s para voltar; depois conta como abandono; time inteiro fora = W.O.) | ✅ | Testes + E2E (recarregar a página volta à partida) |
| Registro da partida no banco (Match, MatchPlayer, MatchEvent) e estatísticas agregadas do perfil | ✅ | Teste de integração com PostgreSQL |
| Cliente: tela Jogar (modo, arsenal, fila com contagem), partida com placar, relógio, killfeed, placar no Tab, banners de round, resultado com MVP | ✅ | Capturas 14–16 |
| Avatares dos outros jogadores com caminhada, agachamento, mira e queda | ✅ | Captura 17 |

**Testes:** 85 automatizados (51 API + servidor de jogo, 30 shared, 4 cliente) + E2E Fase 1 (10) + E2E Fase 2 (9) + **E2E Fase 3 com dois navegadores reais (11 etapas)**, todos passando.

### Limites honestos da Fase 3
- **Testado em rede local, não na internet.** A predição, a interpolação e a compensação de latência estão implementadas e testadas, mas com o servidor na mesma máquina. Medir com latência real (100+ ms) depende da hospedagem (Fase 8).
- **Um processo de jogo só.** A fila fica na memória desse processo. Para várias instâncias, a fila e o registro de partidas passam para o Redis (Fase 8).
- **A mira é do cliente**, como em todo FPS: o servidor confere cadência, munição, dispersão e linha de visão, mas não impede *aimbot* nem *no-recoil*. Detecção estatística entra na Fase 7/8.
- **O servidor envia a posição de todos os jogadores**, o que permite *wallhack* em cliente adulterado. Filtrar por visibilidade fica para a Fase 8.
- **Fogo amigo desligado**: aliados não se ferem e balas atravessam aliados.
- **Times por ordem de chegada.** O balanceamento por MMR (Glicko-2) e o modo ranqueado chegam na Fase 5. As partidas desta fase são casuais e não mexem em patente.
- **Avatares procedurais** (substituídos pelos 8 operadores animados na Fase 4). A cor do visor segue o personagem principal do jogador; a faixa, o time.

## Fase 4 — Conteúdo ✅ (14/11/2026)

| Item | Status | Evidência |
|---|---|---|
| 4 mapas novos: **Desert Protocol** (túnel sob a duna, torre, hangar), **Frost Base** (galpão em L, pátio de contêineres, ponte rolante), **Blackout Lab** (coberto, salas escuras, luz de emergência que pisca), **Orbital Zero** (estação espacial com setor de 40% da gravidade) | ✅ | `packages/shared/src/game/maps/*.ts` |
| Simetria exata entre os times (`SymmetricMapBuilder` espelha metade do mapa) e spawns livres | ✅ | Testes por mapa |
| **Linhas de visão testadas**: nenhum spawn enxerga o outro; todo o mapa é alcançável andando com a física real; existe ponto de contato a 8–30 m que não depende de quina | ✅ | `MapAnalyzer` + `maps.test.ts` (5 mapas) |
| Gravidade reduzida no Orbital Zero, igual no cliente e no servidor (plataformas só alcançáveis com o pulo longo) | ✅ | Teste de pulo |
| Visual próprio por mapa: céu, neblina, sol, textura do chão, cores por material, neve e poeira em movimento, estrelas e planeta, luzes do laboratório piscando | ✅ | Capturas 20–24 |
| Rotação de mapas na fila (rodízio, configurável com `GAME_MAPS`) | ✅ | `game-server.test.ts` + E2E |
| **8 operadores procedurais distintos** (RAVEN, GHOST, NOVA, TITAN, ZERO, VIPER, ECHO, ORION), com a mesma altura/hitbox | ✅ | `characters.test.ts` (modelos diferentes, altura igual) + captura 18 |
| Animações: idle, andar, correr, agachar, pular, atirar, recarregar, morrer (procedurais, misturadas por peso; pés no chão ao agachar) | ✅ | Testes de transição e pose + captura 19 + E2E (o adversário vê todas) |
| Operador escolhido aparece no menu (com demonstração de recarga e disparo) e na partida para os outros jogadores | ✅ | E2E + captura 26 |
| Snapshot leva o estado de animação (no chão, correndo, recarregando) — nada que o jogador não veria | ✅ | `match.test.ts` |
| Modelo de arma em 1ª pessoa distinto por arma (silhueta e cor de acabamento próprias) | ✅ | Captura 25 (os 10 modelos, gerados pela mesma função usada em jogo) |
| Correção encontrada no E2E: toque rápido de pulo ou clique de tiro entre dois ticks (comum com FPS baixo) se perdia; agora conta | ✅ | E2E (pulo e tiros do adversário vistos em todos os mapas) |
| Som por arma (timbre próprio para cada uma das 10) também nos tiros dos outros jogadores; ambiente sonoro e reverberação por mapa | ✅ | Manual (o navegador de teste roda mudo) |

**Testes:** 121 automatizados (53 API + servidor de jogo, 57 shared, 11 cliente, 7 deles dos operadores) + E2E Fases 1–3 + **E2E Fase 4: 5 partidas seguidas entre dois navegadores reais, uma em cada mapa, 9/9 etapas** (`scripts/e2e-maps.mjs`), todos passando. O E2E da Fase 3 agora calcula o caminho no mapa que a rotação sortear.

### Limites honestos da Fase 4
- **Assets procedurais, não artísticos.** Mapas, operadores e armas são geometria gerada em código (caixas, cilindros, esferas) com cores e luzes. São originais e funcionais, mas não têm a qualidade de modelos esculpidos, texturizados e animados por captura de movimento. O caminho para isso (glTF + rig único) está em `docs/ARCHITECTURE.md` e não muda o código de jogo.
- **Animações procedurais**, não capturadas: são curvas calculadas (passada, IK das pernas, coice, recarga). Ficam convincentes de longe; de perto parecem um boneco articulado.
- **Áudio sintetizado** (Web Audio), sem gravações. Não consegui ouvir no contêiner: conferi que os timbres são gerados sem erro, mas a mixagem precisa de um ouvido humano.
- **Portas automáticas do Blackout Lab** ficaram como vãos abertos. Portas que abrem e fecham exigem estado de mapa sincronizado pelo servidor, e prefiro não entregar isso pela metade.
- **Treinamento continua só no Neon District** (os alvos e o drone foram desenhados para ele). Os 5 mapas estão nas partidas online.
- **Blackout Lab é escuro de propósito** (luz de emergência). As capturas vêm de renderização por software; o brilho final precisa ser conferido numa GPU de verdade.
- **Escolha de mapa** é por rodízio; votação de mapa e mapas por modo ficam para a Fase 5 (ranqueado).

## Fases 5–8 ⏳
Competitivo (MMR Glicko-2, 15 patentes, temporadas, ranking) · Economia (VC, loja, inventário, Stripe Checkout + webhooks) · Sistemas sociais (amigos, clãs, missões, replays, kill cam) · Finalização (carga, segurança, Docker, CI, deploy).
