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

## Fase 5 — Competitivo ✅ (14/11/2026)

| Item | Status | Evidência |
|---|---|---|
| **MMR oculto com Glicko-2** (rating, desvio e volatilidade por jogador, modo e temporada). Em equipe, cada jogador é avaliado contra a média do time adversário | ✅ | `packages/shared/src/ranked.ts` + teste com o exemplo numérico do artigo do Glickman |
| **Pontos de Patente (PP)** visíveis, que convergem para o MMR: quem está abaixo do nível real ganha mais e perde menos | ✅ | `ranked.test.ts` (17 testes) |
| **5 partidas de classificação** por modo; a patente fica oculta até terminar (API, menu, resultado e ranking) | ✅ | Testes de API + E2E |
| Bônus pequeno por sequência de vitórias (a partir da 3ª) e por MVP | ✅ | Testes |
| **Abandono**: derrota com penalidade extra, o time abandonado perde menos, e a fila ranqueada bloqueia por 5, 15 ou 60 min (calculado no servidor a partir do banco, nas últimas 24 h) | ✅ | Testes + E2E (tela bloqueia e o servidor recusa pedido forçado) |
| **Fila ranqueada separada da casual**, por modo. A faixa de MMR aceita começa em ±100 e abre 25 por segundo de espera (teto ±800) | ✅ | `ranked.test.ts` do servidor (janela de MMR) |
| **Equipes balanceadas por MMR** em 2v2 e 3v3 (menor diferença de média entre os times) | ✅ | Teste de 2v2 com MMRs desiguais |
| Resultado ranqueado **calculado e gravado só pelo servidor**, na mesma transação da partida; o cliente só exibe | ✅ | Testes de persistência + E2E compara tela × banco |
| Partida casual não mexe em PP nem em MMR | ✅ | Teste |
| **Temporadas**: encerrar (grava o top 100 por modo), iniciar a próxima com reinício parcial (MMR puxado para a média, parte dos PP mantida) e nova classificação | ✅ | Testes da API de administração (com auditoria) |
| **Ranking da temporada** por modo (só jogadores com patente revelada) com a posição do próprio jogador | ✅ | Testes + E2E |
| Tela **Ranqueado**: patente e progresso por modo, classificação, estatísticas, histórico com PP, ranking e as 15 patentes | ✅ | Capturas 27 e 31 |
| Tela **Jogar** com escolha Casual ou Ranqueado; resultado da partida mostra PP ganhos ou perdidos, promoção e queda | ✅ | Capturas 28–30 |
| **MMR nunca sai do servidor** (nenhuma rota ou mensagem o expõe) | ✅ | Teste de API + E2E |

**Testes:** 67 no servidor (14 novos de ranqueado), 74 no shared (17 novos), 11 no cliente + E2E das Fases 1–4 + **E2E Fase 5 com quatro navegadores reais em duas ranqueadas 1v1** (`scripts/e2e-ranked.mjs`).

### Limites honestos da Fase 5
- **O E2E termina as partidas por abandono (W.O.)**, não jogando até o fim: uma ranqueada completa leva vários minutos no renderizador por software. O combate em si já é coberto pelos E2E das Fases 3 e 4. Para testar patente revelada e ganho de PP sem jogar 5 partidas por conta, o E2E ajusta o andamento da classificação de duas contas de teste direto no banco de desenvolvimento (está marcado como fixture no script).
- **Dois E2E antigos falharam uma vez e passaram na repetição** durante esta fase: o de multiplayer (placar lido como 0 × 0 logo após a reconexão) e o de treino (andou 1,44 m onde o teste exige 1,5 m). Os dois dependem de tempo no renderizador por software; não achei erro de código, mas a leitura do placar após reconectar merece ser observada numa máquina com GPU.
- **W.O. sem nenhuma ação não dá MVP** (nem o bônus de MVP), para não premiar partida que não foi jogada. A vitória e os pontos normais continuam valendo.
- **Sem população, a fila demora.** Não há bots: com poucos jogadores, a faixa de MMR abre até ±800 e mesmo assim pode não achar partida. É o comportamento correto, mas o lançamento precisa de gente online.
- **Fila em memória**, em um único processo do servidor de jogo. Para vários servidores, a fila precisa ir para o Redis (previsto na Fase 8).
- **Sem detecção de combinação de resultado** (duas contas se revezando em derrotas) nem de smurf. Entra com o anticheat e a moderação.
- **Recompensas de fim de temporada** dependem da economia (Fase 6). Hoje o encerramento só registra o ranking.
- **Sem painel de administração**: iniciar e encerrar temporada é por rota protegida (`POST /admin/ranked/seasons/start` e `/close`, papel ADMIN). A troca não é automática na data final; a temporada vencida para de valer pontos e alguém precisa iniciar a próxima.
- **Em produção a Temporada 1 nasce inativa** para você decidir a data de início. Em desenvolvimento o seed já a ativa.
- **Sem grupos (duo/trio) na fila**: todos entram sozinhos. Grupos chegam com amigos, na Fase 7.
- **Votação de mapa** continua fora: o mapa segue o rodízio também no ranqueado.
- A partir desta fase o desenvolvimento passou a ser feito com o modelo Claude Fable 5.2 (as Fases 1–4 foram feitas com o Claude Opus). Isso é só a ferramenta de desenvolvimento: nenhum conteúdo do jogo usa IA em tempo de execução.

