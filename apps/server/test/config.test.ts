import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";

const good = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://vanta:Xk29fhQ7pLm3Zs8a@postgres:5432/vanta",
  JWT_ACCESS_SECRET: "q8Zr2LkP0vN7xWc4Ty1Hb6Jm9Df3Ga5Se8Ru0Io2Pl",
  PUBLIC_APP_URL: "https://jogar.exemplo.com",
  CORS_ORIGINS: "https://jogar.exemplo.com",
  SMTP_HOST: "smtp.exemplo.com",
};

describe("configuração de produção", () => {
  it("aceita uma configuração segura", () => {
    expect(loadConfig(good).isProd).toBe(true);
  });

  it("recusa segredos de exemplo, senha de dev, http, CORS aberto e falta de SMTP", () => {
    const bad = { ...good, JWT_ACCESS_SECRET: "troque-este-segredo-de-acesso-com-pelo-menos-32-caracteres", DATABASE_URL: "postgresql://vanta:vanta@localhost:5432/vanta", PUBLIC_APP_URL: "http://jogar.exemplo.com", CORS_ORIGINS: "*", SMTP_HOST: "" };
    const msg = (() => { try { loadConfig(bad); return ""; } catch (e) { return (e as Error).message; } })();
    expect(msg).toMatch(/JWT_ACCESS_SECRET é o valor de exemplo/);
    expect(msg).toMatch(/senha de desenvolvimento/);
    expect(msg).toMatch(/https/);
    expect(msg).toMatch(/CORS_ORIGINS não pode ser \*/);
    expect(msg).toMatch(/SMTP_HOST/);
    expect(() => loadConfig({ ...good, JWT_ACCESS_SECRET: "a".repeat(40) })).toThrow(/pouca variedade/);
  });

  it("http só com ALLOW_INSECURE_HTTP=true, e \"false\" é falso", () => {
    expect(() => loadConfig({ ...good, PUBLIC_APP_URL: "http://localhost:8080", ALLOW_INSECURE_HTTP: "false" })).toThrow(/https/);
    expect(loadConfig({ ...good, PUBLIC_APP_URL: "http://localhost:8080", ALLOW_INSECURE_HTTP: "true" }).ALLOW_INSECURE_HTTP).toBe(true);
    expect(loadConfig({ ...good, TRUST_PROXY: "false" }).TRUST_PROXY).toBe(false);
    expect(loadConfig({ ...good, TRUST_PROXY: "true" }).TRUST_PROXY).toBe(true);
    expect(loadConfig({ ...good, TRUST_PROXY: "2" }).TRUST_PROXY).toBe(2);
  });
});
