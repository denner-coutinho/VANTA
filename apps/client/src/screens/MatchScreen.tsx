import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MEDALS, MAP_REGISTRY, MODES, RANKS, type MatchProgressWire, weaponStatsFromRow, type MatchInfo, type PlayerMatchStats, type RankedResultWire, type WeaponStats } from "@vanta/shared";
import { api } from "../api/client";
import { gameSocket, type SocketStatus } from "../net/GameSocket";
import { OnlineRuntime, TEAM_COLORS, type OnlineEvent, type OnlineHud } from "../game/OnlineRuntime";
import type { GameSettings } from "../game/GameRuntime";
import { loadSettings, saveSettings, type LocalSettings } from "./SettingsPanel";
import { matchesBind } from "../game/input";
import { Button } from "../components/ui";
import { RankEmblem } from "../components/RankEmblem";
import { useAuth } from "../auth/AuthContext";
import { uiSound } from "../audio/ui-sound";
import { MatchChat } from "../social/MatchChat";
import { ReportDialog } from "../social/ReportDialog";
import { useSocial } from "../social/SocialContext";
import { MvpStage } from "../three/MvpStage";

const CATEGORY_LABEL: Record<WeaponStats["category"], string> = { ASSAULT_RIFLE: "Rifle de assalto", SMG: "Submetralhadora", SNIPER: "Sniper", SHOTGUN: "Escopeta", PISTOL: "Pistola" };
const toGame = (s: LocalSettings): GameSettings => ({ sensitivity: s.sensitivity, fov: s.fov, maxFps: s.maxFps, volume: s.masterVolume, quality: s.quality });

interface Feed { id: number; e: Extract<OnlineEvent, { type: "killfeed" }> }
interface Banner { id: number; title: string; sub: string; tone: "win" | "loss" | "neutral" }

