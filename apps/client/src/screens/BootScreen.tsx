import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Logo } from "../components/Logo";
import { Backdrop } from "../components/ui";
import { useAuth } from "../auth/AuthContext";
import { uiSound } from "../audio/ui-sound";
import { MESSAGES } from "@vanta/shared";

const t = MESSAGES["pt-BR"];

/** Tela de inicialização. O progresso reflete etapas reais: fontes, servidor e sessão. */
export function BootScreen() {
  const { status } = useAuth();
  const navigate = useNavigate();
  const [steps, setSteps] = useState({ fonts: false, server: false });
  const [serverDown, setServerDown] = useState(false);

  useEffect(() => {
    document.fonts.ready.then(() => setSteps((s) => ({ ...s, fonts: true })));
    fetch(`${import.meta.env.VITE_API_URL ?? "/api"}/health`)
      .then((r) => r.ok || Promise.reject())
      .then(() => setSteps((s) => ({ ...s, server: true })))
      .catch(() => {
        setServerDown(true);
        setSteps((s) => ({ ...s, server: true }));
      });
  }, []);

  const done = [steps.fonts, steps.server, status !== "checking"].filter(Boolean).length;
  const ready = done === 3;
  const progress = Math.round((done / 3) * 100);
  const label = !steps.fonts ? "Carregando interface" : !steps.server ? "Conectando ao servidor" : status === "checking" ? "Verificando sessão" : "Sistemas prontos";

  useEffect(() => {
    if (!ready) return;
    const go = () => {
      uiSound.boot();
      navigate(status === "authenticated" ? "/menu" : "/login", { replace: true });
    };
    window.addEventListener("keydown", go, { once: true });
    window.addEventListener("pointerdown", go, { once: true });
    return () => {
      window.removeEventListener("keydown", go);
      window.removeEventListener("pointerdown", go);
    };
  }, [ready, status, navigate]);

  return (
    <div className="screen boot">
      <Backdrop />
      <div className="boot-center">
        <div className="boot-logo"><Logo size="lg" /></div>
        <div className="boot-bar-wrap">
          <div className="boot-bar"><div style={{ width: `${progress}%` }} /></div>
          <div className="boot-meta">
            <span className="label">{label}</span>
            <span className="label">{progress}%</span>
          </div>
        </div>
        {serverDown && <div className="alert error" style={{ maxWidth: 420 }}>Servidor indisponível no momento. Você pode continuar, mas login e partidas não vão funcionar até a conexão voltar.</div>}
        <div className={`boot-press ${ready ? "on" : ""}`}>{t.boot.pressAnyKey}</div>
      </div>
      <div className="boot-foot label">Build {__APP_VERSION__} · Fase 1 · Acesso antecipado</div>
    </div>
  );
}