## Fase 6 — Economia ✅ (15/11/2026)

| Item | Status | Evidência |
|---|---|---|
| **Carteira de VANTA COINS com razão contábil** somente-inserção: todo crédito e débito é um lançamento com chave de idempotência; o saldo é o cache da soma, com bloqueio otimista; nunca fica negativo | ✅ | `economy.test.ts` (razão = saldo em todos os cenários) |
| **Saldo e preço sempre do servidor**: o cliente só diz qual item quer; preço ou saldo enviados pelo navegador são ignorados | ✅ | Teste + E2E (compra com preço adulterado cobra o preço do banco) |
| **Loja de cosméticos**: 14 skins de arma e 8 de operador, preço por raridade (300 / 600 / 1.200 / 2.000 VC), sem caixas aleatórias | ✅ | Seed a partir de `packages/shared/src/cosmetics.ts` + captura 34 |
| **Compra com VC**: débito e entrega do item na mesma transação; sem compra repetida, nem com 5 cliques simultâneos; compras paralelas nunca passam do saldo | ✅ | Testes de concorrência |
| **Inventário e equipar**: uma skin por operador e uma por arma; emblemas são de coleção | ✅ | Testes + E2E + captura 36 |
| **Skins aparecem no jogo**: operador no menu e para os outros jogadores na partida; arma em 1ª pessoa (também no treino). Só cor e padrão: mesma silhueta e mesma hitbox | ✅ | E2E (partida real) + capturas 33 a 35 |
| **Prévia 3D na loja** com os mesmos modelos do jogo | ✅ | Capturas 33 e 34 |
| **Compra de VC com Stripe Checkout**: o cartão é digitado na página da Stripe; o jogo não vê nem guarda dados de cartão; pedido com valores copiados do pacote; e-mail confirmado obrigatório | ✅ (código e testes) | `payments.ts` + testes com eventos assinados |
| **Webhook assinado** é o único caminho que credita: assinatura conferida, evento gravado uma vez, pedido creditado uma vez, valor pago conferido com o pedido, pagamento assíncrono (Pix/boleto) só credita quando confirmado, sessão expirada encerra o pedido | ✅ (código e testes) | 6 testes de webhook |
| **Estorno e chargeback** retiram as moedas (proporcional no estorno parcial); se o jogador já gastou, o saldo zera e o que faltou fica registrado; contestação vencida devolve | ✅ (código e testes) | Teste |
| **Sem chaves da Stripe, a compra de VC fica desativada** e a tela avisa. Nada é simulado | ✅ | Teste + E2E + captura 37 |
| **Recompensas de fim de temporada**: VC pelo melhor tier alcançado (100 a 1.000) e emblema da temporada, uma vez por jogador, só para quem terminou a classificação | ✅ | Teste |
| **Ajuste de saldo pelo administrador** (`POST /admin/wallet/adjust`), idempotente e auditado | ✅ | Teste + E2E |
| Histórico da carteira paginado | ✅ | Teste + E2E |

