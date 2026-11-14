import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { forgotPasswordSchema, passwordSchema, MESSAGES } from "@vanta/shared";
import { AuthLayout } from "./AuthLayout";
import { Button, Field } from "../components/ui";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { uiSound } from "../audio/ui-sound";

const t = MESSAGES["pt-BR"].auth;

export function ForgotPasswordScreen() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<{ loading?: boolean; error?: string; sent?: string }>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = forgotPasswordSchema.safeParse({ email });
    if (!parsed.success) return setState({ error: parsed.error.issues[0]!.message });
    setState({ loading: true });
    try {
      const r = await api.post<{ message: string }>("/auth/forgot-password", parsed.data, { auth: false });
      uiSound.success();
      setState({ sent: r.message });
    } catch (err) {
      uiSound.error();
      setState({ error: (err as Error).message });
    }
  }

  return (
    <AuthLayout title={t.forgotTitle} subtitle="Informe o e-mail da conta. Enviaremos um link válido por 1 hora.">
      <form className="auth-form" onSubmit={submit} noValidate>
        {state.error && <div className="alert error" role="alert">{state.error}</div>}
        {state.sent ? (
          <div className="alert ok">{state.sent}</div>
        ) : (
          <>
            <Field label={t.email} type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            <Button type="submit" block loading={state.loading}>{t.sendLink}</Button>
          </>
        )}
        <p className="auth-switch"><Link to="/login">Voltar para o login</Link></p>
      </form>
    </AuthLayout>
  );
}

export function ResetPasswordScreen() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [state, setState] = useState<{ loading?: boolean; error?: string; done?: boolean }>({});

  async function submit(e: FormEvent) {
    e.preventDefault();
    const p = passwordSchema.safeParse(password);
    if (!p.success) return setState({ error: p.error.issues[0]!.message });
    if (password !== confirm) return setState({ error: "As senhas não coincidem." });
    setState({ loading: true });
    try {
      await api.post("/auth/reset-password", { token, password }, { auth: false });
      uiSound.success();
      setState({ done: true });
      setTimeout(() => navigate("/login", { replace: true }), 2500);
    } catch (err) {
      uiSound.error();
      setState({ error: (err as Error).message });
    }
  }

  if (!token) {
    return (
      <AuthLayout title={t.resetTitle}>
        <div className="alert error">Link inválido. Solicite uma nova recuperação de senha.</div>
        <Link to="/recuperar-senha">Solicitar novo link</Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t.resetTitle} subtitle="Por segurança, todas as sessões abertas serão encerradas.">
      <form className="auth-form" onSubmit={submit} noValidate>
        {state.error && <div className="alert error" role="alert">{state.error}</div>}
        {state.done ? (
          <div className="alert ok">Senha redefinida. Redirecionando para o login…</div>
        ) : (
          <>
            <Field label="Nova senha" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} hint="Mínimo 10, com letra e número" autoFocus />
            <Field label="Confirmar senha" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            <Button type="submit" block loading={state.loading}>{t.resetSubmit}</Button>
          </>
        )}
      </form>
    </AuthLayout>
  );
}

export function VerifyEmailScreen() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { status, reloadMe } = useAuth();
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [message, setMessage] = useState("");
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    api
      .post("/auth/verify-email", { token }, { auth: false })
      .then(() => {
        setState("ok");
        uiSound.success();
      })
      .catch((e: Error) => {
        setState("error");
        setMessage(e.message);
      });
  }, [token]);

  useEffect(() => {
    if (state === "ok" && status === "authenticated") void reloadMe();
  }, [state, status, reloadMe]);

  return (
    <AuthLayout title={t.verifyTitle}>
      {state === "loading" && <div className="alert info">Verificando…</div>}
      {state === "ok" && <div className="alert ok">E-mail confirmado. Sua conta está totalmente ativa.</div>}
      {state === "error" && <div className="alert error">{message}</div>}
      <Link to={status === "authenticated" ? "/menu" : "/login"}>{status === "authenticated" ? "Ir para o menu" : "Ir para o login"}</Link>
    </AuthLayout>
  );
}
