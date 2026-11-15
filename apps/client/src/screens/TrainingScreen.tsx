import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { NEON_DISTRICT, weaponStatsFromRow, type WeaponStats } from "@vanta/shared";
import { api } from "../api/client";
import { GameRuntime, type GameEvent, type GameSettings, type HudState } from "../game/GameRuntime";
import { loadSettings, saveSettings, type LocalSettings } from "./SettingsPanel";
import { Button } from "../components/ui";
import { uiSound } from "../audio/ui-sound";
import { useAuth } from "../auth/AuthContext";

const CATEGORY_LABEL: Record<WeaponStats["category"], string> = { ASSAULT_RIFLE: "Rifle de assalto", SMG: "Submetralhadora", SNIPER: "Sniper", SHOTGUN: "Escopeta", PISTOL: "Pistola" };
const DEFAULT_LOADOUT = ["VK7_LAMINA", "P9_FAISCA", "LR1_HORIZONTE"];
const LOADOUT_KEY = "vanta.trainingLoadout";

function toGameSettings(s: LocalSettings): GameSettings {
  return { sensitivity: s.sensitivity, fov: s.fov, maxFps: s.maxFps, volume: s.masterVolume, quality: s.quality };
}

interface Hitmarker { id: number; head: boolean; kill: boolean }
interface DamageIndicator { id: number; angle: number }
interface Feed { id: number; text: string; headshot: boolean }

