import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import type { MfaCodesResponse, MfaEnableResponse, MfaSetupResponse, MfaStatus, AuthResponse } from "@vanta/shared";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Button, Field, useToast } from "../components/ui";
import { uiSound } from "../audio/ui-sound";

type Step = { k: "idle" } | { k: "password" } | { k: "scan"; setup: MfaSetupResponse } | { k: "codes"; codes: string[] } | { k: "disable" } | { k: "regen" };

/** Verificação em duas etapas da própria conta: ligar com um app autenticador, códigos de recuperação, desligar. */
export function SecurityScreen() {
  const navigate = useNavigate();
  const { me, applySession } = useAuth();
  const toast = useToast();
  const [status, setStatus] = useState<MfaStatus | null>(null);
  const [step, setStep] = useState<Step>({ k: "idle" });
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get<MfaStatus>("/auth/mfa").then(setStatus).catch((e: Error) => setErr(e.message)), []);
  useEffect(() => void load(), [load]);

  const go = (s: Step) => {
    setErr(null);
    setPassword("");
    setCode("");
    setStep(s);
  };
  async function run(e: FormEvent, fn: () => Promise<void>) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (x) {
      uiSound.error();
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const begin = (e: FormEvent) => run(e, async () => {
    const setup = await api.post<MfaSetupResponse>("/auth/mfa/setup", { password });
    uiSound.click();
    go({ k: "scan", setup });
  });
  const confirm = (e: FormEvent) => run(e, async () => {
    const r = await api.post<MfaEnableResponse>("/auth/mfa/enable", { code });
    await applySession(r);
    uiSound.success();
    go({ k: "codes", codes: r.recoveryCodes });
    await load();
  });
  const disable = (e: FormEvent) => run(e, async () => {
    await applySession(await api.post<AuthResponse>("/auth/mfa/disable", { password, code }));
    uiSound.success();
    toast("Verificação desligada", "As outras sessões da conta foram encerradas.");
    go({ k: "idle" });
    await load();
  });
  const regen = (e: FormEvent) => run(e, async () => {
    const r = await api.post<MfaCodesResponse>("/auth/mfa/recovery-codes", { code });
    uiSound.success();
    go({ k: "codes", codes: r.recoveryCodes });
    await load();
  });

  const codeField = (label = "Código do app (6 números)", recovery = false) => (
    <Field label={label} name="code" autoComplete="one-time-code" inputMode={recovery ? "text" : "numeric"} maxLength={recovery ? 11 : 6} value={code}
      onChange={(e) => setCode(recovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, ""))} data-testid="sec-code" />
  );
  const passwordField = <Field label="Senha da conta" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} data-testid="sec-password" />;

  return (
    <div className="screen play-screen" data-testid="security-screen">
      <div className="play-wrap stagger" style={{ maxWidth: 640 }}>
        <div className="play-head"><Button variant="ghost" onClick={() => navigate("/menu")}>← Menu</Button></div>
        <h1>Verificação em duas etapas</h1>
        <p className="muted">Além da senha, o login pede um código de 6 números que muda a cada 30 segundos num app autenticador do seu celular
          (Google Authenticator, Microsoft Authenticator, Authy, 1Password, Aegis e outros). Quem descobrir sua senha não entra sem o celular.</p>

        {status?.required && !status.enabled && (
          <div className="alert error" role="alert" data-testid="sec-required">Seu cargo na equipe exige a verificação em duas etapas para usar o painel administrativo.</div>
        )}
        {status?.enabled && status.required && !status.sessionVerified && (
          <div className="alert error" role="alert">Esta sessão começou antes da verificação. Saia e entre de novo com o código para usar o painel.</div>
        )}

        <div className="panel cut room-list-panel">
          {!status ? <p className="muted">{err ?? "Carregando…"}</p> : (
            <>
              <div className="kv"><span>Situação</span><b data-testid="sec-state" style={{ color: status.enabled ? "var(--c-green)" : "var(--c-amber)" }}>{status.enabled ? "Ligada" : "Desligada"}</b></div>
              {status.enabled && <div className="kv"><span>Códigos de recuperação restantes</span><b data-testid="sec-left">{status.recoveryCodesLeft}</b></div>}
              {status.enabled && status.enabledAt && <div className="kv"><span>Ligada em</span><span>{new Date(status.enabledAt).toLocaleString("pt-BR")}</span></div>}
            </>
          )}
        </div>

        {status && step.k === "idle" && (
          <div className="row-gap" style={{ marginTop: 16 }}>
            {!status.enabled && <Button onClick={() => go({ k: "password" })} data-testid="sec-start">Ligar a verificação</Button>}
            {status.enabled && <Button variant="ghost" onClick={() => go({ k: "regen" })} data-testid="sec-regen">Gerar códigos de recuperação novos</Button>}
            {status.enabled && <Button variant="ghost" onClick={() => go({ k: "disable" })} data-testid="sec-disable">Desligar</Button>}
          </div>
        )}

        {step.k === "password" && (
          <form className="auth-form panel cut room-list-panel" onSubmit={begin} noValidate>
            <p className="small">Confirme sua senha para começar.</p>
            {err && <div className="alert error" role="alert">{err}</div>}
            {passwordField}
            <div className="row-gap"><Button type="submit" loading={busy} data-testid="sec-continue">Continuar</Button><Button type="button" variant="ghost" onClick={() => go({ k: "idle" })}>Cancelar</Button></div>
          </form>
        )}

        {step.k === "scan" && (
          <form className="auth-form panel cut room-list-panel" onSubmit={confirm} noValidate>
            <p className="small"><b>1.</b> No app autenticador, adicione uma conta e aponte a câmera para o QR code.</p>
            <img src={step.setup.qrDataUrl} alt="QR code para o app autenticador" width={200} height={200} style={{ background: "#fff", padding: 8, alignSelf: "center" }} data-testid="sec-qr" />
            <p className="small muted">Sem câmera? Digite esta chave no app (tipo: baseada em tempo):</p>
            <code className="panel cut cut-sm" style={{ padding: 10, wordBreak: "break-all", userSelect: "all" }} data-testid="sec-secret">{step.setup.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
            <p className="small"><b>2.</b> Digite o código de 6 números que o app mostra.</p>
            {err && <div className="alert error" role="alert">{err}</div>}
            {codeField()}
            <div className="row-gap"><Button type="submit" loading={busy} disabled={code.length !== 6} data-testid="sec-confirm">Confirmar e ligar</Button><Button type="button" variant="ghost" onClick={() => go({ k: "idle" })}>Cancelar</Button></div>
          </form>
        )}

        {step.k === "codes" && (
          <div className="panel cut room-list-panel" data-testid="sec-codes">
            <h3 className="label">Códigos de recuperação</h3>
            <p className="small">Guarde estes códigos num lugar seguro (gerenciador de senhas ou papel). Cada um entra <b>uma vez</b> se você perder o celular.
              Eles <b>não aparecem de novo</b>: o servidor guarda só uma impressão digital deles.</p>
            <ol className="small" style={{ columns: 2, fontFamily: "monospace", fontSize: 15 }}>{step.codes.map((c) => <li key={c} data-testid="sec-code-item">{c}</li>)}</ol>
            <div className="row-gap">
              <Button variant="ghost" onClick={() => void navigator.clipboard?.writeText(step.codes.join("\n")).then(() => toast("Copiado", "Códigos copiados."), () => undefined)}>Copiar</Button>
              <Button variant="ghost" onClick={() => {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(new Blob([`VANTA FRONTLINE — códigos de recuperação de ${me?.user.username ?? ""}\n\n${step.codes.join("\n")}\n`], { type: "text/plain" }));
                a.download = "vanta-codigos-de-recuperacao.txt";
                a.click();
                URL.revokeObjectURL(a.href);
              }}>Baixar .txt</Button>
              <Button onClick={() => go({ k: "idle" })} data-testid="sec-codes-done">Já guardei</Button>
            </div>
          </div>
        )}

        {step.k === "regen" && (
          <form className="auth-form panel cut room-list-panel" onSubmit={regen} noValidate>
            <p className="small">Os códigos antigos param de valer. Confirme com o código do app.</p>
            {err && <div className="alert error" role="alert">{err}</div>}
            {codeField()}
            <div className="row-gap"><Button type="submit" loading={busy} disabled={code.length !== 6} data-testid="sec-regen-confirm">Gerar</Button><Button type="button" variant="ghost" onClick={() => go({ k: "idle" })}>Cancelar</Button></div>
          </form>
        )}

        {step.k === "disable" && (
          <form className="auth-form panel cut room-list-panel" onSubmit={disable} noValidate>
            <p className="small">{status?.required ? "Atenção: sem a verificação você perde o acesso ao painel da equipe. " : ""}Confirme com a senha e um código do app (ou de recuperação). As outras sessões da conta serão encerradas.</p>
            {err && <div className="alert error" role="alert">{err}</div>}
            {passwordField}
            {codeField("Código do app ou de recuperação", true)}
            <div className="row-gap"><Button type="submit" loading={busy} data-testid="sec-disable-confirm">Desligar</Button><Button type="button" variant="ghost" onClick={() => go({ k: "idle" })}>Cancelar</Button></div>
          </form>
        )}
      </div>
    </div>
  );
}
