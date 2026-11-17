import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { MAP_REGISTRY, MODES, TICK_MS, type ReplayFile, type SpectatorInfo } from "@vanta/shared";
import { api, ApiError } from "../api/client";
import { SpectatorRuntime, type SpectatorEvent, type SpectatorHud } from "../game/SpectatorRuntime";
import { TEAM_COLORS } from "../game/OnlineRuntime";
import { loadSettings } from "./SettingsPanel";
import { Button } from "../components/ui";
import { mapName } from "./RoomsScreen";

interface Feed { id: number; e: Extract<SpectatorEvent, { type: "killfeed" }> }
type PB = NonNullable<ReturnType<SpectatorRuntime["playbackState"]>>;

const SPEEDS = [0.5, 1, 2, 4];

/** Baixa e descompacta o replay (gzip) com o DecompressionStream do navegador. */
async function loadReplay(matchId: string): Promise<ReplayFile> {
  let lastErr: unknown;
  // Logo depois da partida o servidor ainda pode estar gravando: tenta de novo algumas vezes.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const buf = await api.bytes(`/matches/${encodeURIComponent(matchId)}/replay`);
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
      return (await new Response(stream).json()) as ReplayFile;
    } catch (e) {
      lastErr = e;
      if (!(e instanceof ApiError && e.status === 404)) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Replay de uma partida: mesma visão do espectador, com play, pausa, velocidade, linha do tempo e câmera livre. */
export function ReplayScreen() {
  const { matchId = "" } = useParams();
  const navigate = useNavigate();
  const host = useRef<HTMLDivElement>(null);
  const rt = useRef<SpectatorRuntime | null>(null);
  const [file, setFile] = useState<ReplayFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState<SpectatorHud | null>(null);
  const [pb, setPb] = useState<PB | null>(null);
  const [marks, setMarks] = useState<Array<{ round: number; tick: number }>>([]);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [sizeKb, setSizeKb] = useState(0);

  useEffect(() => {
    loadReplay(matchId).then((f) => {
      setSizeKb(Math.round(JSON.stringify(f).length / 1024));
      setFile(f);
    }).catch((e: Error) => setError(e.message));
  }, [matchId]);

  useEffect(() => {
    if (!file || !host.current) return;
    const s = loadSettings();
    const info: SpectatorInfo = { matchId: file.matchId, mode: file.mode, map: file.map, roundsToWin: file.roundsToWin, players: file.players, delayMs: 0, rules: file.rules };
    const runtime = new SpectatorRuntime(host.current, MAP_REGISTRY[file.map]!, info, { sensitivity: s.sensitivity, fov: s.fov, maxFps: s.maxFps, volume: s.masterVolume, quality: s.quality }, setHud, (e) => {
      if (e.type !== "killfeed") return;
      const id = performance.now() + Math.random();
      setFeed((f) => [...f.slice(-5), { id, e }]);
      setTimeout(() => setFeed((f) => f.filter((x) => x.id !== id)), 4000);
    });
    runtime.loadReplay(file.frames);
    rt.current = runtime;
    setMarks(runtime.roundMarks());
    if (import.meta.env.DEV) (window as unknown as { __vantaReplay: SpectatorRuntime }).__vantaReplay = runtime;
    const t = window.setInterval(() => setPb(runtime.playbackState()), 100);
    return () => {
      clearInterval(t);
      runtime.dispose();
      rt.current = null;
    };
  }, [file]);

  const targetName = hud?.players.find((p) => p.id === hud.target)?.username;
  const span = pb ? Math.max(1, pb.end - pb.start) : 1;
  const ctl = (fn: (r: SpectatorRuntime) => void) => {
    if (rt.current) fn(rt.current);
    setPb(rt.current?.playbackState() ?? null);
  };

  return (
    <div className="screen training match spectate-screen replay-screen" data-testid="replay-screen">
      <div ref={host} className="game-host" />
      {error && (
        <div className="overlay-center"><div className="panel cut spec-wait"><p className="error" data-testid="replay-error">{error}</p><Button onClick={() => navigate(-1)}>Voltar</Button></div></div>
      )}
      {!file && !error && <div className="spec-wait panel cut">Baixando o replay…</div>}
      {file && (
        <>
          <div className="match-top" data-testid="replay-score">
            <strong style={{ color: TEAM_COLORS[0] }}>{hud?.score[0] ?? 0}</strong>
            <div className="match-clock">
              <span className="label">Round {hud?.round ?? 0}</span>
              <b>{hud ? fmt(hud.phaseEndsIn) : "--:--"}</b>
              <span className="muted">{MODES[file.mode].label} · {mapName(file.map)} · primeiro a {file.roundsToWin}</span>
            </div>
            <strong style={{ color: TEAM_COLORS[1] }}>{hud?.score[1] ?? 0}</strong>
          </div>
          <div className="spec-badge">REPLAY · {new Date(file.endedAt).toLocaleString("pt-BR")} · {sizeKb} KB</div>

          <div className="hud-feed">
            {feed.map(({ id, e }) => (
              <div key={id} className="feed-row">
                <span style={{ color: TEAM_COLORS[e.killerTeam] }}>{e.killer}</span>
                <span className="muted"> [{e.weapon}{e.headshot ? " · HS" : ""}] </span>
                <span style={{ color: TEAM_COLORS[e.victimTeam] }}>{e.victim}</span>
              </div>
            ))}
          </div>

          <aside className="spec-players panel cut" data-testid="replay-players">
            {([0, 1] as const).map((team) => (
              <div key={team}>
                <span className="label" style={{ color: TEAM_COLORS[team] }}>{team === 0 ? "Time A" : "Time B"}</span>
                {hud?.players.filter((p) => p.team === team).map((p) => (
                  <button key={p.id} className={`spec-player ${hud.target === p.id ? "on" : ""} ${p.alive ? "" : "dead"}`} onClick={() => rt.current?.follow(p.id)} data-testid={`replay-follow-${p.username}`}>
                    <span className="spec-name">{p.username}</span>
                    <span className="spec-kda muted small">{p.kills}/{p.deaths}/{p.assists}</span>
                    <span className="spec-hp"><i style={{ width: `${p.alive ? p.hp : 0}%`, background: TEAM_COLORS[team] }} /></span>
                  </button>
                ))}
              </div>
            ))}
            <button className={`btn-mini ghost ${hud?.target === null ? "on" : ""}`} onClick={() => rt.current?.follow(null)} data-testid="replay-free">Câmera livre</button>
          </aside>

          <div className="replay-bar panel cut" data-testid="replay-bar">
            <button className="btn-mini replay-play" onClick={() => ctl((r) => r.setPlaying(!pb?.playing))} data-testid="replay-play" aria-label={pb?.playing ? "Pausar" : "Reproduzir"}>{pb?.playing ? "❚❚" : "▶"}</button>
            <span className="small replay-time" data-testid="replay-time">{pb ? `${fmt((pb.tick - pb.start) * TICK_MS)} / ${fmt(span * TICK_MS)}` : "0:00"}</span>
            <div className="replay-track">
              <input type="range" min={pb?.start ?? 0} max={pb?.end ?? 1} step={1} value={pb?.tick ?? 0} onChange={(e) => ctl((r) => r.seek(Number(e.target.value)))} aria-label="Linha do tempo" data-testid="replay-seek" />
              {pb && marks.map((m) => (
                <button key={m.round} className="replay-mark" style={{ left: `${((m.tick - pb.start) / span) * 100}%` }} title={`Round ${m.round}`} onClick={() => ctl((r) => r.seek(m.tick))} data-testid={`replay-round-${m.round}`}>{m.round}</button>
              ))}
            </div>
            <div className="replay-speeds">
              {SPEEDS.map((v) => <button key={v} className={`btn-mini ${pb?.speed === v ? "" : "ghost"}`} onClick={() => ctl((r) => r.setSpeed(v))} data-testid={`replay-speed-${v}`}>{v}×</button>)}
            </div>
          </div>

          <div className="spec-help muted small replay-help">
            {targetName ? <>Seguindo <b>{targetName}</b> · Q/E troca · F câmera livre</> : <>Câmera livre · WASD move · arraste o mouse · espaço/ctrl sobe e desce · F volta a seguir</>}
          </div>
          <div className="spec-exit"><Button variant="ghost" onClick={() => navigate(-1)} data-testid="replay-exit">Sair do replay</Button></div>
        </>
      )}
    </div>
  );
}
