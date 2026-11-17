import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { AVATAR_COLORS, MEDALS, PLAYER_CARDS, RANKS, type MedalCode, type PlayerCardView, type PublicProfileResponse } from "@vanta/shared";
import { api, ApiError } from "../api/client";
import { Button, useToast } from "../components/ui";
import { PlayerCard } from "../components/Identity";
import { RankEmblem } from "../components/RankEmblem";
import { mapName } from "./RoomsScreen";
import { uiSound } from "../audio/ui-sound";

const RESULT = { WIN: "Vitória", LOSS: "Derrota", DRAW: "Empate", ABANDON: "Abandono" } as const;

/** Perfil público de qualquer jogador: cartão, estatísticas, patentes, medalhas, conquistas e últimas partidas. */
export function PlayerProfileScreen() {
  const { username = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState<PublicProfileResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api.get<PublicProfileResponse>(`/players/${encodeURIComponent(username)}`).then(setData).catch((e: Error) => setError(e.message));
  }, [username]);

  const saveCard = async (playerCardKey: string, avatarKey: string) => {
    try {
      const card = await api.put<PlayerCardView>("/profile/card", { playerCardKey, avatarKey });
      uiSound.success();
      setData((d) => (d ? { ...d, card } : d));
    } catch (e) {
      uiSound.error();
      toast("Não deu certo", e instanceof ApiError ? e.message : "Tente de novo.");
    }
  };

  const s = data?.stats;
  return (
    <div className="screen play-screen">
      <div className="play-wrap stagger">
        <div className="play-head">
          <Button variant="ghost" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/menu"))}>← Voltar</Button>
        </div>
        {error && <p className="error" data-testid="profile-error">{error}</p>}
        {!data && !error && <p className="muted">Carregando…</p>}
        {data && s && (
          <>
            <PlayerCard card={data.card} />
            <p className="muted small">Membro desde {new Date(data.memberSince).toLocaleDateString("pt-BR")}{data.relation === "friend" ? " · vocês são amigos" : ""}</p>

            {data.relation === "self" && (
              <section className="panel cut card-pick" data-testid="card-pick">
                <span className="label">Seu cartão</span>
                <div className="card-options">
                  {PLAYER_CARDS.map((c) => {
                    const locked = data.card.level < c.minLevel;
                    return (
                      <button key={c.key} className={`card-option ${data.card.playerCardKey === c.key ? "on" : ""}`} disabled={locked} style={{ background: `linear-gradient(120deg, ${c.from}, ${c.to})`, borderColor: c.accent }} onClick={() => void saveCard(c.key, data.card.avatarKey)} data-testid={`card-${c.key}`} title={locked ? `Abre no nível ${c.minLevel}` : c.name}>
                        <span>{c.name}</span>
                        {locked && <small>Nível {c.minLevel}</small>}
                      </button>
                    );
                  })}
                </div>
                <span className="label">Cor do avatar</span>
                <div className="avatar-options">
                  {Object.entries(AVATAR_COLORS).map(([k, color]) => (
                    <button key={k} className={`swatch ${data.card.avatarKey === k ? "on" : ""}`} style={{ background: color }} aria-label={`Cor ${k}`} onClick={() => void saveCard(data.card.playerCardKey, k)} data-testid={`avatar-${k}`} />
                  ))}
                </div>
                <span className="muted small">Cartões novos abrem conforme você sobe de nível. Nada aqui é vendido.</span>
              </section>
            )}

            <div className="profile-grid wide">
              <div className="stat"><span className="label">Partidas</span><strong>{s.matchesPlayed}</strong><span className="muted">{s.wins} V · {s.losses} D</span></div>
              <div className="stat"><span className="label">Taxa de vitória</span><strong>{s.matchesPlayed ? Math.round((s.wins / s.matchesPlayed) * 100) : 0}%</strong></div>
              <div className="stat"><span className="label">K/D</span><strong>{s.deaths ? (s.kills / s.deaths).toFixed(2) : s.kills}</strong><span className="muted">{s.kills} abates · {s.assists} assist.</span></div>
              <div className="stat"><span className="label">Precisão</span><strong>{s.accuracy}%</strong><span className="muted">{s.headshots} headshots</span></div>
              <div className="stat"><span className="label">MVP</span><strong>{s.mvpCount}</strong></div>
            </div>

            <section>
              <div className="side-head"><span className="label">Patentes da temporada</span></div>
              {data.ranked.length === 0 ? <p className="muted small">Ainda não jogou ranqueada nesta temporada.</p> : (
                <div className="mission-grid">
                  {data.ranked.map((r) => (
                    <div key={r.mode} className="panel cut mission ranked-mini" data-testid={`profile-ranked-${r.mode}`}>
                      {r.placementLeft > 0 ? <span className="muted small">{r.mode} · em classificação ({r.placementLeft} restantes)</span> : (
                        <>
                          <RankEmblem order={r.rankOrder} size={40} />
                          <div><strong>{RANKS[r.rankOrder - 1]?.name}</strong><span className="muted small"> · {r.mode} · {r.points} PP · {r.wins}V {r.losses}D</span></div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section>
              <div className="side-head"><span className="label">Medalhas e conquistas</span></div>
              <div className="chips-row">
                {data.medals.length === 0 && data.achievements.length === 0 && <span className="muted small">Nenhuma ainda.</span>}
                {data.medals.map((m) => <span key={m.code} className="pill medal-pill" title={MEDALS[m.code as MedalCode]?.description}>{MEDALS[m.code as MedalCode]?.name ?? m.code} ×{m.count}</span>)}
                {data.achievements.map((a) => <span key={a.code} className="pill ach-pill" title={`Desbloqueada em ${new Date(a.unlockedAt).toLocaleDateString("pt-BR")}`}>{a.name}</span>)}
              </div>
            </section>

            <section className="panel cut room-list-panel">
              <span className="label">Últimas partidas</span>
              {data.recent.length === 0 ? <p className="muted">Nenhuma partida da fila ainda.</p> : (
                <table className="room-table" data-testid="profile-recent">
                  <thead><tr><th>Quando</th><th>Modo</th><th>Mapa</th><th>Resultado</th><th>K/D/A</th><th>Medalhas</th>{data.relation === "self" && <th />}</tr></thead>
                  <tbody>
                    {data.recent.map((m) => (
                      <tr key={m.matchId}>
                        <td>{m.endedAt ? new Date(m.endedAt).toLocaleString("pt-BR") : "—"}</td>
                        <td>{m.mode}{m.type === "RANKED" ? " · ranq." : ""}</td>
                        <td>{mapName(m.map)}</td>
                        <td className={m.result === "WIN" ? "win" : m.result === "LOSS" || m.result === "ABANDON" ? "loss" : ""}>{m.result ? RESULT[m.result] : "—"}{m.mvp ? " · MVP" : ""}</td>
                        <td>{m.kills}/{m.deaths}/{m.assists}</td>
                        <td className="small">{m.medals.map((c) => MEDALS[c as MedalCode]?.name ?? c).join(", ") || "—"}</td>
                        {data.relation === "self" && <td>{m.hasReplay ? <Link to={`/replay/${m.matchId}`} className="btn-mini ghost" data-testid={`replay-link-${m.matchId}`}>Replay</Link> : <span className="muted small" title="Replays ficam guardados por 30 dias">—</span>}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            {data.card.clan && <p className="small">Clã: <Link to={`/cla/${data.card.clan.tag}`}>[{data.card.clan.tag}] {data.card.clan.name}</Link></p>}
          </>
        )}
      </div>
    </div>
  );
}
