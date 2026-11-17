import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeTestContext, createTestContext, getRefreshCookie, newPlayer, resetState, tokenFromMail, type TestContext } from "./helpers.js";

let ctx: TestContext;
const WEB = { "x-vanta-client": "web" };

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => closeTestContext(ctx));
beforeEach(async () => resetState(ctx));

async function register(body = newPlayer()) {
  const res = await ctx.app.inject({ method: "POST", url: "/auth/register", payload: body });
  return { res, body, json: res.json() };
}

async function login(identifier: string, password: string, remoteAddress = "10.0.0.1") {
  return ctx.app.inject({ method: "POST", url: "/auth/login", payload: { identifier, password }, remoteAddress });
}

describe("cadastro", () => {
  it("cria conta, perfil e carteira zerada, sem guardar a senha em texto", async () => {
    const { res, body, json } = await register();
    expect(res.statusCode).toBe(201);
    expect(json.accessToken).toBeTypeOf("string");
    expect(json.user).toMatchObject({ username: body.username, email: body.email, emailVerified: false, role: "PLAYER" });
    expect(json.user.passwordHash).toBeUndefined();

    const cookie = res.cookies.find((c) => c.name === "vanta_rt")!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe("Strict");
    expect(cookie.path).toBe("/api/auth");

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: body.email }, include: { profile: true, wallet: true } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user.passwordHash).not.toContain(body.password);
    expect(user.wallet?.balance).toBe(0);
    expect(user.profile?.level).toBe(1);
    expect(user.profile?.mainCharacterId).not.toBeNull();
  });

  it("envia e-mail de verificação", async () => {
    const { body } = await register();
    expect(ctx.mailer.lastTo(body.email)?.subject).toContain("Confirme seu e-mail");
  });

  it("rejeita dados inválidos com mensagem em português", async () => {
    const r1 = await register(newPlayer({ password: "curta1" }));
    expect(r1.res.statusCode).toBe(400);
    expect(r1.json.error.code).toBe("VALIDATION_ERROR");
    expect(r1.json.error.message).toContain("10 caracteres");

    const r2 = await register(newPlayer({ username: "nome com espaço" }));
    expect(r2.res.statusCode).toBe(400);
    const r3 = await register(newPlayer({ acceptTerms: false }));
    expect(r3.res.statusCode).toBe(400);
    const r4 = await register(newPlayer({ email: "nao-e-email" }));
    expect(r4.res.statusCode).toBe(400);
  });

  it("bloqueia menores de 13 anos", async () => {
    const year = new Date().getUTCFullYear() - 10;
    const { res, json } = await register(newPlayer({ birthDate: `${year}-01-01` }));
    expect(res.statusCode).toBe(400);
    expect(json.error.code).toBe("AGE_RESTRICTION");
  });

  it("não permite e-mail nem nome de jogador duplicados (sem diferenciar maiúsculas)", async () => {
    const first = newPlayer();
    await register(first);
    const dupEmail = await register(newPlayer({ email: first.email.toUpperCase() }));
    expect(dupEmail.res.statusCode).toBe(409);
    expect(dupEmail.json.error.code).toBe("EMAIL_TAKEN");
    const dupName = await register(newPlayer({ username: first.username.toUpperCase() }));
    expect(dupName.res.statusCode).toBe(409);
    expect(dupName.json.error.code).toBe("USERNAME_TAKEN");
  });

  it("reserva nomes da equipe", async () => {
    const { res } = await register(newPlayer({ username: "Admin_Vanta" }));
    expect(res.statusCode).toBe(409);
  });
});

