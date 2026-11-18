import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { MAP_REGISTRY, MODES, type SpectatorInfo } from "@vanta/shared";
import { gameSocket } from "../net/GameSocket";
import { SpectatorRuntime, type SpectatorEvent, type SpectatorHud } from "../game/SpectatorRuntime";
import { TEAM_COLORS } from "../game/OnlineRuntime";
import { loadSettings } from "./SettingsPanel";
import { Button } from "../components/ui";
import { mapName } from "./RoomsScreen";

interface Feed { id: number; e: Extract<SpectatorEvent, { type: "killfeed" }> }

/** Assistir a partida de uma sala: tudo chega do servidor com atraso; o espectador não interfere no jogo. */
export function SpectateScreen() {
  const navigate = useNavigate();
  const host = useRef<HTMLDivElement>(null);
  const rt = useRef<SpectatorRuntime | null>(null);
  const [info, setInfo] = useState<SpectatorInfo | null>(gameSocket.spectate);
  const [hud, setHud] = useState<SpectatorHud | null>(null);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [result, setResult] = useState<Extract<SpectatorEvent, { type: "match_end" }> | null>(null);

  useEffect(() => {
    gameSocket.connect();
    const off = gameSocket.on((m) => {
      if (m.t === "spec_start") {
        setResult(null);
        setInfo(m.info);
      } else if (m.t === "spec_end") navigate("/sala", { replace: true });
      else if (m.t === "room" && !m.room) navigate("/salas", { replace: true });
      else if (m.t === "match") navigate("/partida", { replace: true });
      rt.current?.handleMessage(m);
    });
    // O início pode ter chegado entre a renderização e a inscrição acima.
    if (gameSocket.spectate) setInfo((prev) => prev ?? gameSocket.spectate);
    const t = window.setTimeout(() => {
      if (!gameSocket.spectate && gameSocket.status === "online") navigate(gameSocket.room ? "/sala" : "/salas", { replace: true });
    }, 3000);
    return () => {
      off();
      clearTimeout(t);
    };
  }, [navigate]);

  useEffect(() => {
    if (!info || !host.current) return;
    const s = loadSettings();
    const runtime = new SpectatorRuntime(host.current, MAP_REGISTRY[info.map]!, info, { sensitivity: s.sensitivity, fov: s.fov, maxFps: s.maxFps, volume: s.masterVolume, quality: s.quality }, setHud, (e) => {
      if (e.type === "killfeed") {
        const id = performance.now() + Math.random();
        setFeed((f) => [...f.slice(-5), { id, e }]);
        setTimeout(() => setFeed((f) => f.filter((x) => x.id !== id)), 5000);
      } else if (e.type === "match_end") setResult(e);
    });
    rt.current = runtime;
    if (import.meta.env.DEV) (window as unknown as { __vantaSpec: SpectatorRuntime }).__vantaSpec = runtime;
    return () => {
      runtime.dispose();
      rt.current = null;
    };
  }, [info]);

  const exit = () => {
    gameSocket.send({ t: "leave_match" });
    navigate("/sala", { replace: true });
  };

  const fmt = (ms: number) => {
    const s = Math.ceil(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const targetName = hud?.players.find((p) => p.id === hud.target)?.username;

  return (
    <div className="screen training match spectate-screen" data-testid="spectate-screen">
      <div ref={host} className="game-host" />
      {info && (
        <>
          <div className="match-top" data-testid="spec-score">
            <strong style={{ color: TEAM_COLORS[0] }}>{hud?.score[0] ?? 0}</strong>
            <div className="match-clock">
              <span className="label">Round {hud?.round ?? 0}</span>
              <b>{hud && hud.phase !== "ended" ? fmt(hud.phaseEndsIn) : "--:--"}</b>
              <span className="muted">{MODES[info.mode].label} · {mapName(info.map)} · primeiro a {info.roundsToWin}</span>
            </div>
            <strong style={{ color: TEAM_COLORS[1] }}>{hud?.score[1] ?? 0}</strong>
          </div>
          <div className="spec-badge" data-testid="spec-delay">ESPECTADOR · atraso de {Math.round(info.delayMs / 1000)} s</div>
          {!hud?.started && <div className="spec-wait panel cut">Sincronizando… a transmissão chega com {Math.round(info.delayMs / 1000)} s de atraso.</div>}

          <div className="hud-feed">
            {feed.map(({ id, e }) => (
              <div key={id} className="feed-row">
                <span style={{ color: TEAM_COLORS[e.killerTeam] }}>{e.killer}</span>
                <span className="muted"> [{e.weapon}{e.headshot ? " · HS" : ""}] </span>
                <span style={{ color: TEAM_COLORS[e.victimTeam] }}>{e.victim}</span>
              </div>
            ))}
          </div>

          <aside className="spec-players panel cut" data-testid="spec-players">
            {([0, 1] as const).map((team) => (
              <div key={team}>
                <span className="label" style={{ color: TEAM_COLORS[team] }}>{team === 0 ? "Time A" : "Time B"}</span>
                {hud?.players.filter((p) => p.team === team).map((p) => (
                  <button key={p.id} className={`spec-player ${hud.target === p.id ? "on" : ""} ${p.alive ? "" : "dead"}`} onClick={() => rt.current?.follow(p.id)} data-testid={`spec-follow-${p.username}`}>
                    <span className="spec-name">{p.username}{!p.connected && " (caiu)"}</span>
                    <span className="spec-kda muted small">{p.kills}/{p.deaths}/{p.assists}</span>
                    <span className="spec-hp"><i style={{ width: `${p.alive ? p.hp : 0}%`, background: TEAM_COLORS[team] }} /></span>
                  </button>
                ))}
              </div>
            ))}
            <button className={`btn-mini ghost ${hud?.target === null ? "on" : ""}`} onClick={() => rt.current?.follow(null)} data-testid="spec-free">Câmera livre</button>
          </aside>

          <div className="spec-help muted small">
            {targetName ? <>Seguindo <b>{targetName}</b> · Q/E troca · F câmera livre</> : <>Câmera livre · WASD move · arraste o mouse · espaço/ctrl sobe e desce · F volta a seguir</>}
          </div>
          <div className="spec-exit"><Button variant="ghost" onClick={exit} data-testid="spec-exit">Voltar à sala</Button></div>

          {result && (
            <div className="overlay-center">
              <div className="scoreboard panel cut" data-testid="spec-result">
                <span className="label">Fim de partida</span>
                <h1>{result.winner === null ? "Empate" : result.winner === 0 ? "Time A venceu" : "Time B venceu"}</h1>
                <p className="muted">{result.score[0]} × {result.score[1]}</p>
                <table className="sb-table">
                  <thead><tr><th>Jogador</th><th>K</th><th>D</th><th>A</th><th>HS</th><th>Dano</th></tr></thead>
                  <tbody>
                    {result.stats.map((s) => (
                      <tr key={s.id}><td style={{ color: TEAM_COLORS[s.team] }}>{s.username}{s.mvp ? " · MVP" : ""}</td><td>{s.kills}</td><td>{s.deaths}</td><td>{s.assists}</td><td>{s.headshots}</td><td>{s.damage}</td></tr>
                    ))}
                  </tbody>
                </table>
                <div className="row-end"><Button onClick={exit} data-testid="spec-back">Voltar à sala</Button></div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
