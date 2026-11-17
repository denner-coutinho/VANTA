import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthResponse, LoginInput, LoginResponse, MeResponse, RegisterInput } from "@vanta/shared";
import { api } from "../api/client";
import { pullAccountSettings } from "../screens/SettingsPanel";

type Status = "checking" | "anonymous" | "authenticated";

interface AuthState {
  status: Status;
  me: MeResponse | null;
  /** Conta com verificação em duas etapas: devolve o desafio para a segunda etapa (sem sessão ainda). */
  login(input: LoginInput): Promise<{ mfaToken: string } | null>;
  loginMfa(mfaToken: string, code: string): Promise<void>;
  /** Sessão nova devolvida pelo servidor (ligar/desligar a verificação troca a sessão). */
  applySession(r: AuthResponse): Promise<void>;
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
    // Teclas e sensibilidade da conta chegam antes das telas montarem (se falhar, fica a deste navegador).
    await pullAccountSettings().catch(() => undefined);
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
    login: async (input) => {
      const r = await api.post<LoginResponse>("/auth/login", input, { auth: false });
      if ("mfaRequired" in r) return { mfaToken: r.mfaToken };
      await afterAuth(r);
      return null;
    },
    loginMfa: async (mfaToken, code) => afterAuth(await api.post<AuthResponse>("/auth/login/mfa", { mfaToken, code }, { auth: false })),
    applySession: afterAuth,
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
