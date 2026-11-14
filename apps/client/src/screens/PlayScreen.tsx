import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MODES, RANKS, weaponStatsFromRow, type QueueMode, type RankedOverviewResponse, type WeaponStats } from "@vanta/shared";
import { api } from "../api/client";
import { gameSocket, type SocketStatus } from "../net/GameSocket";
import { Button } from "../components/ui";
import { RankEmblem } from "../components/RankEmblem";
import { uiSound } from "../audio/ui-sound";

export const LOADOUT_KEY = "vanta.trainingLoadout";
export const DEFAULT_LOADOUT = ["VK7_LAMINA", "P9_FAISCA", "LR1_HORIZONTE"];
const CATEGORY_LABEL: Record<WeaponStats["category"], string> = { ASSAULT_RIFLE: "Rifle de assalto", SMG: "Submetralhadora", SNIPER: "Sniper", SHOTGUN: "Escopeta", PISTOL: "Pistola" };

export function loadLoadout(): string[] {
  try {
    const l = JSON.parse(localStorage.getItem(LOADOUT_KEY) ?? "null");
    return Array.isArray(l) && l.length === 3 ? l : DEFAULT_LOADOUT;
  } catch {
    return DEFAULT_LOADOUT;
  }
}

const MODE_INFO: Record<QueueMode, string> = {
  "1v1": "Duelo direto. Melhor de 9 rounds (vence quem fizer 5).",
  "2v2": "Dupla contra dupla. Vence quem fizer 6 rounds.",
  "3v3": "Equipes de três. Vence quem fizer 7 rounds.",
};