export function TrainingScreen() {
  const { me } = useAuth();
  const navigate = useNavigate();
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<GameRuntime | null>(null);
  const [weapons, setWeapons] = useState<WeaponStats[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [phase, setPhase] = useState<"briefing" | "playing" | "paused" | "loadout">("briefing");
  const [settings, setSettings] = useState<LocalSettings>(loadSettings);
  const [loadout, setLoadout] = useState<string[]>(() => {
    try {
      const l = JSON.parse(localStorage.getItem(LOADOUT_KEY) ?? "null");
      return Array.isArray(l) && l.length === 3 ? l : DEFAULT_LOADOUT;
    } catch {
      return DEFAULT_LOADOUT;
    }
  });
  const [hitmarkers, setHitmarkers] = useState<Hitmarker[]>([]);
  const [indicators, setIndicators] = useState<DamageIndicator[]>([]);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [deathBy, setDeathBy] = useState<string | null>(null);
  const [damageFlash, setDamageFlash] = useState(0);

  // Armas vêm do banco (atributos autoritativos).
  useEffect(() => {
    api.get<Array<Record<string, unknown>>>("/content/weapons").then((rows) => setWeapons(rows.map(weaponStatsFromRow))).catch((e: Error) => setError(e.message));
  }, []);

  const onEvent = useCallback((e: GameEvent) => {
    const id = performance.now() + Math.random();
    switch (e.type) {
      case "hit":
        setHitmarkers((h) => [...h.slice(-4), { id, head: e.headshot, kill: e.kill }]);
        setTimeout(() => setHitmarkers((h) => h.filter((x) => x.id !== id)), e.kill ? 600 : 260);
        break;
      case "damaged":
        setIndicators((d) => [...d.slice(-5), { id, angle: e.angle }]);
        setDamageFlash((f) => f + 1);
        setTimeout(() => setIndicators((d) => d.filter((x) => x.id !== id)), 1200);
        break;
      case "died":
        setDeathBy(e.by);
        setTimeout(() => setDeathBy(null), 3000);
        break;
      case "killfeed":
        setFeed((f) => [...f.slice(-4), { id, text: e.text, headshot: e.headshot }]);
        setTimeout(() => setFeed((f) => f.filter((x) => x.id !== id)), 4500);
        break;
      case "pause":
        setPhase((p) => (p === "playing" ? "paused" : p));
        break;
      case "resume":
        setPhase("playing");
        break;
      case "interact":
        setPhase("loadout");
        break;
    }
  }, []);

  useEffect(() => {
    if (!weapons || !host.current) return;
    let rt: GameRuntime;
    try {
      rt = new GameRuntime(host.current, NEON_DISTRICT, weapons, loadout, toGameSettings(settings), setHud, onEvent, me?.cosmetics.weapons ?? {});
    } catch (e) {
      setError(`Não foi possível iniciar o 3D (WebGL): ${(e as Error).message}`);
      return;
    }
    runtime.current = rt;
    if (import.meta.env.DEV) (window as unknown as { __vantaTraining: GameRuntime }).__vantaTraining = rt;
    return () => {
      rt.dispose();
      runtime.current = null;
    };
    // Recria só quando as armas chegam ou a qualidade gráfica muda.
  }, [weapons, settings.quality]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => runtime.current?.setSettings(toGameSettings(settings)), [settings]);

  const play = () => {
    uiSound.click();
    runtime.current?.start();
  };

  const applyLoadout = (next: string[]) => {
    setLoadout(next);
    try { localStorage.setItem(LOADOUT_KEY, JSON.stringify(next)); } catch { /* sem armazenamento */ }
    runtime.current?.setLoadout(next);
  };

  const updateSettings = (patch: Partial<LocalSettings>) => {
    const next = { ...settings, ...patch };
    saveSettings(next);
    setSettings(next);
  };

  if (error) {
    return (
      <div className="screen training-error">
        <div className="panel cut" style={{ padding: 28, maxWidth: 480 }}>
          <h2>Treinamento indisponível</h2>
          <p className="muted">{error}</p>
          <Button onClick={() => navigate("/menu")}>Voltar ao menu</Button>
        </div>
      </div>
    );
  }

  const w = hud?.weapon;
  const gap = Math.max(4, Math.min(80, hud?.spreadPx ?? 8));

  return (
    <div className="screen training">
      <div ref={host} className="game-host" />

      {hud && phase === "playing" && (
        <div className="hud">
          {!hud.scoped && hud.alive && (
            <div className={`crosshair ${hud.aiming ? "ads" : ""}`} style={{ ["--gap" as string]: `${gap}px` }}>
              <i /><i /><i /><i /><b />
            </div>
          )}
          {hud.scoped && <div className="scope"><div className="scope-lines" /></div>}
          {hitmarkers.map((h) => <div key={h.id} className={`hitmarker ${h.head ? "head" : ""} ${h.kill ? "kill" : ""}`} />)}
          {indicators.map((d) => <div key={d.id} className="dmg-ind" style={{ transform: `translate(-50%, -50%) rotate(${d.angle}rad)` }}><span /></div>)}
          <div key={damageFlash} className={damageFlash ? "dmg-flash" : ""} />
          {hud.health < 35 && hud.alive && <div className="low-hp" />}

          <div className="hud-feed">
            {feed.map((f) => <div key={f.id} className="feed-row">{f.text}{f.headshot && <span className="hs">HS</span>}</div>)}
          </div>

          <div className="hud-health panel cut cut-sm">
            <span className="label">Vida</span>
            <strong data-testid="hud-health" style={{ color: hud.health < 35 ? "var(--c-red)" : undefined }}>{hud.health}</strong>
            <div className="hp-bar"><div style={{ width: `${hud.health}%` }} /></div>
          </div>

          {w && (
            <div className="hud-weapon panel cut cut-sm">
              <div className="slots">
                {hud.slots.map((s, i) => <span key={s.code} className={s.active ? "on" : ""}>{i + 1} · {s.name}</span>)}
              </div>
              <div className="ammo">
                <strong data-testid="hud-ammo" className={w.ammo <= Math.ceil(w.magazine * 0.25) ? "low" : ""}>{w.ammo}</strong>
                <span>/ {w.reserve}</span>
              </div>
              <div className="label">{w.name} · {CATEGORY_LABEL[w.category]}</div>
              {w.reloadP !== null && <div className="reload"><div style={{ width: `${Math.min(100, w.reloadP * 100)}%` }} /><span className="label">Recarregando</span></div>}
              {hud.noAmmoHint && <div className="label" style={{ color: "var(--c-red)" }}>Sem munição: troque de arma ou volte ao terminal</div>}
            </div>
          )}

          <div className="hud-stats panel cut cut-sm" data-testid="hud-stats">
            <span className="label">Treinamento · Neon District</span>
            <div><span>Precisão</span><strong>{hud.stats.shots ? Math.round((hud.stats.hits / hud.stats.shots) * 100) : 0}%</strong></div>
            <div><span>Disparos</span><strong>{hud.stats.shots}</strong></div>
            <div><span>Headshots</span><strong>{hud.stats.headshots}</strong></div>
            <div><span>Eliminações</span><strong data-testid="hud-kills">{hud.stats.kills}</strong></div>
            <div><span>TTK médio</span><strong>{hud.stats.avgTtkMs !== null ? `${hud.stats.avgTtkMs} ms` : "—"}</strong></div>
            <div><span>Mortes</span><strong>{hud.stats.deaths}</strong></div>
            <div className="muted" style={{ fontSize: 11 }}>{hud.fps} FPS · {hud.speed.toFixed(1)} m/s{hud.crouched ? " · agachado" : hud.sprinting ? " · correndo" : ""}</div>
          </div>

          {hud.interactHint && <div className="interact-hint"><kbd>E</kbd> {hud.interactHint.replace("Pressione E para ", "")}</div>}
          {!hud.alive && (
            <div className="death">
              <div className="label" style={{ color: "var(--c-red)" }}>Eliminado</div>
              <h2>{deathBy ?? "Eliminado"}</h2>
              <span className="muted">Reaparecendo em {hud.respawnIn.toFixed(1)} s</span>
            </div>
          )}
        </div>
      )}

      {phase === "briefing" && (
        <div className="overlay-center">
          <div className="briefing panel cut stagger">
            <div className="label" style={{ color: "var(--c-blue-hi)" }}>Modo treinamento · Neon District</div>
            <h1>Campo de tiro</h1>
            <p className="muted">Teste as armas, treine mira em alvos fixos e móveis e use cobertura contra o drone sentinela. Os atributos das armas são os mesmos do jogo competitivo.</p>
            <div className="controls-grid">
              <span><kbd>W A S D</kbd> mover</span><span><kbd>Mouse</kbd> mirar</span>
              <span><kbd>Clique esq.</kbd> atirar</span><span><kbd>Clique dir.</kbd> mira</span>
              <span><kbd>Shift</kbd> correr</span><span><kbd>Espaço</kbd> pular</span>
              <span><kbd>Ctrl</kbd>/<kbd>C</kbd> agachar</span><span><kbd>R</kbd> recarregar</span>
              <span><kbd>1 2 3</kbd> trocar arma</span><span><kbd>E</kbd> interagir</span>
              <span><kbd>Esc</kbd> pausar</span><span><kbd>Roda</kbd> trocar arma</span>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Button onClick={play} disabled={!weapons} loading={!weapons} data-testid="start-training">Iniciar</Button>
              <Button variant="ghost" onClick={() => setPhase("loadout")} disabled={!weapons}>Arsenal</Button>
              <Button variant="ghost" onClick={() => navigate("/menu")}>Menu</Button>
            </div>
          </div>
        </div>
      )}

      {phase === "paused" && (
        <div className="overlay-center">
          <div className="pause panel cut stagger" data-testid="pause-menu">
            <div className="label">Pausado</div>
            <h1>Treinamento</h1>
            <Button block onClick={play}>Continuar</Button>
            <Button block variant="ghost" onClick={() => setPhase("loadout")}>Trocar arsenal</Button>
            <Button block variant="ghost" onClick={() => runtime.current?.setDroneEnabled(!(hud?.droneEnabled ?? true))}>Drone sentinela: {hud?.droneEnabled === false ? "desligado" : "ligado"}</Button>
            <Button block variant="ghost" onClick={() => runtime.current?.resetStats()}>Zerar estatísticas</Button>
            <div className="pause-settings">
              <label><span className="label">Sensibilidade: {settings.sensitivity.toFixed(2)}</span>
                <input className="range" type="range" min={0.1} max={4} step={0.05} value={settings.sensitivity} onChange={(e) => updateSettings({ sensitivity: Number(e.target.value) })} /></label>
              <label><span className="label">Campo de visão: {settings.fov}°</span>
                <input className="range" type="range" min={70} max={110} step={1} value={settings.fov} onChange={(e) => updateSettings({ fov: Number(e.target.value) })} /></label>
              <label><span className="label">FPS máximo: {settings.maxFps === 0 ? "ilimitado" : settings.maxFps}</span>
                <input className="range" type="range" min={0} max={240} step={30} value={settings.maxFps} onChange={(e) => updateSettings({ maxFps: Number(e.target.value) })} /></label>
              <label><span className="label">Volume: {Math.round(settings.masterVolume * 100)}%</span>
                <input className="range" type="range" min={0} max={1} step={0.05} value={settings.masterVolume} onChange={(e) => updateSettings({ masterVolume: Number(e.target.value) })} /></label>
            </div>
            <Button block variant="ghost" onClick={() => navigate("/menu")}>Sair para o menu</Button>
          </div>
        </div>
      )}

      {phase === "loadout" && weapons && (
        <div className="overlay-center">
          <div className="loadout panel cut" data-testid="loadout">
            <div className="label">Terminal de armas</div>
            <h1>Arsenal</h1>
            <div className="loadout-slots">
              {[0, 1, 2].map((slot) => (
                <div key={slot} className="loadout-col">
                  <span className="label">Slot {slot + 1}</span>
                  {weapons.map((wp) => (
                    <button key={wp.code} className={`wp ${loadout[slot] === wp.code ? "on" : ""}`} disabled={loadout.includes(wp.code) && loadout[slot] !== wp.code}
                      onClick={() => { const next = [...loadout]; next[slot] = wp.code; applyLoadout(next); uiSound.click(); }}>
                      <strong>{wp.name}</strong>
                      <span>{CATEGORY_LABEL[wp.category]} · {wp.damage}{wp.pelletsPerShot > 1 ? `×${wp.pelletsPerShot}` : ""} dano · {wp.fireRateRpm} RPM</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <Button onClick={play}>Confirmar e jogar</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
