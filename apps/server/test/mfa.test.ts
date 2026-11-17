import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SecretBox, base32Decode, base32Encode, hotp, totp, totpStep, verifyTotp } from "../src/lib/totp.js";
import { closeTestContext, createTestContext, enableMfa, freshTotp, getRefreshCookie, newPlayer, resetState, type TestContext } from "./helpers.js";

let ctx: TestContext;
const WEB = { "x-vanta-client": "web" };
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => closeTestContext(ctx));
beforeEach(async () => resetState(ctx));

describe("TOTP (RFC 4226 / 6238)", () => {
  const key = Buffer.from("12345678901234567890");
  it("bate com os vetores de teste das RFCs", () => {
    // RFC 4226, apêndice D.
    expect([0, 1, 2, 3, 9].map((c) => hotp(key, c))).toEqual(["755224", "287082", "359152", "969429", "520489"]);
    // RFC 6238, apêndice B (SHA-1), com 8 dígitos.
    expect(hotp(key, Math.floor(59 / 30), 8)).toBe("94287082");
    expect(hotp(key, Math.floor(1111111109 / 30), 8)).toBe("07081804");
    expect(hotp(key, Math.floor(20000000000 / 30), 8)).toBe("65353130");
    expect(base32Decode(base32Encode(key)).equals(key)).toBe(true);
    expect(base32Encode(key)).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  });

  it("aceita um passo de diferença no relógio, e nada além", () => {
    const secret = base32Encode(key);
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(totpStep(now));
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).toBe(totpStep(now) - 1);
    expect(verifyTotp(secret, totp(secret, now + 30_000), now)).toBe(totpStep(now) + 1);
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBeNull();
    expect(verifyTotp(secret, "12345", now)).toBeNull();
  });

  it("segredo cifrado: volta igual com a chave certa e falha se adulterado ou com outra chave", () => {
    const box = new SecretBox("chave-de-teste-com-bastante-variedade-123");
    const sealed = box.seal("JBSWY3DPEHPK3PXP");
    expect(sealed).not.toContain("JBSWY3DPEHPK3PXP");
    expect(box.open(sealed)).toBe("JBSWY3DPEHPK3PXP");
    const parts = sealed.split(".");
    parts[2] = Buffer.from("XXXXXXXXXXXXXXXX").toString("base64url");
    expect(() => box.open(parts.join("."))).toThrow();
    expect(() => new SecretBox("outra-chave-qualquer-com-variedade-456").open(sealed)).toThrow();
  });
});

async function account(role: "PLAYER" | "MODERATOR" | "SUPERADMIN" = "PLAYER") {
  const body = newPlayer();
  const res = await ctx.app.inject({ method: "POST", url: "/auth/register", payload: body });
  const j = res.json();
  if (role !== "PLAYER") await ctx.prisma.user.update({ where: { id: j.user.id }, data: { role } });
  return { id: j.user.id as string, username: body.username, password: body.password, token: j.accessToken as string, cookie: getRefreshCookie(res)! };
}
const h = (token: string) => ({ authorization: `Bearer ${token}` });
const login = (identifier: string, password: string) => ctx.app.inject({ method: "POST", url: "/auth/login", payload: { identifier, password }, remoteAddress: "10.0.0.7" });
const loginMfa = (mfaToken: string, code: string) => ctx.app.inject({ method: "POST", url: "/auth/login/mfa", payload: { mfaToken, code }, remoteAddress: "10.0.0.7" });