describe("login", () => {
  it("entra por e-mail ou por nome de jogador", async () => {
    const { body } = await register();
    const byEmail = await login(body.email, body.password);
    expect(byEmail.statusCode).toBe(200);
    const byName = await login(body.username.toLowerCase(), body.password);
    expect(byName.statusCode).toBe(200);
    expect(getRefreshCookie(byName)).toBeTruthy();
  });

  it("recusa senha errada e usuário inexistente com a mesma mensagem", async () => {
    const { body } = await register();
    const wrong = await login(body.email, "SenhaErrada999");
    const ghost = await login("ninguem@teste.vanta", "SenhaErrada999");
    expect(wrong.statusCode).toBe(401);
    expect(ghost.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(ghost.json().error.message);
  });

  it("bloqueia após 5 tentativas erradas, mesmo com a senha certa, e registra evento de segurança", async () => {
    const { body } = await register();
    for (let i = 0; i < 5; i++) expect((await login(body.email, "SenhaErrada999", "10.0.0.7")).statusCode).toBe(401);
    // Trocar e-mail por username não burla o contador (ele é por conta).
    const blocked = await login(body.username, body.password, "10.0.0.7");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    // Outro IP continua podendo entrar (o bloqueio conta+IP não derruba o dono legítimo).
    expect((await login(body.email, body.password, "10.0.0.8")).statusCode).toBe(200);
    const events = await ctx.prisma.securityEvent.count({ where: { type: "LOGIN_FAILED" } });
    expect(events).toBe(5);
  });

  it("impede login de conta banida e de conta suspensa", async () => {
    const { body } = await register();
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    await ctx.prisma.user.update({ where: { id: user.id }, data: { status: "BANNED" } });
    await ctx.prisma.ban.create({ data: { userId: user.id, type: "PERMANENT", reason: "Uso de trapaça" } });
    const res = await login(body.email, body.password);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toContain("Uso de trapaça");

    const other = (await register()).body;
    const u2 = await ctx.prisma.user.findUniqueOrThrow({ where: { email: other.email } });
    await ctx.prisma.user.update({ where: { id: u2.id }, data: { status: "SUSPENDED" } });
    await ctx.prisma.ban.create({ data: { userId: u2.id, type: "SUSPENSION", reason: "Toxicidade", endsAt: new Date(Date.now() + 3600_000) } });
    expect((await login(other.email, other.password)).statusCode).toBe(403);
  });

  it("libera automaticamente uma suspensão vencida", async () => {
    const { body } = await register();
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { email: body.email } });
    await ctx.prisma.user.update({ where: { id: user.id }, data: { status: "SUSPENDED" } });
    await ctx.prisma.ban.create({ data: { userId: user.id, type: "SUSPENSION", reason: "x", startsAt: new Date(Date.now() - 7200_000), endsAt: new Date(Date.now() - 60_000) } });
    expect((await login(body.email, body.password)).statusCode).toBe(200);
  });
});

