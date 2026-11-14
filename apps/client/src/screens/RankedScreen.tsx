import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MAP_REGISTRY, RANKS, rankProgress, type QueueMode, type RankedLeaderboardResponse, type RankedOverviewResponse } from "@vanta/shared";
import { api } from "../api/client";
import { Button } from "../components/ui";
import { RankEmblem } from "../components/RankEmblem";
import { uiSound } from "../audio/ui-sound";

const MODES_LIST: QueueMode[] = ["1v1", "2v2", "3v3"];
const RESULT_LABEL = { WIN: "Vitória", LOSS: "Derrota", DRAW: "Empate", ABANDONED: "Abandono" } as const;

/** Central competitiva: patente por modo, classificação, histórico, ranking da temporada e escada de patentes. */
export function RankedScreen() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<QueueMode>(() => (localStorage.getItem("vanta.mode") as QueueMode) || "1v1");
  const [overview, setOverview] = useState<RankedOverviewResponse | null>(null);
  const [board, setBoard] = useState<RankedLeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<RankedOverviewResponse>("/ranked/overview").then(setOverview).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    setBoard(null);
    api.get<RankedLeaderboardResponse>(`/ranked/leaderboard?mode=${mode}&limit=50`).then(setBoard).catch((e: Error) => setError(e.message));
  }, [mode]);

  const season = overview?.season ?? null;
  const st = overview?.modes.find((m) => m.mode === mode) ?? null;
  const placed = !!st && st.rankOrder !== null;
  const rp = placed ? rankProgress(st!.points) : null;
  const daysLeft = season ? Math.max(0, Math.ceil((new Date(season.endsAt).getTime() - Date.now()) / 86_400_000)) : 0;
  const played = st ? st.wins + st.losses : 0;

  const play = () => {
    uiSound.click();
    localStorage.setItem("vanta.mode", mode);
    localStorage.setItem("vanta.ranked", "1");
    navigate("/jogar");
  };

  return (
    <div className="screen play-screen ranked-screen">
      <div className="play-wrap stagger">
        <div className="play-head">
          <Button variant="ghost" onClick={() => navigate("/menu")}>← Menu</Button>
          <span className="muted" data-testid="season-name">{season ? `${season.name} · termina em ${daysLeft} ${daysLeft === 1 ? "dia" : "dias"}` : overview ? "Sem temporada em andamento" : ""}</span>
        </div>
        <h1>Ranqueado</h1>
        {error && <div className="alert error">{error}</div>}

        <div className="queue-type" role="tablist" aria-label="Modo">
          {MODES_LIST.map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} className={`queue-tab ${mode === m ? "on" : ""}`} onClick={() => { uiSound.click(); setMode(m); }} data-testid={`ranked-mode-${m}`}>
              <strong>{m}</strong>
            </button>
          ))}
        </div>

        <div className="ranked-grid">
          <section className="panel cut ranked-hero" data-testid="ranked-status">
            {!overview ? (
              <span className="muted">Carregando…</span>
            ) : !season ? (
              <>
                <strong className="rh-name">Pré-temporada</strong>
                <span className="muted">Não há temporada ranqueada em andamento. As filas ranqueadas abrem quando a próxima temporada começar. As partidas casuais seguem liberadas.</span>
              </>
            ) : placed && rp ? (
              <>
                <RankEmblem order={rp.rank.order} size={112} />
                <strong className="rh-name" style={{ color: rp.rank.color }} data-testid="ranked-rank">{rp.rank.name}</strong>
                <span className="rh-points" data-testid="ranked-points">{st!.points} PP</span>
                <div className="xp big"><div style={{ width: `${rp.progress * 100}%`, background: rp.rank.color }} /></div>
                <span className="muted">{rp.next ? `Faltam ${rp.next.minPoints - st!.points} PP para ${rp.next.name}` : "Patente máxima"}</span>
              </>
            ) : (
              <>
                <div className="placement-badge big">?</div>
                <strong className="rh-name">Em classificação</strong>
                <div className="placement-pips" aria-hidden>
                  {Array.from({ length: season.placementMatches }, (_, i) => <i key={i} className={i < season.placementMatches - (st?.placementLeft ?? season.placementMatches) ? "on" : ""} />)}
                </div>
                <span className="muted" data-testid="ranked-placement">Faltam {st?.placementLeft ?? season.placementMatches} de {season.placementMatches} partidas para revelar sua patente em {mode}.</span>
              </>
            )}
            {season && (
              <>
                <div className="rh-stats">
                  <div><b>{st?.wins ?? 0}</b><span className="label">Vitórias</span></div>
                  <div><b>{st?.losses ?? 0}</b><span className="label">Derrotas</span></div>
                  <div><b>{played ? Math.round(((st?.wins ?? 0) / played) * 100) : 0}%</b><span className="label">Aproveitamento</span></div>
                  <div><b>{st?.winStreak ?? 0}</b><span className="label">Sequência</span></div>
                </div>
                {overview!.cooldownSeconds > 0 && <div className="alert error" data-testid="ranked-cooldown">Fila ranqueada bloqueada por abandono por mais {Math.ceil(overview!.cooldownSeconds / 60)} min.</div>}
                <Button onClick={play} data-testid="ranked-play">Jogar ranqueada {mode}</Button>
              </>
            )}
          </section>

          <section className="panel cut ranked-board">
            <div className="side-head"><span className="label">Ranking da temporada · {mode}</span>{board?.me && <span className="muted" data-testid="my-position">Sua posição: {board.me.position}º</span>}</div>
            {!board ? <span className="muted">Carregando…</span> : board.entries.length === 0 ? (
              <span className="muted" data-testid="board-empty">Ninguém terminou a classificação neste modo ainda. O ranking mostra só jogadores reais com patente revelada.</span>
            ) : (
              <table className="sb-table" data-testid="leaderboard">
                <thead><tr><th>Jogador</th><th>PP</th><th>V</th><th>D</th></tr></thead>
                <tbody>
                  {board.entries.map((e) => {
                    const r = RANKS[e.rankOrder - 1]!;
                    return (
                      <tr key={e.userId} className={board.me?.position === e.position ? "me" : ""}>
                        <td><span className="lb-pos">{e.position}</span><RankEmblem order={r.order} size={22} /> {e.username} <span className="muted">· nv. {e.level}</span></td>
                        <td>{e.points}</td><td>{e.wins}</td><td>{e.losses}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </div>

        <section className="panel cut ranked-history">
          <div className="side-head"><span className="label">Partidas ranqueadas recentes</span></div>
          {!overview ? <span className="muted">Carregando…</span> : overview.recent.length === 0 ? <span className="muted">Você ainda não jogou partidas ranqueadas nesta temporada.</span> : (
            <table className="sb-table" data-testid="ranked-history">
              <thead><tr><th>Resultado</th><th>Modo</th><th>Placar</th><th>K/D/A</th><th>PP</th></tr></thead>
              <tbody>
                {overview.recent.map((m) => (
                  <tr key={m.matchId}>
                    <td><b className={`res ${m.result}`}>{RESULT_LABEL[m.result]}</b> <span className="muted">· {MAP_REGISTRY[m.map]?.name ?? m.map}{m.mvp ? " · MVP" : ""}</span></td>
                    <td>{m.mode}</td>
                    <td>{m.score[0]} × {m.score[1]}</td>
                    <td>{m.kills}/{m.deaths}/{m.assists}</td>
                    <td className={m.pointsDelta && m.pointsDelta > 0 ? "up" : m.pointsDelta && m.pointsDelta < 0 ? "down" : ""}>{m.pointsDelta === null ? "—" : `${m.pointsDelta > 0 ? "+" : ""}${m.pointsDelta}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="panel cut ranked-ladder">
          <div className="side-head"><span className="label">As 15 patentes</span></div>
          <div className="ladder">
            {RANKS.map((r) => (
              <div key={r.code} className={`ladder-item ${placed && rp?.rank.order === r.order ? "on" : ""}`}>
                <RankEmblem order={r.order} size={40} />
                <strong style={{ color: r.color }}>{r.name}</strong>
                <span className="muted">{r.minPoints} PP</span>
              </div>
            ))}
          </div>
          <span className="muted">Como funciona: cada modo tem patente própria. As {season?.placementMatches ?? 5} primeiras partidas são de classificação. Depois, vitória soma e derrota tira pontos de patente (PP); vencer adversários mais fortes rende mais. Sequência de vitórias e MVP dão bônus pequeno. Abandonar conta como derrota com penalidade e bloqueia a fila ranqueada por 5, 15 ou 60 minutos. No fim da temporada o ranking é registrado e as patentes passam por um reinício parcial.</span>
        </section>
      </div>
    </div>
  );
}