/** Seleção de modo, arsenal e fila de partidas (apenas jogadores reais). */
export function PlayScreen() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<QueueMode>(() => (localStorage.getItem("vanta.mode") as QueueMode) || "1v1");
  const [status, setStatus] = useState<SocketStatus>(gameSocket.status);
  const [ranked, setRanked] = useState<boolean>(() => localStorage.getItem("vanta.ranked") === "1");
  const [overview, setOverview] = useState<RankedOverviewResponse | null>(null);
  const [overviewAt, setOverviewAt] = useState(Date.now());
  const [queue, setQueue] = useState<{ inQueue: number; needed: number; since: number; ranked: boolean } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const [weapons, setWeapons] = useState<WeaponStats[] | null>(null);
  const [loadout, setLoadout] = useState<string[]>(loadLoadout);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    api.get<Array<Record<string, unknown>>>("/content/weapons").then((rows) => setWeapons(rows.map(weaponStatsFromRow))).catch(() => setWeapons([]));
  }, []);

  const loadOverview = () => api.get<RankedOverviewResponse>("/ranked/overview").then((o) => { setOverview(o); setOverviewAt(Date.now()); }).catch(() => setOverview(null));
  useEffect(() => { void loadOverview(); }, []);

  useEffect(() => {
    gameSocket.connect();
    const offS = gameSocket.onStatus(setStatus);
    const offM = gameSocket.on((m) => {
      if (m.t === "queue") {
        setQueue(m.state === "searching" ? { inQueue: m.inQueue!, needed: m.needed!, since: m.since!, ranked: !!m.ranked } : null);
        if (m.state === "searching" && m.mode) { setMode(m.mode); setRanked(!!m.ranked); }
      }
      if (m.t === "match") {
        uiSound.success();
        navigate("/partida");
      }
      if (m.t === "welcome" && m.inMatch) navigate("/partida");
      if (m.t === "error") {
        setError(m.message);
        if (m.code === "RANKED_COOLDOWN" || m.code === "NO_SEASON") void loadOverview();
      }
    });
    if (gameSocket.inMatch) navigate("/partida");
    return () => {
      offS();
      offM();
    };
  }, [navigate]);

  const cooldownBase = overview?.cooldownSeconds ?? 0;
  useEffect(() => {
    if (!queue && !cooldownBase) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [queue, cooldownBase]);

  const search = () => {
    uiSound.click();
    setError(null);
    localStorage.setItem("vanta.mode", mode);
    localStorage.setItem("vanta.ranked", ranked ? "1" : "0");
    gameSocket.queue(mode, loadout, ranked);
  };
  const cancel = () => {
    uiSound.click();
    gameSocket.send({ t: "cancel_queue" });
    setQueue(null);
  };
  const pick = (slot: number, code: string) => {
    const next = [...loadout];
    next[slot] = code;
    setLoadout(next);
    try { localStorage.setItem(LOADOUT_KEY, JSON.stringify(next)); } catch { /* sem armazenamento */ }
  };

  const elapsed = queue ? Math.max(0, Math.floor((now - queue.since) / 1000)) : 0;
  const cooldown = cooldownBase > 0 ? Math.max(0, Math.ceil(cooldownBase - Math.max(0, now - overviewAt) / 1000)) : 0;
  const season = overview?.season ?? null;
  const modeStatus = overview?.modes.find((x) => x.mode === mode) ?? null;
  const rankDef = modeStatus?.rankOrder ? RANKS[modeStatus.rankOrder - 1]! : null;
  const rankedBlocked = ranked && (!season || cooldown > 0);
  const byCode = new Map((weapons ?? []).map((w) => [w.code, w]));

  return (
    <div className="screen play-screen">
      <div className="play-wrap stagger">
        <div className="play-head">
          <Button variant="ghost" onClick={() => navigate("/menu")} disabled={!!queue}>← Menu</Button>
          <span className={`net-dot ${status}`} data-testid="net-status">{status === "online" ? "Conectado ao servidor de jogo" : status === "offline" ? "Servidor de jogo indisponível" : "Conectando…"}</span>
        </div>
        <h1>Jogar</h1>

        <div className="queue-type" role="tablist" aria-label="Tipo de partida">
          <button role="tab" aria-selected={!ranked} className={`queue-tab ${!ranked ? "on" : ""}`} disabled={!!queue} onClick={() => { uiSound.click(); setRanked(false); setError(null); }} data-testid="queue-casual">
            <strong>Casual</strong><span className="muted">Sem pontos de patente</span>
          </button>
          <button role="tab" aria-selected={ranked} className={`queue-tab ranked ${ranked ? "on" : ""}`} disabled={!!queue} onClick={() => { uiSound.click(); setRanked(true); setError(null); }} data-testid="queue-ranked">
            <strong>Ranqueado</strong><span className="muted">{season ? season.name : "Sem temporada em andamento"}</span>
          </button>
        </div>

        <div className="mode-cards">
          {(Object.keys(MODES) as QueueMode[]).map((m) => (
            <button key={m} className={`mode-card panel cut ${mode === m ? "on" : ""}`} onClick={() => !queue && setMode(m)} disabled={!!queue} data-testid={`mode-${m}`}>
              <span className="label">{MODES[m].label}</span>
              <strong>{m}</strong>
              <span className="muted">{MODE_INFO[m]}</span>
            </button>
          ))}
          <button className="mode-card panel cut" onClick={() => navigate("/treinamento")} disabled={!!queue}>
            <span className="label">Sozinho</span>
            <strong>Treino</strong>
            <span className="muted">Campo de tiro com alvos e drone. Não conta para estatísticas.</span>
          </button>
        </div>

        <div className="loadout-strip panel cut">
          <span className="label">Arsenal</span>
          {loadout.map((c, i) => <span key={i} className="chip">{i + 1} · {byCode.get(c)?.name ?? c}</span>)}
          <Button variant="ghost" onClick={() => setEditing((e) => !e)} disabled={!!queue || !weapons?.length}>{editing ? "Fechar" : "Alterar"}</Button>
        </div>
        {editing && weapons && (
          <div className="loadout-slots panel cut" style={{ padding: 16 }}>
            {[0, 1, 2].map((slot) => (
              <div key={slot} className="loadout-col">
                <span className="label">Slot {slot + 1}</span>
                {weapons.map((wp) => (
                  <button key={wp.code} className={`wp ${loadout[slot] === wp.code ? "on" : ""}`} disabled={loadout.includes(wp.code) && loadout[slot] !== wp.code} onClick={() => pick(slot, wp.code)}>
                    <strong>{wp.name}</strong>
                    <span>{CATEGORY_LABEL[wp.category]} · {wp.damage}{wp.pelletsPerShot > 1 ? `×${wp.pelletsPerShot}` : ""} dano · {wp.fireRateRpm} RPM</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className="queue-bar panel cut">
          {queue ? (
            <>
              <div className="queue-info" data-testid="queue-status">
                <span className="label">Procurando partida {queue.ranked ? "ranqueada" : "casual"} · {MODES[mode].label}</span>
                <strong>{String(Math.floor(elapsed / 60)).padStart(2, "0")}:{String(elapsed % 60).padStart(2, "0")}</strong>
                <span className="muted">{queue.inQueue} de {queue.needed} jogadores na fila{queue.ranked ? " · a faixa de habilidade aceita aumenta com o tempo de espera" : ""}</span>
              </div>
              <Button variant="ghost" onClick={cancel} data-testid="cancel-queue">Cancelar</Button>
            </>
          ) : (
            <>
              {ranked ? (
                <div className="queue-info ranked-info" data-testid="ranked-info">
                  <span className="label">Partida ranqueada · {MODES[mode].label}{season ? ` · ${season.name}` : ""}</span>
                  {!season ? (
                    <span className="muted">Não há temporada ranqueada em andamento. A fila abre quando a próxima temporada começar.</span>
                  ) : cooldown > 0 ? (
                    <span className="muted" data-testid="ranked-cooldown">Fila ranqueada bloqueada por abandono. Libera em {String(Math.floor(cooldown / 60)).padStart(2, "0")}:{String(cooldown % 60).padStart(2, "0")}.</span>
                  ) : modeStatus && rankDef ? (
                    <div className="ranked-line">
                      <RankEmblem order={rankDef.order} size={40} />
                      <div>
                        <strong style={{ color: rankDef.color, fontSize: 20 }}>{rankDef.name}</strong>
                        <span className="muted"> · {modeStatus.points} PP · {modeStatus.wins}V {modeStatus.losses}D</span>
                      </div>
                    </div>
                  ) : (
                    <span className="muted" data-testid="placement-left">Classificação: faltam {modeStatus?.placementLeft ?? season.placementMatches} de {season.placementMatches} partidas para revelar sua patente em {mode}.</span>
                  )}
                  <span className="muted">Vitória e derrota valem pontos de patente. Abandonar conta como derrota, custa pontos extras e bloqueia a fila.</span>
                </div>
              ) : (
                <div className="queue-info">
                  <span className="label">Partida casual · rotação de 5 mapas</span>
                  <span className="muted">Só jogadores reais: a partida começa quando a fila completa. O mapa segue a rotação: Neon District, Desert Protocol, Frost Base, Blackout Lab e Orbital Zero. Não altera pontos de patente.</span>
                </div>
              )}
              <Button onClick={search} disabled={status !== "online" || rankedBlocked} data-testid="find-match">{ranked ? "Procurar ranqueada" : "Procurar partida"}</Button>
            </>
          )}
        </div>
        {error && <div className="alert error">{error}</div>}
      </div>
    </div>
  );
}
