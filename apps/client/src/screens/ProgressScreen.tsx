import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { MissionView, ProgressionResponse } from "@vanta/shared";
import { api, ApiError } from "../api/client";
import { Button, useToast } from "../components/ui";
import { uiSound } from "../audio/ui-sound";
import { useAuth } from "../auth/AuthContext";

type Tab = "missions" | "achievements" | "medals" | "history";
const PERIOD_LABEL: Record<MissionView["period"], string> = { DAILY: "Diárias", WEEKLY: "Semanais", EVENT: "Do evento", SEASONAL: "Da temporada", ONE_TIME: "Especiais" };

function renewsIn(iso: string | null) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "renovando…";
  const h = Math.floor(ms / 3600_000);
  return h >= 24 ? `renova em ${Math.floor(h / 24)} d ${h % 24} h` : `renova em ${h} h ${Math.floor((ms % 3600_000) / 60_000)} min`;
}

/** Nível, missões (com resgate), conquistas, medalhas, títulos e histórico de XP. Tudo vem do servidor. */
export function ProgressScreen() {
  const navigate = useNavigate();
  const toast = useToast();
  const { reloadMe } = useAuth();
  const [data, setData] = useState<ProgressionResponse | null>(null);
  const [tab, setTab] = useState<Tab>("missions");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.get<ProgressionResponse>("/progression").then(setData).catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);

  const claim = async (m: MissionView) => {
    setBusy(m.id);
    try {
      const r = await api.post<{ xp: number; coins: number; achievementsUnlocked: Array<{ name: string }> }>(`/progression/missions/${m.id}/claim`);
      uiSound.success();
      toast("Recompensa resgatada", `+${r.xp} XP${r.coins ? ` e ${r.coins} VANTA COINS` : ""}${r.achievementsUnlocked.length ? ` · conquista: ${r.achievementsUnlocked.map((a) => a.name).join(", ")}` : ""}`);
      await Promise.all([load(), reloadMe().catch(() => undefined)]);
    } catch (e) {
      uiSound.error();
      toast("Não deu certo", e instanceof ApiError ? e.message : "Tente de novo.");
    } finally {
      setBusy(null);
    }
  };

  const setTitle = async (title: string | null) => {
    try {
      await api.put("/profile/title", { title });
      toast("Título", title ? `Agora você aparece como “${title}”.` : "Título removido.");
      await Promise.all([load(), reloadMe().catch(() => undefined)]);
    } catch (e) {
      toast("Não deu certo", e instanceof ApiError ? e.message : "Tente de novo.");
    }
  };

  const groups = data ? (["DAILY", "WEEKLY", "EVENT", "SEASONAL", "ONE_TIME"] as const).map((p) => [p, data.missions.filter((m) => m.period === p)] as const).filter(([, l]) => l.length) : [];

  return (
    <div className="screen play-screen">
      <div className="play-wrap stagger">
        <div className="play-head">
          <Button variant="ghost" onClick={() => navigate("/menu")}>← Menu</Button>
        </div>
        <h1>Progresso</h1>
        {error && <p className="error">{error}</p>}
        {!data ? <p className="muted">Carregando…</p> : (
          <>
            <div className="panel cut progress-head" data-testid="progress-head">
              <div className="level-badge"><span className="label">Nível</span><strong data-testid="progress-level">{data.level}</strong></div>
              <div className="progress-main">
                <div className="xp-bar big"><i style={{ width: `${data.xpForNext ? Math.round((data.xpIntoLevel / data.xpForNext) * 100) : 100}%` }} /></div>
                <span className="muted small">{data.xpIntoLevel} / {data.xpForNext} XP para o próximo nível · {data.totalXp} XP no total</span>
              </div>
              <label className="field-inline title-pick">
                <span className="label">Título</span>
                <select className="input" value={data.title ?? ""} onChange={(e) => void setTitle(e.target.value || null)} data-testid="title-select">
                  <option value="">Sem título</option>
                  {data.titles.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                {data.titles.length === 0 && <span className="muted small">Desbloqueie títulos com conquistas.</span>}
              </label>
            </div>

            <div className="tabs" role="tablist">
              {([["missions", "Missões"], ["achievements", "Conquistas"], ["medals", "Medalhas"], ["history", "Histórico"]] as Array<[Tab, string]>).map(([k, label]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => { uiSound.click(); setTab(k); }} data-testid={`progress-tab-${k}`}>{label}</button>
              ))}
            </div>

            {tab === "missions" && groups.map(([period, list]) => (
              <section key={period} className="mission-group">
                <div className="side-head"><span className="label">{PERIOD_LABEL[period]}</span><span className="muted small">{renewsIn(list[0]!.endsAt)}</span></div>
                <div className="mission-grid">
                  {list.map((m) => (
                    <div key={m.id} className={`panel cut mission ${m.completed ? "done" : ""}`} data-testid={`mission-${m.code}`}>
                      <strong>{m.name}</strong>
                      <span className="muted small">{m.description}{m.event ? ` · ${m.event.name}` : ""}</span>
                      <div className="xp-bar"><i style={{ width: `${Math.round((m.progress / m.target) * 100)}%` }} /></div>
                      <div className="mission-foot">
                        <span className="small">{m.progress}/{m.target}</span>
                        <span className="small reward">+{m.rewardXp} XP{m.rewardCoins ? ` · ${m.rewardCoins} VC` : ""}</span>
                        {m.claimed ? <span className="pill">Resgatada</span> : m.completed ? <button className="btn-mini" disabled={busy === m.id} onClick={() => void claim(m)} data-testid={`claim-${m.code}`}>Resgatar</button> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}

            {tab === "achievements" && (
              <div className="mission-grid">
                {data.achievements.map((a) => (
                  <div key={a.id} className={`panel cut mission ${a.unlockedAt ? "done" : "locked"}`} data-testid={`achievement-${a.code}`}>
                    <strong>{a.name}</strong>
                    <span className="muted small">{a.description}</span>
                    <div className="xp-bar"><i style={{ width: `${Math.round((Math.min(a.progress, a.target) / a.target) * 100)}%` }} /></div>
                    <div className="mission-foot">
                      <span className="small">{a.unlockedAt ? `Desbloqueada em ${new Date(a.unlockedAt).toLocaleDateString("pt-BR")}` : `${a.progress}/${a.target}`}</span>
                      <span className="small reward">{a.rewardXp ? `+${a.rewardXp} XP` : ""}{a.rewardTitle ? ` · título “${a.rewardTitle}”` : ""}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === "medals" && (
              <div className="mission-grid">
                {data.medals.map((m) => (
                  <div key={m.code} className={`panel cut mission ${m.count ? "done" : "locked"}`} data-testid={`medal-${m.code}`}>
                    <strong>{m.name} <span className="medal-count">×{m.count}</span></strong>
                    <span className="muted small">{m.description}</span>
                  </div>
                ))}
              </div>
            )}

            {tab === "history" && (
              <div className="panel cut room-list-panel">
                {data.history.length === 0 ? <p className="muted">Jogue uma partida da fila para ganhar XP. Partidas de sala não contam.</p> : (
                  <table className="room-table" data-testid="xp-history">
                    <thead><tr><th>Quando</th><th>Origem</th><th>XP</th><th>Nível depois</th></tr></thead>
                    <tbody>{data.history.map((h, i) => <tr key={i}><td>{new Date(h.at).toLocaleString("pt-BR")}</td><td>{h.label}</td><td>+{h.amount}</td><td>{h.levelAfter}</td></tr>)}</tbody>
                  </table>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
