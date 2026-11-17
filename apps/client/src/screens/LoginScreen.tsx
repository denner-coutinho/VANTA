import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { loginSchema, mfaCodeSchema, MESSAGES } from "@vanta/shared";
import { AuthLayout } from "./AuthLayout";
import { Button, Field } from "../components/ui";
import { useAuth } from "../auth/AuthContext";
import { uiSound } from "../audio/ui-sound";

const t = MESSAGES["pt-BR"].auth;

export function LoginScreen() {
  const { login, loginMfa } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = loginSchema.safeParse({ identifier, password });
    if (!parsed.success) {
      setError("Preencha e-mail (ou nome de jogador) e senha.");
      uiSound.error();
      return;
    }
    setLoading(true);
    try {
      const ch = await login(parsed.data);
      if (ch) {
        setMfaToken(ch.mfaToken);
        setPassword("");
        uiSound.click();
        return;
      }
      uiSound.success();
      navigate("/menu", { replace: true });
    } catch (err) {
      uiSound.error();
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const parsed = mfaCodeSchema.safeParse(code);
    if (!parsed.success) {
      setError(useRecovery ? "Digite um código de recuperação (XXXXX-XXXXX)." : "Digite os 6 números do app autenticador.");
      uiSound.error();
      return;
    }
    setLoading(true);
    try {
      await loginMfa(mfaToken!, parsed.data);
      uiSound.success();
      navigate("/menu", { replace: true });
    } catch (err) {
      uiSound.error();
      // Desafio expirado ou esgotado: volta para a senha.
      if ((err as { status?: number }).status === 401) {
        setMfaToken(null);
        setCode("");
      }
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (mfaToken) {
    return (
      <AuthLayout title="Verificação em duas etapas" subtitle={useRecovery ? "Digite um dos seus códigos de recuperação. Cada um vale uma vez." : "Abra o app autenticador e digite o código de 6 números do VANTA FRONTLINE."}>
        <form className="auth-form" onSubmit={submitCode} noValidate data-testid="mfa-form">
          {error && <div className="alert error" role="alert">{error}</div>}
          <Field
            label={useRecovery ? "Código de recuperação" : "Código do app"}
            name="code"
            autoComplete="one-time-code"
            inputMode={useRecovery ? "text" : "numeric"}
            maxLength={useRecovery ? 11 : 6}
            value={code}
            onChange={(e) => setCode(useRecovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ""))}
            autoFocus
            data-testid="mfa-code"
          />
          <Button type="submit" block loading={loading} data-testid="mfa-submit">Entrar</Button>
          <p className="auth-switch">
            <button type="button" className="link-btn" onClick={() => { setUseRecovery(!useRecovery); setCode(""); setError(null); }} data-testid="mfa-toggle">
              {useRecovery ? "Usar o código do app" : "Perdi o celular: usar um código de recuperação"}
            </button>
          </p>
          <p className="auth-switch"><button type="button" className="link-btn" onClick={() => { setMfaToken(null); setCode(""); setError(null); }}>Voltar</button></p>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title={t.loginTitle} subtitle="Bem-vindo de volta, operador.">
      <form className="auth-form" onSubmit={submit} noValidate>
        {error && <div className="alert error" role="alert">{error}</div>}
        <Field label={t.identifier} name="identifier" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoFocus />
        <Field label={t.password} name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <div style={{ textAlign: "right", marginTop: -6 }}>
          <Link to="/recuperar-senha" style={{ fontSize: 13 }}>{t.forgot}</Link>
        </div>
        <Button type="submit" block loading={loading}>{t.login}</Button>
        <p className="auth-switch">{t.noAccount} <Link to="/cadastro">Alistar-se</Link></p>
      </form>
    </AuthLayout>
  );
}
