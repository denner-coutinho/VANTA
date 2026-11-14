import type { ApiErrorBody, AuthResponse } from "@vanta/shared";

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

type Listener = (token: string | null) => void;

/**
 * Cliente HTTP da API.
 * - O token de acesso fica só em memória (nunca em localStorage: mitigação de XSS).
 * - O refresh token fica num cookie httpOnly que o JavaScript não lê.
 * - Em 401, tenta um refresh (uma vez, com deduplicação) e repete a requisição.
 */
export class ApiClient {
  private accessToken: string | null = null;
  private refreshing: Promise<AuthResponse | null> | null = null;
  private listeners = new Set<Listener>();

  constructor(private readonly baseUrl: string, private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  setAccessToken(token: string | null) {
    this.accessToken = token;
    this.listeners.forEach((l) => l(token));
  }
  get token() {
    return this.accessToken;
  }
  onTokenChange(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async request<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean; retry?: boolean } = {}): Promise<T> {
    const { auth = true, retry = true } = opts;
    const headers: Record<string, string> = { "X-Vanta-Client": "web" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (auth && this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`;

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "include" });
    } catch {
      throw new ApiError(0, "NETWORK_ERROR", "Não foi possível conectar ao servidor. Verifique sua conexão.");
    }

    if (res.status === 401 && auth && retry && this.accessToken) {
      const refreshed = await this.refresh();
      if (refreshed) return this.request<T>(method, path, body, { auth, retry: false });
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (data as ApiErrorBody | null)?.error;
      throw new ApiError(res.status, err?.code ?? "HTTP_ERROR", err?.message ?? `Erro ${res.status}`, err?.details);
    }
    return data as T;
  }

  /** Renova a sessão pelo cookie. Chamadas simultâneas compartilham a mesma requisição. */
  refresh(): Promise<AuthResponse | null> {
    this.refreshing ??= this.request<AuthResponse>("POST", "/auth/refresh", undefined, { auth: false, retry: false })
      .then((r) => {
        this.setAccessToken(r.accessToken);
        return r;
      })
      .catch(() => {
        this.setAccessToken(null);
        return null;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown, opts?: { auth?: boolean }) {
    return this.request<T>("POST", path, body, opts);
  }
}

export const api = new ApiClient(import.meta.env.VITE_API_URL ?? "/api");