**Testes:** 90 no servidor (23 novos de economia), 78 no shared (4 novos de cosméticos), 11 no cliente + E2E das Fases 1–5 + **E2E Fase 6** (`scripts/e2e-economy.mjs`, 10 etapas): loja, ajuste administrativo auditado, compras com saldo conferido no banco e no razão, servidor recusando compra repetida e preço adulterado, menu e inventário com a skin, aviso de pagamentos desativados e uma partida 1v1 real em que o adversário recebe a skin.

### Limites honestos da Fase 6
- **A compra real com a Stripe não foi feita de ponta a ponta.** Não há chaves da Stripe neste ambiente e o contêiner não alcança `api.stripe.com`. A criação do Checkout é testada com um cliente Stripe falso (a sessão não sai para a rede), e o webhook é testado com eventos assinados pela própria biblioteca da Stripe, com o mesmo segredo que o servidor confere. Para ativar: crie uma conta Stripe, coloque `STRIPE_SECRET_KEY` (sk_test_…) e `STRIPE_WEBHOOK_SECRET` (whsec_…) no `.env` do servidor e aponte um webhook para `https://SEU_DOMINIO/api/payments/stripe/webhook` com os eventos `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded`, `charge.dispute.created` e `charge.dispute.closed`. Em desenvolvimento, `stripe listen --forward-to localhost:4000/payments/stripe/webhook` faz o mesmo. Depois disso, um teste com o cartão de teste da Stripe precisa ser feito antes de abrir a loja ao público.
- **No E2E, o saldo inicial vem de um ajuste administrativo** (rota real e auditada, com a conta promovida pelo comando `create-admin`), porque não há como pagar de verdade aqui.
- **Preço em reais e impostos**: os pacotes estão em BRL (R$ 9,90 a R$ 149,90). Emissão de nota fiscal, termos de compra e política de reembolso dependem de você (empresa e contador). A Stripe pode calcular impostos (Stripe Tax), mas não ativei.
- **Menores de idade**: o cadastro guarda a data de nascimento, mas a compra de VC ainda não exige consentimento dos responsáveis. Antes de abrir a loja, decida a regra (bloquear abaixo de 18 ou exigir consentimento).
- **Skins são cores e padrões** sobre os modelos procedurais, não modelos novos. A silhueta é sempre a mesma, o que também garante que nenhuma skin muda a leitura do jogador em combate.
- **Outros jogadores não veem a sua skin de arma**: o modelo de arma em 3ª pessoa é um só para todos. Eles veem a skin do operador.
- **Emblemas são só de coleção** (aparecem no inventário). Mostrar o emblema no perfil e no ranking fica para a Fase 7, com o perfil público.
- **Sem painel de administração**: pacotes, preços e itens mudam pelo seed ou pelo banco; ajuste de saldo é por rota de ADMIN. O painel é da Fase 7.
- **Itens não são devolvidos em estorno**: o estorno retira as moedas (e pode zerar o saldo), mas o item comprado com elas continua no inventário. Revogar itens exige decidir qual item sai; ficou registrado como pendência.
- **E2E de treino ajustado**: ele segurava W por 1,2 s fixos e falhou duas vezes andando 1,44 m. Causa: com o renderizador por software o quadro passa de 100 ms e o jogo simula no máximo 0,1 s por quadro, então o tempo real não vira distância. Agora o teste segura W até andar 1,5 m (até 8 s) e também confere que não desviou para o lado. Numa máquina com GPU isso não acontece.
- **Salas personalizadas** apareciam no menu como "Fase 3" mas não foram feitas na Fase 3. O menu agora indica Fase 7, junto com os sistemas sociais.

## Fase 7 — Sistemas adicionais 🔄 (em andamento, dividida em 5 partes)

### Parte 1 — Social ✅ (15/11/2026)

