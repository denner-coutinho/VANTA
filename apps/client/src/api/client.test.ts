import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./client";

const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ApiClient", () => {
  it("envia o token, renova a sessão em 401 e repete a requisição", async () => {
    const calls: Array<{ url: string; auth?: string }> = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      const auth = (init.headers as Record<string, string>).Authorization;
      calls.push({ url, auth });
      if (url.endsWith("/auth/refresh")) return json(200, { accessToken: "novo", expiresIn: 900, user: {} });
      if (auth === "Bearer velho") return json(401, { error: { code: "UNAUTHORIZED", message: "x" } });
      return json(200, { ok: true });
    });
    const api = new ApiClient("/api", fetchMock as never);
    api.setAccessToken("velho");
    await expect(api.get("/me")).resolves.toEqual({ ok: true });
    expect(calls.map((c) => c.url)).toEqual(["/api/me", "/api/auth/refresh", "/api/me"]);
    expect(calls[2]!.auth).toBe("Bearer novo");
  });

  it("deduplica refresh concorrentes", async () => {
    let refreshes = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/auth/refresh")) {
        refreshes++;
        await new Promise((r) => setTimeout(r, 10));
        return json(200, { accessToken: "t", expiresIn: 900, user: {} });
      }
      return json(200, {});
    });
    const api = new ApiClient("", fetchMock as never);
    await Promise.all([api.refresh(), api.refresh(), api.refresh()]);
    expect(refreshes).toBe(1);
  });

  it("converte erros da API em ApiError com mensagem em português", async () => {
    const api = new ApiClient("", (async () => json(409, { error: { code: "EMAIL_TAKEN", message: "Já existe uma conta com este e-mail." } })) as never);
    const err = (await api.post("/auth/register", {}).catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("EMAIL_TAKEN");
    expect(err.message).toContain("Já existe");
  });

  it("falha de rede vira erro legível", async () => {
    const api = new ApiClient("", (async () => {
      throw new TypeError("fetch failed");
    }) as never);
    await expect(api.get("/x")).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });
});
