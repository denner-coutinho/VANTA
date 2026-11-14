import { Button } from "../components/ui";

export interface LocalSettings {
  quality: "low" | "medium" | "high" | "ultra";
  uiVolume: number;
  masterVolume: number;
  sensitivity: number;
  fov: number;
  /** 0 = ilimitado (vsync). */
  maxFps: number;
}

const KEY = "vanta.settings";
export const DEFAULT_SETTINGS: LocalSettings = { quality: "high", uiVolume: 0.5, masterVolume: 0.6, sensitivity: 1, fov: 90, maxFps: 0 };

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function loadSettings(): LocalSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      quality: ["low", "medium", "high", "ultra"].includes(s.quality) ? s.quality : DEFAULT_SETTINGS.quality,
      uiVolume: num(s.uiVolume, 0, 1, DEFAULT_SETTINGS.uiVolume),
      masterVolume: num(s.masterVolume, 0, 1, DEFAULT_SETTINGS.masterVolume),
      sensitivity: num(s.sensitivity, 0.1, 4, DEFAULT_SETTINGS.sensitivity),
      fov: num(s.fov, 70, 110, DEFAULT_SETTINGS.fov),
      maxFps: num(s.maxFps, 0, 240, DEFAULT_SETTINGS.maxFps),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: LocalSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    localStorage.setItem("vanta.uiVolume", String(s.uiVolume));
  } catch { /* armazenamento indisponível: mantém só em memória */ }
}

const QUALITIES: Array<[LocalSettings["quality"], string]> = [["low", "Baixo"], ["medium", "Médio"], ["high", "Alto"], ["ultra", "Ultra"]];

export function SettingsPanel({ value, onChange, onClose }: { value: LocalSettings; onChange: (s: LocalSettings) => void; onClose: () => void }) {
  const update = (patch: Partial<LocalSettings>) => {
    const next = { ...value, ...patch };
    saveSettings(next);
    onChange(next);
  };
  return (
    <div className="overlay" onClick={onClose}>
      <section className="drawer panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Configurações">
        <div className="drawer-head">
          <div><div className="label">Sistema</div><h2>Configurações</h2></div>
          <button className="icon-btn panel cut cut-sm" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        <h3 className="label">Qualidade gráfica</h3>
        <div className="seg">
          {QUALITIES.map(([k, l]) => (
            <button key={k} className={value.quality === k ? "on" : ""} onClick={() => update({ quality: k })}>{l}</button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 12 }}>Controla resolução interna, bloom, sombras e partículas. A competitividade não muda: hitboxes e visibilidade são iguais em todas.</p>
        <h3 className="label" style={{ marginTop: 22 }}>Sensibilidade do mouse: {value.sensitivity.toFixed(2)}</h3>
        <input className="range" type="range" min={0.1} max={4} step={0.05} value={value.sensitivity} onChange={(e) => update({ sensitivity: Number(e.target.value) })} />
        <h3 className="label" style={{ marginTop: 22 }}>Campo de visão: {value.fov}°</h3>
        <input className="range" type="range" min={70} max={110} step={1} value={value.fov} onChange={(e) => update({ fov: Number(e.target.value) })} />
        <h3 className="label" style={{ marginTop: 22 }}>FPS máximo: {value.maxFps === 0 ? "ilimitado" : value.maxFps}</h3>
        <input className="range" type="range" min={0} max={240} step={30} value={value.maxFps} onChange={(e) => update({ maxFps: Number(e.target.value) })} />
        <h3 className="label" style={{ marginTop: 22 }}>Volume do jogo: {Math.round(value.masterVolume * 100)}%</h3>
        <input className="range" type="range" min={0} max={1} step={0.05} value={value.masterVolume} onChange={(e) => update({ masterVolume: Number(e.target.value) })} />
        <h3 className="label" style={{ marginTop: 22 }}>Volume da interface: {Math.round(value.uiVolume * 100)}%</h3>
        <input className="range" type="range" min={0} max={1} step={0.05} value={value.uiVolume} onChange={(e) => update({ uiVolume: Number(e.target.value) })} />
        <p className="muted" style={{ fontSize: 12, marginTop: 16 }}>A resolução acompanha a janela; use a qualidade para ajustar a resolução interna.</p>
        <div style={{ marginTop: 22 }}><Button block onClick={onClose}>Concluir</Button></div>
      </section>
    </div>
  );
}
