import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { RANKS, type ClanLeaderboardResponse, type LevelLeaderboardResponse, type QueueMode, type RankedLeaderboardResponse } from "@vanta/shared";
import { api } from "../api/client";
import { Button } from "../components/ui";
import { ClanLogo } from "../components/Identity";
import { RankEmblem } from "../components/RankEmblem";
import { uiSound } from "../audio/ui-sound";

type Tab = "ranked" | "level" | "clans";
interface SeasonRow { id: string; number: number; name: string; isActive: boolean }

const profileLink = (u: string) => `/jogador/${encodeURIComponent(u)}`;

/** Rankings: top 100 do ranqueado (por modo e temporada), de nível e de clãs. */
export function RankingScreen() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("aba") as Tab) || "ranked";
  const [mode, setMode] = useState<QueueMode>("1v1");
  const [seasons, setSeasons] = useState<SeasonRow[]>([]);
  const [seasonId, setSeasonId] = useState<string>("");
  const [ranked, setRanked] = useState<RankedLeaderboardResponse | null>(null);
  const [level, setLevel] = useState<LevelLeaderboardResponse | null>(null);
  const [clans, setClans] = useState<ClanLeaderboardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<SeasonRow[]>("/ranked/seasons").then((s) => {
      setSeasons(s);
      setSeasonId(s.find((x) => x.isActive)?.id ?? s[0]?.id ?? "");
    }).catch(() => undefined);
  }, []);
  useEffect(() => {
    setError(null);
    if (tab === "ranked") {
      setRanked(null);
      api.get<RankedLeaderboardResponse>(`/ranked/leaderboard?mode=${mode}&limit=100${seasonId ? `&seasonId=${seasonId}` : ""}`).then(setRanked).catch((e: Error) => setError(e.message));
    } else if (tab === "level") api.get<LevelLeaderboardResponse>("/rankings/level?limit=100").then(setLevel).catch((e: Error) => setError(e.message));
    else api.get<ClanLeaderboardResponse>("/rankings/clans?limit=100").then(setClans).catch((e: Error) => setError(e.message));
  }, [tab, mode, seasonId]);

  const setTab = (t: Tab) => {
    uiSound.click();
    setParams({ aba: t }, { replace: true });
  };

  return (
    <div className="screen play-screen">
      <div className="play-wrap stagger">
        <div className="play-head"><Button variant="ghost" onClick={() => navigate("/menu")}>← Menu</Button></div>
        <h1>Ranking</h1>
        <div className="tabs" role="tablist">
          {([["ranked", "Ranqueado"], ["level", "Nível"], ["clans", "Clãs"]] as Array<[Tab, string]>).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)} data-testid={`ranking-tab-${k}`}>{label}</button>
          ))}
        </div>
        {error && <p className="error">{error}</p>}

        {tab === "ranked" && (
          <>
            <div className="row-gap">
              {(["1v1", "2v2", "3v3"] as QueueMode[]).map((m) => <button key={m} className={`btn-mini ${mode === m ? "" : "ghost"}`} onClick={() => setMode(m)} data-testid={`ranking-mode-${m}`}>{m}</button>)}
              {seasons.length > 0 && (
                <select className="input season-select" value={seasonId} onChange={(e) => setSeasonId(e.target.value)} data-testid="ranking-season">
                  {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}{s.isActive ? " (atual)" : ""}</option>)}
                </select>
              )}
            </div>
            <div className="panel cut room-list-panel">
              {!ranked ? <p className="muted">Carregando…</p> : !ranked.season ? <p className="muted">Nenhuma temporada ativa.</p> : ranked.entries.length === 0 ? <p className="muted">Ninguém terminou a classificação em {ranked.mode} nesta temporada.</p> : (
                <table className="room-table" data-testid="ranking-ranked">
                  <thead><tr><th>#</th><th>Jogador</th><th>Patente</th><th>PP</th><th>V/D</th></tr></thead>
                  <tbody>{ranked.entries.map((e) => (
                    <tr key={e.userId}><td>{e.position}</td><td><Link to={profileLink(e.username)}>{e.username}</Link> <span className="muted small">nv {e.level}</span></td><td><span className="rank-cell"><RankEmblem order={e.rankOrder} size={24} /> {RANKS[e.rankOrder - 1]?.name}</span></td><td>{e.points}</td><td>{e.wins}/{e.losses}</td></tr>
                  ))}</tbody>
                </table>
              )}
              {ranked?.me && <p className="small">Sua posição: #{ranked.me.position} · {ranked.me.points} PP</p>}
            </div>
          </>
        )}

        {tab === "level" && (
          <div className="panel cut room-list-panel">
            {!level ? <p className="muted">Carregando…</p> : (
              <table className="room-table" data-testid="ranking-level">
                <thead><tr><th>#</th><th>Jogador</th><th>Nível</th><th>XP total</th></tr></thead>
                <tbody>{level.entries.map((e) => (
                  <tr key={e.userId}><td>{e.position}</td><td>{e.clanTag && <Link to={`/cla/${e.clanTag}`} className="muted">[{e.clanTag}] </Link>}<Link to={profileLink(e.username)}>{e.username}</Link>{e.title && <span className="muted small"> · {e.title}</span>}</td><td>{e.level}</td><td>{e.totalXp.toLocaleString("pt-BR")}</td></tr>
                ))}</tbody>
              </table>
            )}
            {level?.me && <p className="small">Sua posição: #{level.me.position} de {level.total} · nível {level.me.level}</p>}
          </div>
        )}

        {tab === "clans" && (
          <div className="panel cut room-list-panel">
            {!clans ? <p className="muted">Carregando…</p> : clans.entries.length === 0 ? <p className="muted">Nenhum clã ainda. <Link to="/cla">Crie o primeiro.</Link></p> : (
              <table className="room-table" data-testid="ranking-clans">
                <thead><tr><th>#</th><th>Clã</th><th>Pontos</th><th>V/D</th><th>Membros</th></tr></thead>
                <tbody>{clans.entries.map((c) => (
                  <tr key={c.id} data-testid={`ranking-clan-${c.tag}`}><td>{c.position}</td><td><Link to={`/cla/${c.tag}`} className="rank-cell"><ClanLogo logoKey={c.logoKey} tag={c.tag} size={26} /> [{c.tag}] {c.name}</Link></td><td>{c.points}</td><td>{c.wins}/{c.losses}</td><td>{c.members}</td></tr>
                ))}</tbody>
              </table>
            )}
            {clans?.mine && <p className="small">Seu clã: #{clans.mine.position} · [{clans.mine.tag}]</p>}
          </div>
        )}
      </div>
    </div>
  );
}
