import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { registerSchema, MESSAGES } from "@vanta/shared";
import { AuthLayout } from "./AuthLayout";
import { Button, Field } from "../components/ui";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { uiSound } from "../audio/ui-sound";

const t = MESSAGES["pt-BR"].auth;
type Errors = Partial<Record<"username" | "email" | "password" | "birthDate" | "acceptTerms" | "form", string>>;

export function RegisterScreen() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ username: "", email: "", password: "", birthDate: "", acceptTerms: false });
  const [errors, setErrors] = useState<Errors>({});
  const [loading, setLoading] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: k === "acceptTerms" ? e.target.checked : e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    const parsed = registerSchema.safeParse(form);
    if (!parsed.success) {
      const next: Errors = {};
      for (const i of parsed.error.issues) next[i.path[0] as keyof Errors] ??= i.message;
      setErrors(next);
      uiSound.error();
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      await register(parsed.data);
      uiSound.success();
      navigate("/menu", { replace: true });
    } catch (err) {
      uiSound.error();
      const e2 = err as ApiError;
      if (e2.code === "USERNAME_TAKEN" || e2.code === "USERNAME_UNAVAILABLE") setErrors({ username: e2.message });
      else if (e2.code === "EMAIL_TAKEN") setErrors({ email: e2.message });
      else if (e2.code === "AGE_RESTRICTION") setErrors({ birthDate: e2.message });
      else setErrors({ form: e2.message });
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthLayout title={t.registerTitle} subtitle="Crie sua identidade de operador.">
      <form className="auth-form" onSubmit={submit} noValidate>
        {errors.form && <div className="alert error" role="alert">{errors.form}</div>}
        <Field label={t.username} name="username" autoComplete="nickname" value={form.username} onChange={set("username")} error={errors.username} hint="3 a 16 caracteres: letras, números, _ e -" autoFocus />
        <Field label={t.email} name="email" type="email" autoComplete="email" value={form.email} onChange={set("email")} error={errors.email} />
        <div className="field-row">
          <Field label={t.password} name="password" type="password" autoComplete="new-password" value={form.password} onChange={set("password")} error={errors.password} hint="Mínimo 10, com letra e número" />
          <Field label={t.birthDate} name="birthDate" type="date" value={form.birthDate} onChange={set("birthDate")} error={errors.birthDate} />
        </div>
        <label className="check">
          <input type="checkbox" name="acceptTerms" checked={form.acceptTerms} onChange={set("acceptTerms")} />
          <span>{t.acceptTerms}. {errors.acceptTerms && <span style={{ color: "var(--c-red)" }}>{errors.acceptTerms}</span>}</span>
        </label>
        <Button type="submit" block loading={loading}>{t.register}</Button>
        <p className="auth-switch">{t.haveAccount} <Link to="/login">Entrar</Link></p>
      </form>
    </AuthLayout>
  );
}
