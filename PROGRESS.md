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
- **Botões JOGAR, RANQUEADO, SALAS, LOJA, INVENTÁRIO**: visíveis e marcados com a fase em que serão liberados; ao clicar, avisam isso. Nenhum finge funcionar.
- **Amigos online / eventos**: leem dados reais (hoje vazios). Não há jogadores ou eventos inventados.
- **Temporada 1** criada inativa; ativação pelo painel admin (Fase 5).

### Pendências que dependem de você
- **Repositório GitHub**: o código está na pasta do projeto, mas sem um repositório ele não tem histórico remoto nem backup. Crie um repositório vazio e me diga o nome.
- **SMTP** para e-mails reais (qualquer provedor: Resend, SES, Brevo, etc.).
- **Stripe** (Fase 6): conta, chave secreta de teste e segredo do webhook.
- **Hospedagem** (Fase 8): API e servidor de jogo precisam de um servidor com WebSocket (VPS, Fly.io, Railway etc.); o cliente pode ficar em CDN.

## Fase 2 — Gameplay ⏳
Movimentação com tick fixo, pointer lock, câmera em primeira pessoa, armas lidas do banco (dano, cadência, recuo, dispersão), raycast com hitbox de cabeça/corpo, recarga, munição, troca de armas, colisões, primeiro mapa (Neon District), modo treinamento contra alvos.

## Fase 3 — Multiplayer ⏳
Colyseus autoritativo, sincronização, predição/interpolação, reconexão, salas, partidas 1v1/2v2/3v3.

## Fases 4–8 ⏳
Conteúdo (mapas, personagens, armas, áudio) · Competitivo (MMR Glicko-2, 15 patentes, temporadas, ranking) · Economia (VC, loja, inventário, Stripe Checkout + webhooks) · Sistemas sociais (amigos, clãs, missões, replays, kill cam) · Finalização (carga, segurança, Docker, CI, deploy).