describe("autenticação e sessão", () => {
  it("GET /me exige token e retorna dados reais da conta", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer lixo" } })).statusCode).toBe(401);

    const { json, body } = await register();
    const me = await ctx.app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${json.accessToken}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { username: body.username }, profile: { level: 1, totalXp: 0 }, wallet: { balance: 0, currency: "VC" } });
    // Com temporada em andamento, a conta nova aparece em classificação e sem pontos; sem temporada, `ranked` é null.
    const ranked = me.json().ranked;
    expect(ranked === null || (ranked.points === 0 && ranked.placementMatchesLeft > 0)).toBe(true);
  });

  it("rejeita token assinado com outro segredo ou com algoritmo 'none'", async () => {
    const { json } = await register();
    const [h, p] = json.accessToken.split(".");
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const forged = `${noneHeader}.${p}.`;
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${forged}` } })).statusCode).toBe(401);
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, "base64url").toString()), role: "SUPERADMIN" })).toString("base64url")}.${json.accessToken.split(".")[2]}`;
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${tampered}` } })).statusCode).toBe(401);
  });

  it("rotaciona o refresh token e exige o header anti-CSRF", async () => {
    const { res } = await register();
    const rt1 = getRefreshCookie(res)!;
    const noHeader = await ctx.app.inject({ method: "POST", url: "/auth/refresh", cookies: { vanta_rt: rt1 } });
    expect(noHeader.statusCode).toBe(403);

    const r2 = await ctx.app.inject({ method: "POST", url: "/auth/refresh", cookies: { vanta_rt: rt1 }, headers: WEB });
    expect(r2.statusCode).toBe(200);
    const rt2 = getRefreshCookie(r2)!;
    expect(rt2).not.toBe(rt1);
    expect(r2.json().accessToken).toBeTypeOf("string");
  });

  it("detecta reuso de refresh token antigo e revoga toda a família", async () => {
    const { res } = await register();
    const rt1 = getRefreshCookie(res)!;
    const r2 = await ctx.app.inject({ method: "POST", url: "/auth/refresh", cookies: { vanta_rt: rt1 }, headers: WEB });
    const rt2 = getRefreshCookie(r2)!;

    // Simula o token antigo sendo usado por um atacante depois da janela de tolerância.
    await ctx.prisma.authSession.updateMany({ where: { revokedReason: "ROTATED" }, data: { revokedAt: new Date(Date.now() - 60_000) } });
    const reuse = await ctx.app.inject({ method: "POST", url: "/auth/refresh", cookies: { vanta_rt: rt1 }, headers: WEB });
    expect(reuse.statusCode).toBe(401);
    // O token legítimo mais recente também foi revogado.
    const legit = await ctx.app.inject({ method: "POST", url: "/auth/refresh", cookies: { vanta_rt: rt2 }, headers: WEB });
    expect(legit.statusCode).toBe(401);
    expect(await ctx.prisma.securityEvent.count({ where: { type: "REFRESH_TOKEN_REUSE" } })).toBe(1);
  });

  it("token recém-rotacionado (página recarregou no meio da renovação) ainda renova, na mesma família", async () => {
    const { res } = await register();
    const rt1 = getRefreshCookie(res)!;
    const r2 = await ctx.app.inject({ method: "POST", url: "/auth/refresh", cookies: { vanta_rt: rt1 }, headers: WEB });
    expect(r2.statusCode).toBe(200);
    // A resposta com rt2 "se perdeu": o navegador manda rt1 de novo, dentro da tolerância.
    const again = await ctx.app.inject({ method: "POST", url: "/auth/refresh", cookies: { vanta_rt: rt1 }, headers: WEB });
    expect(again.statusCode).toBe(200);
    const rt3 = getRefreshCookie(again)!;
    expect(rt3).not.toBe(rt1);
    const s1 = await ctx.prisma.authSession.findFirstOrThrow({ where: { revokedReason: "ROTATED" } });
    const s3 = await ctx.prisma.authSession.findMany({ where: { familyId: s1.familyId, revokedAt: null } });
    expect(s3).toHaveLength(2);
    expect(await ctx.prisma.securityEvent.count({ where: { type: "REFRESH_TOKEN_REUSE" } })).toBe(0);
    // Depois de um logout (família sem sessão viva), o token antigo não ressuscita nada.
    await ctx.app.inject({ method: "POST", url: "/auth/logout-all", headers: { authorization: `Bearer ${again.json().accessToken}` } });
    expect((await ctx.app.inject({ method: "POST", url: "/auth/refresh", cookies: { vanta_rt: rt1 }, headers: WEB })).statusCode).toBe(401);
  });

  it("logout revoga a sessão atual", async () => {
    const { res } = await register();
    const rt = getRefreshCookie(res)!;
    expect((await ctx.app.inject({ method: "POST", url: "/auth/logout", cookies: { vanta_rt: rt }, headers: WEB })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "POST", url: "/auth/refresh", cookies: { vanta_rt: rt }, headers: WEB })).statusCode).toBe(401);
  });

  it("logout global invalida tokens de acesso já emitidos", async () => {
    const { json } = await register();
    const auth = { authorization: `Bearer ${json.accessToken}` };
    expect((await ctx.app.inject({ method: "POST", url: "/auth/logout-all", headers: auth })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: auth })).statusCode).toBe(401);
  });

  it("banimento tem efeito imediato em token de acesso válido", async () => {
    const { json, body } = await register();
    await ctx.prisma.user.update({ where: { email: body.email }, data: { status: "BANNED" } });
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${json.accessToken}` } })).statusCode).toBe(401);
  });
});