describe("cadastro do app autenticador", () => {
  it("pede a senha, confere o código, guarda o segredo cifrado e encerra as outras sessões", async () => {
    const a = await account();
    const other = await login(a.username, a.password);
    const otherCookie = getRefreshCookie(other)!;

    expect((await ctx.app.inject({ method: "POST", url: "/auth/mfa/setup", headers: h(a.token), payload: { password: "errada123456" } })).json().error.code).toBe("INVALID_PASSWORD");
    const setup = await ctx.app.inject({ method: "POST", url: "/auth/mfa/setup", headers: h(a.token), payload: { password: a.password } });
    expect(setup.statusCode).toBe(200);
    const s = setup.json();
    expect(s.otpauthUrl).toMatch(/^otpauth:\/\/totp\/VANTA%20FRONTLINE%3A.+\?secret=[A-Z2-7]{32}&issuer=VANTA\+FRONTLINE/);
    expect(s.qrDataUrl).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(Buffer.from(s.qrDataUrl.split(",")[1], "base64").toString()).toContain("<svg");

    const wrong = await ctx.app.inject({ method: "POST", url: "/auth/mfa/enable", headers: h(a.token), payload: { code: totp(s.secret, Date.now() - 120_000) } });
    expect(wrong.json().error.code).toBe("MFA_INVALID_CODE");

    const ok = await ctx.app.inject({ method: "POST", url: "/auth/mfa/enable", headers: h(a.token), payload: { code: totp(s.secret) } });
    expect(ok.statusCode).toBe(200);
    const body = ok.json();
    expect(body.recoveryCodes).toHaveLength(10);
    expect(new Set(body.recoveryCodes).size).toBe(10);
    expect(body.recoveryCodes[0]).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(body.user.mfaEnabled).toBe(true);

    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.totpSecretEnc).toBeTruthy();
    expect(row.totpSecretEnc).not.toContain(s.secret);
    expect(row.totpPendingEnc).toBeNull();
    const codes = await ctx.prisma.mfaRecoveryCode.findMany({ where: { userId: a.id } });
    expect(codes.every((c) => !body.recoveryCodes.some((rc: string) => c.codeHash.includes(rc.replace("-", ""))))).toBe(true);

    // Token antigo e outras sessões morrem; o token novo vale e já tem a segunda etapa.
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: h(a.token) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "POST", url: "/auth/refresh", headers: WEB, cookies: { vanta_rt: otherCookie } })).statusCode).toBe(401);
    const st = await ctx.app.inject({ method: "GET", url: "/auth/mfa", headers: h(body.accessToken) });
    expect(st.json()).toMatchObject({ enabled: true, sessionVerified: true, recoveryCodesLeft: 10, required: false });
    expect((await ctx.app.inject({ method: "POST", url: "/auth/mfa/setup", headers: h(body.accessToken), payload: { password: a.password } })).json().error.code).toBe("MFA_ALREADY_ENABLED");
  });
});

describe("login em duas etapas", () => {
  it("senha certa não abre sessão; o código abre; o mesmo código não vale de novo", async () => {
    const a = await account();
    const { secret } = await enableMfa(ctx, a.token, a.password);
    const first = await login(a.username, a.password);
    expect(first.statusCode).toBe(200);
    const ch = first.json();
    expect(ch).toMatchObject({ mfaRequired: true, expiresIn: 300 });
    expect(ch.accessToken).toBeUndefined();
    expect(getRefreshCookie(first)).toBeUndefined();

    expect((await loginMfa(ch.mfaToken, totp(secret, Date.now() - 120_000))).json().error.code).toBe("MFA_INVALID_CODE");
    const code = await freshTotp(ctx, a.id, secret);
    const ok = await loginMfa(ch.mfaToken, code);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().accessToken).toBeTypeOf("string");
    expect(getRefreshCookie(ok)).toBeTruthy();
    // O desafio é de uso único.
    expect((await loginMfa(ch.mfaToken, code)).statusCode).toBe(401);
    // Novo login com o mesmo código (mesmo passo de 30 s): recusado.
    const again = (await login(a.username, a.password)).json();
    expect((await loginMfa(again.mfaToken, code)).json().error.code).toBe("MFA_CODE_USED");
  });

  it("código de recuperação entra uma vez só", async () => {
    const a = await account();
    const { recoveryCodes } = await enableMfa(ctx, a.token, a.password);
    const rc = recoveryCodes[3]!;
    const c1 = (await login(a.username, a.password)).json();
    expect((await loginMfa(c1.mfaToken, rc.toLowerCase().replace("-", ""))).statusCode).toBe(200);
    const c2 = (await login(a.username, a.password)).json();
    expect((await loginMfa(c2.mfaToken, rc)).json().error.code).toBe("MFA_INVALID_CODE");
    const t = (await loginMfa(c2.mfaToken, recoveryCodes[4]!)).json().accessToken;
    expect((await ctx.app.inject({ method: "GET", url: "/auth/mfa", headers: h(t) })).json().recoveryCodesLeft).toBe(8);
  });

  it("cinco erros matam o desafio, e os erros entram no bloqueio do login", async () => {
    const a = await account();
    const { secret } = await enableMfa(ctx, a.token, a.password);
    const ch = (await login(a.username, a.password)).json();
    for (let i = 0; i < 5; i++) expect((await loginMfa(ch.mfaToken, "000000")).statusCode).toBe(400);
    expect((await loginMfa(ch.mfaToken, await freshTotp(ctx, a.id, secret))).statusCode).toBe(401);
    // 5 erros de código = 5 falhas na conta+IP: a senha também fica bloqueada.
    expect((await login(a.username, a.password)).statusCode).toBe(429);
  });

  it("a segunda etapa passa adiante na renovação da sessão", async () => {
    const m = await account("MODERATOR");
    const { secret } = await enableMfa(ctx, m.token, m.password);
    const ch = (await login(m.username, m.password)).json();
    const ok = await loginMfa(ch.mfaToken, await freshTotp(ctx, m.id, secret));
    const r = await ctx.app.inject({ method: "POST", url: "/auth/refresh", headers: WEB, cookies: { vanta_rt: getRefreshCookie(ok)! } });
    expect(r.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: "GET", url: "/admin/me", headers: h(r.json().accessToken) })).statusCode).toBe(200);
  });
});

