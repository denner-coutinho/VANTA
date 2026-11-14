import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthResponse, LoginInput, MeResponse, RegisterInput } from "@vanta/shared";
import { api } from "../api/client";

type Status = "checking" | "anonymous" | "authenticated";

interface AuthState {
  status: Status;
  me: MeResponse | null;
  login(input: LoginInput): Promise<void>;
  register(input: RegisterInput): Promise<void>;
  logout(): Promise<void>;
  logoutAll(): Promise<void>;
  reloadMe(): Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");
  const [me, setMe] = useState<MeResponse | null>(null);

  const reloadMe = useCallback(async () => {
    const data = await api.get<MeResponse>("/me");
    setMe(data);
    setStatus("authenticated");
  }, []);

  const afterAuth = useCallback(async (r: AuthResponse) => {
    api.setAccessToken(r.accessToken);
    await reloadMe();
  }, [reloadMe]);

  // Ao abrir o jogo, tenta retomar a sessão pelo cookie de refresh.
  useEffect(() => {
    let cancelled = false;
    api.refresh().then(async (r) => {
      if (cancelled) return;
      if (r) await reloadMe().catch(() => setStatus("anonymous"));
      else setStatus("anonymous");
    });
    const off = api.onTokenChange((t) => {
      if (!t) {
        setMe(null);
        setStatus("anonymous");
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [reloadMe]);

  // Renova o token de acesso um pouco antes de expirar (15 min).
  useEffect(() => {
    if (status !== "authenticated") return;
    const id = setInterval(() => void api.refresh(), 12 * 60 * 1000);
    return () => clearInterval(id);
  }, [status]);

  const value = useMemo<AuthState>(() => ({
    status,
    me,
    login: async (input) => afterAuth(await api.post<AuthResponse>("/auth/login", input, { auth: false })),
    register: async (input) => afterAuth(await api.post<AuthResponse>("/auth/register", input, { auth: false })),
    logout: async () => {
      await api.post("/auth/logout").catch(() => undefined);
      api.setAccessToken(null);
    },
    logoutAll: async () => {
      await api.post("/auth/logout-all");
      api.setAccessToken(null);
    },
    reloadMe,
  }), [status, me, afterAuth, reloadMe]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth fora do AuthProvider");
  return v;
}