describe("verificação de e-mail", () => {
  it("confirma o e-mail com o token enviado; token não pode ser reutilizado", async () => {
    const { body, json } = await register();
    const token = tokenFromMail(ctx.mailer.lastTo(body.email)!.text);
    const ok = await ctx.app.inject({ method: "POST", url: "/auth/verify-email", payload: { token } });
    expect(ok.statusCode).toBe(200);
    const me = await ctx.app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${json.accessToken}` } });
    expect(me.json().user.emailVerified).toBe(true);
    const again = await ctx.app.inject({ method: "POST", url: "/auth/verify-email", payload: { token } });
    expect(again.statusCode).toBe(400);
  });

  it("recusa token inexistente", async () => {
    const res = await ctx.app.inject({ method: "POST", url: "/auth/verify-email", payload: { token: "x".repeat(43) } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_TOKEN");
  });
});

describe("recuperação de senha", () => {
  it("responde igual para e-mail existente e inexistente", async () => {
    const { body } = await register();
    const a = await ctx.app.inject({ method: "POST", url: "/auth/forgot-password", payload: { email: body.email } });
    const b = await ctx.app.inject({ method: "POST", url: "/auth/forgot-password", payload: { email: "nao-existe@teste.vanta" } });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(a.json()).toEqual(b.json());
    expect(ctx.mailer.lastTo("nao-existe@teste.vanta")).toBeUndefined();
  });

  it("redefine a senha, derruba sessões antigas e o link vale uma vez", async () => {
    const { body, res, json } = await register();
    const oldRt = getRefreshCookie(res)!;
    await ctx.app.inject({ method: "POST", url: "/auth/forgot-password", payload: { email: body.email } });
    const token = tokenFromMail(ctx.mailer.lastTo(body.email)!.text);

    const weak = await ctx.app.inject({ method: "POST", url: "/auth/reset-password", payload: { token, password: "fraca" } });
    expect(weak.statusCode).toBe(400);

    const ok = await ctx.app.inject({ method: "POST", url: "/auth/reset-password", payload: { token, password: "NovaSenha456789" } });
    expect(ok.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/auth/reset-password", payload: { token, password: "OutraSenha456789" } })).statusCode).toBe(400);

    expect((await login(body.email, body.password)).statusCode).toBe(401);
    expect((await login(body.email, "NovaSenha456789")).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "POST", url: "/auth/refresh", cookies: { vanta_rt: oldRt }, headers: WEB })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${json.accessToken}` } })).statusCode).toBe(401);
  });

  it("recusa link expirado", async () => {
    const { body } = await register();
    await ctx.app.inject({ method: "POST", url: "/auth/forgot-password", payload: { email: body.email } });
    const token = tokenFromMail(ctx.mailer.lastTo(body.email)!.text);
    await ctx.prisma.passwordResetToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await ctx.app.inject({ method: "POST", url: "/auth/reset-password", payload: { token, password: "NovaSenha456789" } })).statusCode).toBe(400);
  });
});

describe("proteções gerais", () => {
  it("limita requisições excessivas de login por IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await login(`inexistente${i}@teste.vanta`, "x", "10.9.9.9")).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it("CORS bloqueia origens não autorizadas e permite o cliente oficial", async () => {
    const bad = await ctx.app.inject({ method: "GET", url: "/content/ranks", headers: { origin: "https://site-malicioso.example" } });
    expect(bad.statusCode).toBe(403);
    const good = await ctx.app.inject({ method: "GET", url: "/content/ranks", headers: { origin: "http://localhost:5173" } });
    expect(good.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("health check reporta banco e Redis", async () => {
    const res = await ctx.app.inject({ method: "GET", url: "/health" });
    expect(res.json()).toMatchObject({ status: "ok", checks: { db: true, redis: true } });
  });
});

describe("perfil", () => {
  it("seleciona o operador em destaque e recusa IDs inválidos", async () => {
    const { json } = await register();
    const auth = { authorization: `Bearer ${json.accessToken}` };
    const chars = (await ctx.app.inject({ method: "GET", url: "/content/characters" })).json();
    const nova = chars.find((c: { code: string }) => c.code === "NOVA");
    const ok = await ctx.app.inject({ method: "POST", url: "/me/character", headers: auth, payload: { characterId: nova.id } });
    expect(ok.statusCode).toBe(200);
    const me = (await ctx.app.inject({ method: "GET", url: "/me", headers: auth })).json();
    expect(me.profile.mainCharacterId).toBe(nova.id);
    expect((await ctx.app.inject({ method: "POST", url: "/me/character", headers: auth, payload: { characterId: "inexistente" } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: "POST", url: "/me/character", payload: { characterId: nova.id } })).statusCode).toBe(401);
  });
});