| Item | Status | Evidência |
|---|---|---|
| **Pedidos de amizade**: enviar por nome (sem diferenciar maiúsculas), aceitar, recusar, cancelar; adicionar quem já te convidou aceita direto; limite de 200 amigos; dois cliques ao mesmo tempo criam uma amizade só | ✅ | `test/social.test.ts` + E2E + captura 38 |
| **Lista de amigos com presença ao vivo** (online, na fila, em partida, offline), calculada no servidor e enviada só para amigos | ✅ | `test/social-game.test.ts` + E2E |
| **Avisos em tempo real**: pedido recebido e amizade aceita chegam na hora (API → Redis → servidor de jogo → navegador) e ficam também em notificações | ✅ | Testes + E2E |
| **Jogadores recentes** das últimas 20 partidas, indicando aliado ou adversário, com adicionar, denunciar e bloquear | ✅ | Teste + E2E + captura 44 |
| **Bloquear**: desfaz amizade, cancela pedidos, impede pedidos, convites e chat nos dois sentidos; quem foi bloqueado não descobre (a conta "não é encontrada") | ✅ | Testes + E2E |
| **Silenciar no chat** (mais leve que bloquear), aplicado no servidor | ✅ | Teste |
| **Grupo de até 3**: convite para amigo online (expira em 60 s), líder, remover, sair, 60 s para voltar se cair; bloquear alguém do grupo separa os dois | ✅ | Testes + E2E + captura 39 |
| **Fila com grupo**: só o líder procura; o grupo entra inteiro, nunca é separado e fica no mesmo time; cada membro usa o próprio arsenal; se alguém cancela, o grupo todo sai | ✅ | Testes (`packParties` + partida 2v2 com grupo) + E2E + captura 41 |
| **Chat de texto**: grupo (menu e tela Jogar), equipe e todos na partida (Enter / Shift+Enter); texto limpo no servidor; anti-flood; banimento de chat da moderação; chat da partida gravado para denúncias | ✅ | Testes + E2E + captura 42 |
| **Denúncias** com motivo e descrição, pela lista de recentes, de amigos ou pelo resultado da partida (ligada à partida); uma por jogador a cada 24 h | ✅ | Teste + E2E + captura 43 |
| Botão de amigos no topo do menu com contagem de online e de pedidos | ✅ | E2E |

**Correções que o E2E encontrou:** (1) num PC lento, o navegador ocupado compilando os gráficos do menu demorava mais de 5 s para se identificar no servidor de jogo, que respondia como "sessão inválida", e o cliente deslogava o jogador. Agora o prazo é de 15 s, a demora não é tratada como sessão inválida e, mesmo quando o token é recusado, o cliente tenta renovar a sessão antes de deslogar. (2) Uma trava de mouse pedida antes de abrir o chat chegava atrasada e "roubava" as teclas digitadas. (3) Uma ressincronização da partida apagava o chat da tela.

**Testes:** 109 no servidor (19 novos), 84 no shared (6 novos), 11 no cliente + E2E das Fases 1–6 repetidos (menu, treino 9/9, multiplayer 11/11, ranqueado 10/10, economia 10/10) + **E2E social com três navegadores** (`scripts/e2e-social.mjs`, 11 etapas).

#### Limites honestos da parte 1
- **Ranqueado continua individual.** Grupos jogam só no casual. Grupo no ranqueado exige regras de MMR para grupos (ex.: limite de diferença de patente) que ainda não defini.
- **Sem filtro automático de palavrões.** O chat depende de silenciar, bloquear, denunciar e do banimento de chat aplicado pela moderação (o painel de moderação é a parte 5).
- **Chat de voz não existe.** A arquitetura para recebê-lo está descrita em `docs/ARCHITECTURE.md`.
- **Mensagens diretas entre amigos fora do grupo** não foram feitas: a conversa acontece no grupo ou na partida.
- **Presença e grupos vivem na memória de um processo de jogo.** Com vários processos, a presença e os grupos precisam passar para o Redis (Fase 8). Os eventos da API já passam pelo Redis.
- **E2E de mapas (5 partidas, ~12 min) não foi repetido** nesta parte: a mudança na fila é coberta pelos E2E multiplayer e ranqueado e pelos testes da fila.

### Partes 2 a 5 ⏳
Salas personalizadas e espectador · XP, missões, conquistas, medalhas, títulos, eventos, cartão de jogador, clãs e perfil público · replays, kill cam e apresentação do MVP · painel administrativo e teclas remapeáveis.

## Fase 8 ⏳
Finalização (carga, segurança, Docker, CI, deploy).