export function MatchScreen() {
  const navigate = useNavigate();
  const { reloadMe } = useAuth();
  const [rankedRes, setRankedRes] = useState<RankedResultWire | null>(gameSocket.rankedResult);
  const [progress, setProgress] = useState<MatchProgressWire | null>(gameSocket.progress);
  const host = useRef<HTMLDivElement>(null);
  const rt = useRef<OnlineRuntime | null>(null);
  const [info, setInfo] = useState<MatchInfo | null>(gameSocket.match);
  const [weapons, setWeapons] = useState<Map<string, WeaponStats> | null>(null);
  const [hud, setHud] = useState<OnlineHud | null>(null);
  const [locked, setLocked] = useState(false);
  const [settings, setSettings] = useState<LocalSettings>(loadSettings);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [hitmarkers, setHitmarkers] = useState<Array<{ id: number; head: boolean; kill: boolean }>>([]);
  const [indicators, setIndicators] = useState<Array<{ id: number; angle: number }>>([]);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [deathBy, setDeathBy] = useState<string | null>(null);
  const [scoreboard, setScoreboard] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [result, setResult] = useState<Extract<OnlineEvent, { type: "match_end" }> | null>(null);
  const [status, setStatus] = useState<SocketStatus>(gameSocket.status);
  const [error, setError] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [reporting, setReporting] = useState<{ id: string; username: string } | null>(null);
  const social = useSocial();

  useEffect(() => {
    api.get<Array<Record<string, unknown>>>("/content/weapons").then((rows) => setWeapons(new Map(rows.map((r) => { const w = weaponStatsFromRow(r); return [w.code, w]; })))).catch((e: Error) => setError(e.message));
  }, []);

  // Conexão: recebe a partida (também ao reconectar) e repassa snapshots ao runtime.
  useEffect(() => {
    gameSocket.connect();
    const offS = gameSocket.onStatus((s) => {
      setStatus(s);
      rt.current?.setConnected(s === "online");
    });
    const off = gameSocket.on((m) => {
      if (m.t === "match") {
        setInfo((prev) => {
          if (prev && prev.matchId === m.info.matchId) rt.current?.resync(m.info);
          return m.info;
        });
      } else if (m.t === "welcome" && !m.inMatch && !rt.current) {
        navigate("/jogar", { replace: true });
      } else if (m.t === "left_match") {
        // Partida de sala: quem sai volta para o lobby da sala (continua nela).
        navigate(gameSocket.room ? "/sala" : "/menu", { replace: true });
      } else if (m.t === "progress") {
        setProgress(m);
        void reloadMe().catch(() => undefined);
      } else if (m.t === "ranked_result") {
        setRankedRes(m);
        void reloadMe().catch(() => undefined);
      } else if (m.t === "pong") {
        if (rt.current) rt.current.rtt = gameSocket.rtt;
      }
      rt.current?.handleMessage(m);
    });
    // Sem partida conhecida: espera o servidor dizer (reconexão) ou volta.
    const t = setTimeout(() => {
      if (!gameSocket.match && gameSocket.status === "online" && !gameSocket.inMatch) navigate("/jogar", { replace: true });
    }, 4000);
    return () => {
      off();
      offS();
      clearTimeout(t);
    };
  }, [navigate, reloadMe]);

  const pushBanner = (b: Omit<Banner, "id">, ms = 3200) => {
    const id = Date.now();
    setBanner({ ...b, id });
    setTimeout(() => setBanner((cur) => (cur?.id === id ? null : cur)), ms);
  };

  const onEvent = useCallback((e: OnlineEvent) => {
    const id = performance.now() + Math.random();
    const myTeam = gameSocket.match?.yourTeam ?? 0;
    switch (e.type) {
      case "hit":
        setHitmarkers((h) => [...h.slice(-4), { id, head: e.headshot, kill: e.kill }]);
        setTimeout(() => setHitmarkers((h) => h.filter((x) => x.id !== id)), e.kill ? 600 : 260);
        break;
      case "damaged":
        setIndicators((d) => [...d.slice(-5), { id, angle: e.angle }]);
        setTimeout(() => setIndicators((d) => d.filter((x) => x.id !== id)), 1200);
        break;
      case "died":
        setDeathBy(e.by);
        break;
      case "killfeed":
        setFeed((f) => [...f.slice(-5), { id, e }]);
        setTimeout(() => setFeed((f) => f.filter((x) => x.id !== id)), 5000);
        break;
      case "round_start":
        setDeathBy(null);
        pushBanner({ title: `Round ${e.round}`, sub: "Prepare-se", tone: "neutral" }, 2500);
        break;
      case "round_end": {
        const won = e.winner === myTeam;
        const reason = e.reason === "time" ? "tempo esgotado" : "eliminação";
        pushBanner({ title: e.winner === null ? "Round empatado" : won ? "Round vencido" : "Round perdido", sub: `${e.score[myTeam]} × ${e.score[myTeam === 0 ? 1 : 0]} · ${reason}`, tone: e.winner === null ? "neutral" : won ? "win" : "loss" });
        if (won) uiSound.success();
        break;
      }
      case "match_end":
        setResult(e);
        document.exitPointerLock?.();
        break;
      case "player":
        setToast(`${e.username} ${e.abandoned ? "abandonou a partida" : e.connected ? "reconectou" : "desconectou (60 s para voltar)"}`);
        setTimeout(() => setToast(null), 4000);
        break;
      case "pause":
        setLocked(false);
        break;
      case "resume":
        setLocked(true);
        break;
    }
  }, []);

  useEffect(() => {
    if (!info || !weapons || !host.current || rt.current) return;
    const map = MAP_REGISTRY[info.map];
    if (!map) {
      setError(`Mapa ${info.map} indisponível neste cliente.`);
      return;
    }
    let r: OnlineRuntime;
    try {
      r = new OnlineRuntime(host.current, map, weapons, info, toGame(settings), (c) => gameSocket.send({ t: "cmd", c }), setHud, onEvent);
    } catch (e) {
      setError(`Não foi possível iniciar o 3D (WebGL): ${(e as Error).message}`);
      return;
    }
    rt.current = r;
    gameSocket.send({ t: "ready" });
    if (import.meta.env.DEV) (window as unknown as { __vantaMatch: OnlineRuntime }).__vantaMatch = r;
    return () => {
      r.dispose();
      rt.current = null;
    };
  }, [info?.matchId, weapons]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => rt.current?.setSettings(toGame(settings)), [settings]);

  // Placar na tecla configurada (Tab por padrão).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (matchesBind("scoreboard", e.code)) {
        e.preventDefault();
        setScoreboard(true);
      }
    };
    const up = (e: KeyboardEvent) => matchesBind("scoreboard", e.code) && setScoreboard(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const updateSettings = (patch: Partial<LocalSettings>) => {
    const next = { ...settings, ...patch };
    saveSettings(next);
    setSettings(next);
  };

  const leave = () => {
    gameSocket.send({ t: "leave_match" });
    gameSocket.match = null;
    gameSocket.inMatch = false;
    navigate(gameSocket.room ? "/sala" : "/menu", { replace: true });
  };

  // Espaço pula a kill cam.
  const killcamOn = !!hud?.killcam;
  useEffect(() => {
    if (!killcamOn) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" || matchesBind("jump", e.code)) rt.current?.skipKillcam();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [killcamOn]);

  const exit = (to: string) => {
    gameSocket.match = null;
    navigate(to, { replace: true });
  };

  if (error) {
    return (
      <div className="screen training-error">
        <div className="panel cut" style={{ padding: 28, maxWidth: 480 }}>
          <h2>Partida indisponível</h2>
          <p className="muted">{error}</p>
          <Button onClick={() => navigate("/menu")}>Voltar ao menu</Button>
        </div>
      </div>
    );
  }

  if (!info) {
    return (
      <div className="screen training-error">
        <div className="panel cut" style={{ padding: 28 }}>
          <span className="label">Conectando à partida…</span>
        </div>
      </div>
    );
  }

  const myTeam = info.yourTeam;
  const enemyTeam: 0 | 1 = myTeam === 0 ? 1 : 0;
  const w = hud?.weapon;
  const gap = Math.max(4, Math.min(80, hud?.spreadPx ?? 8));
  const secs = Math.ceil((hud?.phaseEndsIn ?? 0) / 1000);
  const teamRow = (team: 0 | 1) => (hud?.players ?? []).filter((p) => p.team === team);

  return (
    <div className="screen training match">
      <div ref={host} className="game-host" />

      {hud && (
        <div className="hud">
          {/* Placar superior */}
          <div className="match-top" data-testid="match-score">
            <div className="team-pips">{teamRow(myTeam).map((p) => <i key={p.id} className={p.alive ? "" : "dead"} style={{ background: TEAM_COLORS[myTeam] }} />)}</div>
            <strong style={{ color: TEAM_COLORS[myTeam] }}>{hud.score[myTeam]}</strong>
            <div className="match-clock">
              <span className="label">{hud.phase === "warmup" ? "Aguardando jogadores" : hud.phase === "freeze" ? "Prepare-se" : hud.phase === "round_end" ? "Fim do round" : hud.phase === "ended" ? "Fim" : `Round ${hud.round}`}</span>
              <b>{hud.phase === "ended" ? "--" : `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`}</b>
              <span className="muted">primeiro a {hud.roundsToWin}{info.rules?.headshotsOnly ? " · só headshot" : ""}{info.rules?.friendlyFire ? " · fogo amigo" : ""}</span>
            </div>
            <strong style={{ color: TEAM_COLORS[enemyTeam] }}>{hud.score[enemyTeam]}</strong>
            <div className="team-pips">{teamRow(enemyTeam).map((p) => <i key={p.id} className={p.alive ? "" : "dead"} style={{ background: TEAM_COLORS[enemyTeam] }} />)}</div>
          </div>

          {!hud.scoped && hud.alive && (
            <div className={`crosshair ${hud.aiming ? "ads" : ""}`} style={{ ["--gap" as string]: `${gap}px` }}><i /><i /><i /><i /><b /></div>
          )}
          {hud.scoped && <div className="scope"><div className="scope-lines" /></div>}
          {hitmarkers.map((h) => <div key={h.id} className={`hitmarker ${h.head ? "head" : ""} ${h.kill ? "kill" : ""}`} />)}
          {indicators.map((d) => <div key={d.id} className="dmg-ind" style={{ transform: `translate(-50%, -50%) rotate(${d.angle}rad)` }}><span /></div>)}
          {hud.health < 35 && hud.alive && <div className="low-hp" />}

          {hud.spectators > 0 && <div className="spec-watching" data-testid="spectators-count">{hud.spectators} assistindo · com atraso</div>}
          <div className="hud-feed" data-testid="killfeed">
            {feed.map(({ id, e }) => (
              <div key={id} className={`feed-row ${e.involvesYou ? "me" : ""}`}>
                <span style={{ color: TEAM_COLORS[e.killerTeam] }}>{e.killer}</span>
                <span className="muted"> [{e.weapon}] </span>
                <span style={{ color: TEAM_COLORS[e.victimTeam] }}>{e.victim}</span>
                {e.headshot && <span className="hs">HS</span>}
              </div>
            ))}
          </div>

          <div className="hud-health panel cut cut-sm">
            <span className="label">Vida</span>
            <strong data-testid="hud-health" style={{ color: hud.health < 35 ? "var(--c-red)" : undefined }}>{hud.health}</strong>
            <div className="hp-bar"><div style={{ width: `${hud.health}%` }} /></div>
          </div>

          {w && (
            <div className="hud-weapon panel cut cut-sm">
              <div className="slots">{hud.slots.map((s, i) => <span key={s.code} className={s.active ? "on" : ""}>{i + 1} · {s.name}</span>)}</div>
              <div className="ammo">
                <strong data-testid="hud-ammo" className={w.ammo <= Math.ceil(w.magazine * 0.25) ? "low" : ""}>{w.ammo}</strong>
                <span>/ {w.reserve}</span>
              </div>
              <div className="label">{w.name} · {CATEGORY_LABEL[w.category]}</div>
              {w.reloadP !== null && <div className="reload"><div style={{ width: `${Math.min(100, w.reloadP * 100)}%` }} /><span className="label">Recarregando</span></div>}
            </div>
          )}

          <div className="net-info muted">{hud.fps} FPS · {hud.rtt} ms{!hud.connected && <b style={{ color: "var(--c-red)" }}> · reconectando…</b>}</div>
          {toast && <div className="match-toast panel cut cut-sm">{toast}</div>}
          {banner && (
            <div key={banner.id} className={`round-banner ${banner.tone}`} data-testid="round-banner">
              <h2>{banner.title}</h2>
              <span>{banner.sub}</span>
            </div>
          )}
          {hud.killcam && !result && (
            <div className="killcam" data-testid="killcam">
              <div className="killcam-frame" />
              <div className="killcam-label">
                <span className="label" style={{ color: "#FF8A96" }}>Kill cam</span>
                <div><strong>{hud.killcam.killer}</strong> <span className="muted">· {hud.killcam.weapon}{hud.killcam.head ? " · headshot" : ""}</span></div>
                <div className="killcam-bar"><i style={{ width: `${Math.round(hud.killcam.progress * 100)}%` }} /></div>
              </div>
              <div className="killcam-skip muted small">Espaço para pular</div>
            </div>
          )}
          {!hud.alive && !result && !hud.killcam && hud.phase !== "round_end" && (
            <div className="death">
              <div className="label" style={{ color: "var(--c-red)" }}>Eliminado{deathBy ? ` por ${deathBy}` : ""}</div>
              <span className="muted">Aguarde o próximo round</span>
            </div>
          )}

          {(scoreboard || result) && (
            <div className="scoreboard panel cut" data-testid="scoreboard">
              {result && (
                <div className={`result-head ${result.winner === myTeam ? "win" : result.winner === null ? "" : "loss"}`}>
                  <span className="label">{info.ranked ? "Ranqueada · " : ""}{MODES[info.mode].label} · {MAP_REGISTRY[info.map]?.name ?? info.map}{result.reason === "forfeit" ? " · W.O." : ""}</span>
                  <h1 data-testid="match-result">{result.winner === null ? "Empate" : result.winner === myTeam ? "Vitória" : "Derrota"}</h1>
                  <strong>{result.score[myTeam]} × {result.score[enemyTeam]}</strong>
                </div>
              )}
              {result && info.ranked && (
                rankedRes && rankedRes.matchId === info.matchId ? (
                  <RankedResultCard r={rankedRes} />
                ) : (
                  <div className="ranked-result pending" data-testid="ranked-pending"><span className="muted">Gravando o resultado ranqueado no servidor…</span></div>
                )
              )}
              {([myTeam, enemyTeam] as const).map((team) => (
                <table key={team} className="sb-table">
                  <thead>
                    <tr><th style={{ color: TEAM_COLORS[team] }}>{team === myTeam ? "Sua equipe" : "Adversários"}</th><th>K</th><th>D</th><th>A</th>{result && <><th>HS</th><th>Dano</th><th>Precisão</th></>}</tr>
                  </thead>
                  <tbody>
                    {(result ? result.stats.filter((s) => s.team === team) : teamRow(team)).map((p) => {
                      const s = p as Partial<PlayerMatchStats> & { id: string; username: string; kills: number; deaths: number; assists: number };
                      const row = hud.players.find((x) => x.id === s.id);
                      return (
                        <tr key={s.id} className={s.id === info.you ? "me" : ""}>
                          <td>
                            {s.username}{s.mvp && <span className="mvp">MVP</span>}{(s.abandoned || row?.connected === false) && <span className="muted"> · {s.abandoned ? "abandonou" : "desconectado"}</span>}
                            {result && s.id !== info.you && (
                              <span className="sb-actions">
                                {!social.overview?.friends.some((f) => f.id === s.id) && !social.overview?.outgoing.some((r) => r.user.id === s.id) && (
                                  <button className="btn-mini" onClick={() => void social.addFriend(s.username)} data-testid={`sb-add-${s.username}`}>Adicionar</button>
                                )}
                                <button className="btn-mini ghost" onClick={() => setReporting({ id: s.id, username: s.username })} data-testid={`sb-report-${s.username}`}>Denunciar</button>
                              </span>
                            )}
                          </td>
                          <td>{s.kills}</td><td>{s.deaths}</td><td>{s.assists}</td>
                          {result && <><td>{s.headshots}</td><td>{s.damage}</td><td>{s.shots ? Math.round(((s.hits ?? 0) / s.shots) * 100) : 0}%</td></>}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              ))}
              {result && <MvpShowcase stats={result.stats} info={info} />}
              {result && !info.rules && (
                progress && progress.matchId === info.matchId ? <ProgressCard p={progress} /> : <div className="progress-card pending muted small" data-testid="progress-pending">Calculando XP e medalhas…</div>
              )}
              {result && (
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                  {info.rules ? (
                    <>
                      <Button variant="ghost" onClick={() => exit(`/replay/${info.matchId}`)} data-testid="watch-replay">Ver replay</Button>
                      <Button onClick={() => exit("/sala")} data-testid="back-to-room">Voltar à sala</Button>
                    </>
                  ) : (
                    <>
                      <Button variant="ghost" onClick={() => exit(`/replay/${info.matchId}`)} data-testid="watch-replay">Ver replay</Button>
                      <Button variant="ghost" onClick={() => exit("/menu")}>Menu</Button>
                      <Button onClick={() => exit("/jogar")} data-testid="play-again">Jogar de novo</Button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {hud && (
        <MatchChat
          teamChat={info.mode !== "1v1"}
          myTeamIds={new Set(info.players.filter((p) => p.team === myTeam).map((p) => p.id))}
          onTyping={setTyping}
          resume={() => !result && rt.current?.start()}
          disabled={!!result}
        />
      )}

      {reporting && <ReportDialog user={reporting} matchId={info.matchId} onClose={() => setReporting(null)} />}

      {!locked && !result && !typing && (
        <div className="overlay-center">
          <div className="pause panel cut stagger" data-testid="match-menu">
            <div className="label">{MODES[info.mode].label} · a partida continua</div>
            <h1>Partida</h1>
            <Button block onClick={() => { uiSound.click(); rt.current?.start(); }} data-testid="enter-match">{hud?.phase === "warmup" ? "Entrar" : "Voltar ao jogo"}</Button>
            <div className="pause-settings">
              <label><span className="label">Sensibilidade: {settings.sensitivity.toFixed(2)}</span>
                <input className="range" type="range" min={0.1} max={4} step={0.05} value={settings.sensitivity} onChange={(e) => updateSettings({ sensitivity: Number(e.target.value) })} /></label>
              <label><span className="label">Campo de visão: {settings.fov}°</span>
                <input className="range" type="range" min={70} max={110} step={1} value={settings.fov} onChange={(e) => updateSettings({ fov: Number(e.target.value) })} /></label>
              <label><span className="label">Volume: {Math.round(settings.masterVolume * 100)}%</span>
                <input className="range" type="range" min={0} max={1} step={0.05} value={settings.masterVolume} onChange={(e) => updateSettings({ masterVolume: Number(e.target.value) })} /></label>
            </div>
            {status !== "online" && <div className="alert error">Conexão perdida. Tentando reconectar…</div>}
            {confirmLeave ? (
              <div className="alert error">
                Sair agora conta como abandono e sua equipe joga com um a menos.
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <Button variant="ghost" onClick={() => setConfirmLeave(false)}>Ficar</Button>
                  <Button onClick={leave} data-testid="confirm-leave">Abandonar</Button>
                </div>
              </div>
            ) : (
              <Button block variant="ghost" onClick={() => setConfirmLeave(true)}>Abandonar partida</Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Ganho ou perda de pontos de patente, exatamente como o servidor gravou. */
function RankedResultCard({ r }: { r: RankedResultWire }) {
  const rank = r.rankAfter ? RANKS[r.rankAfter - 1]! : null;
  const sign = r.delta > 0 ? "+" : "";
  return (
    <div className={`ranked-result ${r.delta > 0 ? "up" : r.delta < 0 ? "down" : ""}`} data-testid="ranked-result">
      {rank ? <RankEmblem order={rank.order} size={52} /> : <div className="placement-badge">?</div>}
      <div className="rr-main">
        {rank ? (
          <strong style={{ color: rank.color }}>{rank.name}</strong>
        ) : (
          <strong>Em classificação</strong>
        )}
        <span className="muted">
          {r.placed ? "Classificação concluída. " : ""}
          {r.promoted && !r.placed ? "Promoção de patente. " : ""}
          {r.demoted ? "Queda de patente. " : ""}
          {rank ? `${r.pointsAfter} PP` : `Faltam ${r.placementLeft} partidas para revelar sua patente`}
          {r.winStreak >= 3 ? ` · sequência de ${r.winStreak} vitórias` : ""}
        </span>
      </div>
      {rank && !r.placed && <b className="rr-delta" data-testid="ranked-delta">{sign}{r.delta} PP</b>}
    </div>
  );
}

/** XP, nível, medalhas, missões e conquistas da partida (calculados e gravados pelo servidor). */
/** Apresentação do MVP: operador animado com a skin da partida e os números que fizeram dele o MVP. */
function MvpShowcase({ stats, info }: { stats: PlayerMatchStats[]; info: MatchInfo }) {
  const mvp = stats.find((s) => s.mvp);
  if (!mvp) return null;
  const pl = info.players.find((p) => p.id === mvp.id);
  const acc = mvp.shots ? Math.round(((mvp.hits ?? 0) / mvp.shots) * 100) : 0;
  return (
    <div className="mvp-show" data-testid="mvp-show">
      {pl ? <MvpStage character={pl.character} skin={pl.cosmetics?.character ?? null} accent={TEAM_COLORS[mvp.team]} /> : <div />}
      <div>
        <span className="mvp-title">MVP DA PARTIDA</span>
        <div className="mvp-name" style={{ color: TEAM_COLORS[mvp.team] }} data-testid="mvp-name">{mvp.username}{mvp.id === info.you ? " (você)" : ""}</div>
        <div className="mvp-stats">
          <div><b>{mvp.kills}</b><span>abates</span></div>
          <div><b>{mvp.assists}</b><span>assistências</span></div>
          <div><b>{mvp.damage}</b><span>dano</span></div>
          <div><b>{mvp.headshots}</b><span>headshots</span></div>
          <div><b>{acc}%</b><span>precisão</span></div>
        </div>
      </div>
    </div>
  );
}

function ProgressCard({ p }: { p: MatchProgressWire }) {
  const up = p.levelAfter > p.levelBefore;
  return (
    <div className="progress-card" data-testid="progress-card">
      <div className="progress-xp">
        <strong data-testid="progress-xp">+{p.xp} XP</strong>
        {up ? <span className="pill level-up" data-testid="level-up">Subiu para o nível {p.levelAfter}!</span> : <span className="muted small">Nível {p.levelAfter}</span>}
        <div className="xp-bar"><i style={{ width: `${p.xpForNext ? Math.round((p.xpIntoLevel / p.xpForNext) * 100) : 100}%` }} /></div>
      </div>
      {p.medals.length > 0 && (
        <div className="medal-row" data-testid="progress-medals">
          {p.medals.map((m) => <span key={m} className="medal-chip" title={MEDALS[m].description}>{MEDALS[m].name}</span>)}
        </div>
      )}
      {p.missionsCompleted.map((m) => <div key={m} className="small">Missão concluída: <b>{m}</b> (resgate em Progresso)</div>)}
      {p.achievementsUnlocked.map((a) => <div key={a.name} className="small">Conquista: <b>{a.name}</b>{a.title ? ` · título “${a.title}”` : ""}</div>)}
    </div>
  );
}

