import { Button } from "../components/ui";

export interface LocalSettings { quality: "low" | "medium" | "high" | "ultra"; uiVolume: number }

const KEY = "vanta.settings";

export function loadSettings(): LocalSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return { quality: ["low", "medium", "high", "ultra"].includes(s.quality) ? s.quality : "high", uiVolume: typeof s.uiVolume === "number" ? s.uiVolume : 0.5 };
  } catch {
    return { quality: "high", uiVolume: 0.5 };
  }
}

function save(s: LocalSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    localStorage.setItem("vanta.uiVolume", String(s.uiVolume));
  } catch { /* armazenamento indisponível: mantém só em memória */ }
}

const QUALITIES: Array<[LocalSettings["quality"], string]> = [["low", "Baixo"], ["medium", "Médio"], ["high", "Alto"], ["ultra", "Ultra"]];

/** Configurações locais da Fase 1 (gráficos do menu e volume). Sensibilidade, FOV e FPS máximo entram com o gameplay (Fase 2). */
export function SettingsPanel({ value, onChange, onClose }: { value: LocalSettings; onChange: (s: LocalSettings) => void; onClose: () => void }) {
  const update = (patch: Partial<LocalSettings>) => {
    const next = { ...value, ...patch };
    save(next);
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
        <p className="muted" style={{ fontSize: 12 }}>Controla resolução interna, bloom, sombras e partículas.</p>
        <h3 className="label" style={{ marginTop: 24 }}>Volume da interface: {Math.round(value.uiVolume * 100)}%</h3>
        <input className="range" type="range" min={0} max={1} step={0.05} value={value.uiVolume} onChange={(e) => update({ uiVolume: Number(e.target.value) })} />
        <div style={{ marginTop: 28 }}><Button block onClick={onClose}>Concluir</Button></div>
      </section>
    </div>
  );
}