describe("exigência para cargos da equipe", () => {
  it("moderador sem a verificação não usa o painel; com ela, usa", async () => {
    const m = await account("MODERATOR");
    const denied = await ctx.app.inject({ method: "GET", url: "/admin/me", headers: h(m.token) });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe("MFA_REQUIRED");
    // As rotas por cargo (requireRole) também exigem.
    await ctx.prisma.user.update({ where: { id: m.id }, data: { role: "ADMIN" } });
    expect((await ctx.app.inject({ method: "POST", url: "/admin/wallet/adjust", headers: h(m.token), payload: {} })).json().error.code).toBe("MFA_REQUIRED");
    // O resto do jogo continua normal.
    expect((await ctx.app.inject({ method: "GET", url: "/me", headers: h(m.token) })).statusCode).toBe(200);
    const st = (await ctx.app.inject({ method: "GET", url: "/auth/mfa", headers: h(m.token) })).json();
    expect(st).toMatchObject({ enabled: false, required: true, sessionVerified: false });

    const { token } = await enableMfa(ctx, m.token, m.password);
    expect((await ctx.app.inject({ method: "GET", url: "/admin/me", headers: h(token) })).statusCode).toBe(200);
  });

  it("um token de acesso forjado com mfa:true não passa se a conta não tem a verificação ligada", async () => {
    const m = await account("MODERATOR");
    const row = await ctx.prisma.user.findUniqueOrThrow({ where: { id: m.id } });
    const forged = ctx.app.jwt.sign({ sub: m.id, role: "MODERATOR", tv: row.tokenVersion, mfa: true });
    expect((await ctx.app.inject({ method: "GET", url: "/admin/me", headers: h(forged) })).json().error.code).toBe("MFA_REQUIRED");
  });

  it("desligar pede senha e código; depois o painel volta a recusar", async () => {
    const m = await account("MODERATOR");
    const { token, secret } = await enableMfa(ctx, m.token, m.password);
    const bad = await ctx.app.inject({ method: "POST", url: "/auth/mfa/disable", headers: h(token), payload: { password: m.password, code: "000000" } });
    expect(bad.json().error.code).toBe("MFA_INVALID_CODE");
    const off = await ctx.app.inject({ method: "POST", url: "/auth/mfa/disable", headers: h(token), payload: { password: m.password, code: await freshTotp(ctx, m.id, secret) } });
    expect(off.statusCode).toBe(200);
    expect(off.json().user.mfaEnabled).toBe(false);
    expect((await ctx.app.inject({ method: "GET", url: "/admin/me", headers: h(token) })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: "GET", url: "/admin/me", headers: h(off.json().accessToken) })).json().error.code).toBe("MFA_REQUIRED");
    expect(await ctx.prisma.mfaRecoveryCode.count({ where: { userId: m.id } })).toBe(0);
  });

  it("gerar códigos novos invalida os antigos", async () => {
    const a = await account();
    const { token, secret, recoveryCodes } = await enableMfa(ctx, a.token, a.password);
    const r = await ctx.app.inject({ method: "POST", url: "/auth/mfa/recovery-codes", headers: h(token), payload: { code: await freshTotp(ctx, a.id, secret) } });
    expect(r.statusCode).toBe(200);
    const fresh = r.json().recoveryCodes as string[];
    expect(fresh.some((c) => recoveryCodes.includes(c))).toBe(false);
    const ch = (await login(a.username, a.password)).json();
    expect((await loginMfa(ch.mfaToken, recoveryCodes[0]!)).statusCode).toBe(400);
    expect((await loginMfa(ch.mfaToken, fresh[0]!)).statusCode).toBe(200);
  });

  it("superadmin desliga a verificação de quem perdeu o celular, com auditoria", async () => {
    const [a, sup] = [await account(), await account("SUPERADMIN")];
    await enableMfa(ctx, a.token, a.password);
    const supToken = (await enableMfa(ctx, sup.token, sup.password)).token;
    const r = await ctx.app.inject({ method: "POST", url: `/admin/users/${a.id}/mfa/reset`, headers: h(supToken), payload: { reason: "identidade confirmada pelo suporte" } });
    expect(r.statusCode).toBe(200);
    expect((await ctx.prisma.user.findUniqueOrThrow({ where: { id: a.id } })).totpEnabledAt).toBeNull();
    expect(await ctx.prisma.adminAuditLog.count({ where: { action: "mfa.reset", targetId: a.id, actorId: sup.id } })).toBe(1);
    // Volta a entrar só com a senha.
    expect((await login(a.username, a.password)).json().accessToken).toBeTypeOf("string");
    const detail = await ctx.app.inject({ method: "GET", url: `/admin/users/${a.id}`, headers: h(supToken) });
    expect(detail.json().mfaEnabled).toBe(false);
  });
});
