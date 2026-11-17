import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { rankProgress } from "@vanta/shared";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { Button, useToast } from "../components/ui";
import { RankEmblem } from "../components/RankEmblem";

export function ProfilePanel({ onClose }: { onClose: () => void }) {
  const { me, logoutAll } = useAuth();
  const toast = useToast();
  const [sending, setSending] = useState(false);
  const navigate = useNavigate();
  if (!me) return null;
  const rp = rankProgress(me.ranked?.points ?? 0);

  async function resend() {
    setSending(true);
    try {
      await api.post("/auth/resend-verification");
      toast("E-mail enviado", `Enviamos um novo link para ${me!.user.email}.`);
    } catch (e) {
      toast("Não foi possível enviar", (e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <section className="drawer panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Perfil">
        <div className="drawer-head">
          <div>
            <div className="label">Perfil do operador</div>
            <h2>{me.user.username}</h2>
            {me.profile.title && <div className="label" style={{ color: "var(--c-purple)" }}>{me.profile.title}</div>}
          </div>
          <button className="icon-btn panel cut cut-sm" onClick={onClose} aria-label="Fechar">✕</button>
        </div>

        <div className="profile-grid">
          <div className="stat"><span className="label">Nível</span><strong>{me.profile.level}</strong><span className="muted">{me.profile.xpIntoLevel} / {me.profile.xpForNext} XP</span></div>
          <div className="stat"><span className="label">XP total</span><strong>{me.profile.totalXp.toLocaleString("pt-BR")}</strong></div>
          <div className="stat"><span className="label">VANTA COINS</span><strong>{me.wallet.balance.toLocaleString("pt-BR")}</strong></div>
          <div className="stat rank"><RankEmblem order={rp.rank.order} size={52} /><div><span className="label">Patente</span><strong style={{ color: rp.rank.color }}>{me.ranked ? rp.rank.name : "Sem patente"}</strong><span className="muted">{me.ranked ? `${me.ranked.placementMatchesLeft} partidas de classificação restantes` : "Ranqueado abre na Temporada 1"}</span></div></div>
        </div>

        <div style={{ marginTop: 16 }}>
          <Button variant="ghost" block onClick={() => navigate(`/jogador/${encodeURIComponent(me.user.username)}`)} data-testid="open-public-profile">Ver perfil público e cartão</Button>
        </div>

        <h3 className="label" style={{ marginTop: 28 }}>Conta e segurança</h3>
        <div className="kv"><span>E-mail</span><span>{me.user.email}</span></div>
        <div className="kv">
          <span>Verificação</span>
          {me.user.emailVerified ? <span style={{ color: "var(--c-green)" }}>Confirmado</span> : (
            <span style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <span style={{ color: "var(--c-amber)" }}>Pendente</span>
              <Button variant="ghost" onClick={resend} loading={sending} style={{ height: 34, padding: "0 14px", fontSize: 11 }}>Reenviar</Button>
            </span>
          )}
        </div>
        <div className="kv"><span>Membro desde</span><span>{new Date(me.user.createdAt).toLocaleDateString("pt-BR")}</span></div>
        <div style={{ marginTop: 24 }}>
          <Button variant="ghost" block onClick={() => void logoutAll()}>Encerrar sessão em todos os dispositivos</Button>
        </div>
        <p className="muted" style={{ marginTop: 18, fontSize: 12 }}>Estatísticas de partida, histórico e cartão de jogador entram com as Fases 3 e 7.</p>
      </section>
    </div>
  );
}
