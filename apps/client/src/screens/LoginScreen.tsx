import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { loginSchema, MESSAGES } from "@vanta/shared";
import { AuthLayout } from "./AuthLayout";
import { Button, Field } from "../components/ui";
import { useAuth } from "../auth/AuthContext";
import { uiSound } from "../audio/ui-sound";

const t = MESSAGES["pt-BR"].auth;

export function LoginScreen() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      await login(parsed.data);
      uiSound.success();
      navigate("/menu", { replace: true });
    } catch (err) {
      uiSound.error();
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
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
