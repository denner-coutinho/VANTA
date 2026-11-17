import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GAME_PROTOCOL_VERSION } from "@vanta/shared";
import { GameServer } from "../src/game/server.js";
import { loadConfig } from "../src/config/env.js";
import { TestClient } from "./game-helpers.js";
import { closeTestContext, createTestContext, newPlayer, resetState, type TestContext } from "./helpers.js";

const SECRET = "segredo-de-teste-com-mais-de-32-caracteres-ok";
const TOKEN = "token-de-metricas-de-teste-0123456789";
let ctx: TestContext;
let gs: GameServer;
let base: string;

beforeAll(async () => {
  ctx = await createTestContext();
  await resetState(ctx);
  gs = new GameServer({ prisma: ctx.prisma, jwtSecret: SECRET, allowedOrigins: [], autoTick: false, metricsToken: TOKEN, log: { info() {}, warn() {}, error: console.error } });
  const port = await gs.start(0, "127.0.0.1");
  base = `127.0.0.1:${port}`;
});
afterAll(async () => {
  await gs.stop();
  await closeTestContext(ctx);
});

describe("métricas da API", () => {
  it("fica desligada sem token e exige o token certo", async () => {
    ctx.app.config.METRICS_TOKEN = "";
    expect((await ctx.app.inject({ url: "/metrics" })).statusCode).toBe(404);
    ctx.app.config.METRICS_TOKEN = TOKEN;
    expect((await ctx.app.inject({ url: "/metrics" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ url: "/metrics", headers: { authorization: `Bearer ${TOKEN}x` } })).statusCode).toBe(401);
  });

  it("conta requisições pela rota declarada, não pela URL", async () => {
    ctx.app.config.METRICS_TOKEN = TOKEN;
    await ctx.app.inject({ url: "/players/alguem-que-nao-existe" });
    await ctx.app.inject({ url: "/health" });
    const res = await ctx.app.inject({ url: "/metrics", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toMatch(/vanta_http_requests_total\{method="GET",route="\/players\/:username",status="401",service="api"\} 1/);
    expect(res.body).toMatch(/vanta_http_request_duration_seconds_bucket\{.*route="\/health"/);
    expect(res.body).not.toContain("alguem-que-nao-existe");
    expect(res.body).toContain("vanta_process_cpu_seconds_total");
    expect(res.body).toContain("vanta_nodejs_eventloop_lag_seconds");
  });
});

describe("métricas do servidor de jogo", () => {
  it("exige o token e mostra conexões, mensagens e ticks", async () => {
    expect((await fetch(`http://${base}/metrics`)).status).toBe(401);
    const reg = await ctx.app.inject({ method: "POST", url: "/auth/register", payload: newPlayer() });
    const c = new TestClient(`ws://${base}/game`);
    await c.open();
    c.send({ t: "hello", token: reg.json().accessToken, v: GAME_PROTOCOL_VERSION });
    await c.waitFor("welcome");
    c.send({ t: "nao_existe" });
    await c.waitFor("error");
    gs.stepAll();
    const body = await (await fetch(`http://${base}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } })).text();
    expect(body).toMatch(/vanta_game_connections\{service="game"\} 1/);
    expect(body).toMatch(/vanta_game_players_online\{service="game"\} 1/);
    expect(body).toMatch(/vanta_game_messages_in_total\{type="hello",service="game"\} 1/);
    expect(body).toMatch(/vanta_game_rejected_total\{reason="bad_message",service="game"\} 1/);
    expect(body).toMatch(/vanta_game_bytes_out_total\{service="game"\} [1-9]/);
    expect(body).toContain("vanta_game_tick_duration_seconds_bucket");
    c.close();
  });

  it("produção recusa token de métricas fraco", () => {
    const prod = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://vanta:Xk29fhQ7pLm3Zs8a@postgres:5432/vanta",
      JWT_ACCESS_SECRET: "q8Zr2LkP0vN7xWc4Ty1Hb6Jm9Df3Ga5Se8Ru0Io2Pl",
      PUBLIC_APP_URL: "https://jogar.exemplo.com",
      CORS_ORIGINS: "https://jogar.exemplo.com",
      SMTP_HOST: "smtp.exemplo.com",
    };
    expect(() => loadConfig({ ...prod, METRICS_TOKEN: "curto" })).toThrow(/METRICS_TOKEN/);
    expect(loadConfig({ ...prod, METRICS_TOKEN: "Vb7Lq2Zx9Rk4Tm1Wc8Np3Hs6" }).METRICS_TOKEN).toHaveLength(24);
  });
});
