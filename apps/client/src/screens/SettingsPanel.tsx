import { useEffect, useRef, useState } from "react";
import { BIND_GROUPS, BIND_LABEL, DEFAULT_KEYBINDS, assignKey, clearKey, isBindableCode, keyLabel, sanitizeKeybinds, type AccountSettings, type BindAction, type Keybinds } from "@vanta/shared";
import { Button } from "../components/ui";
import { api } from "../api/client";
import { setKeybinds } from "../game/input";

export interface LocalSettings {
  quality: "low" | "medium" | "high" | "ultra";
  uiVolume: number;
  masterVolume: number;
  sensitivity: number;
  fov: number;
  /** 0 = ilimitado (vsync). */
  maxFps: number;
  keybinds: Keybinds;
}

const KEY = "vanta.settings";
export const DEFAULT_SETTINGS: LocalSettings = { quality: "high", uiVolume: 0.5, masterVolume: 0.6, sensitivity: 1, fov: 90, maxFps: 0, keybinds: DEFAULT_KEYBINDS };

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export function loadSettings(): LocalSettings {
  const s = readSettings();
  setKeybinds(s.keybinds);
  return s;
}

function readSettings(): LocalSettings {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      quality: ["low", "medium", "high", "ultra"].includes(s.quality) ? s.quality : DEFAULT_SETTINGS.quality,
      uiVolume: num(s.uiVolume, 0, 1, DEFAULT_SETTINGS.uiVolume),
      masterVolume: num(s.masterVolume, 0, 1, DEFAULT_SETTINGS.masterVolume),
      sensitivity: num(s.sensitivity, 0.1, 4, DEFAULT_SETTINGS.sensitivity),
      fov: num(s.fov, 70, 110, DEFAULT_SETTINGS.fov),
      maxFps: num(s.maxFps, 0, 240, DEFAULT_SETTINGS.maxFps),
      keybinds: sanitizeKeybinds(s.keybinds ?? null),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, keybinds: sanitizeKeybinds(null) };
  }
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;

export function saveSettings(s: LocalSettings, opts: { sync?: boolean } = {}) {
  setKeybinds(s.keybinds);
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
    localStorage.setItem("vanta.uiVolume", String(s.uiVolume));
  } catch { /* armazenamento indisponível: mantém só em memória */ }
  // Teclas, sensibilidade e campo de visão também vão para a conta (valem em outro computador).
  if (opts.sync === false || !api.token) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const body: AccountSettings = { keybinds: s.keybinds, sensitivity: s.sensitivity, fov: Math.round(s.fov) };
    void api.put("/me/settings", body).catch(() => undefined);
  }, 800);
}

/** Ao entrar na conta: as configurações salvas na conta valem sobre as deste navegador. */
export async function pullAccountSettings() {
  const acc = await api.get<AccountSettings>("/me/settings");
  const local = readSettings();
  saveSettings({ ...local, keybinds: sanitizeKeybinds(acc.keybinds ?? local.keybinds), sensitivity: acc.sensitivity ?? local.sensitivity, fov: acc.fov ?? local.fov }, { sync: false });
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
        <KeybindEditor value={value.keybinds} onChange={(keybinds) => update({ keybinds })} />
        <div style={{ marginTop: 22 }}><Button block onClick={onClose}>Concluir</Button></div>
      </section>
    </div>
  );
}

/** Nomes das teclas no layout do teclado do jogador, quando o navegador informa (Chrome/Edge). */
function useLayoutLabels() {
  const [map, setMap] = useState<Map<string, string> | null>(null);
  useEffect(() => {
    const kb = (navigator as unknown as { keyboard?: { getLayoutMap?: () => Promise<Map<string, string>> } }).keyboard;
    kb?.getLayoutMap?.().then((m) => setMap(new Map(m))).catch(() => undefined);
  }, []);
  return (code: string | undefined) => {
    if (!code) return "—";
    const fromLayout = map?.get(code);
    return fromLayout && /^(Key|Digit|Bracket|Semicolon|Quote|Comma|Period|Slash|Backquote|Backslash|IntlBackslash|IntlRo|Minus|Equal)/.test(code) ? fromLayout.toUpperCase() : keyLabel(code);
  };
}

/** Lista de ações com até 2 teclas cada. Clique num espaço e aperte a tecla (ou botão do mouse). */
export function KeybindEditor({ value, onChange }: { value: Keybinds; onChange: (b: Keybinds) => void }) {
  const [listening, setListening] = useState<{ action: BindAction; slot: 0 | 1 } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const label = useLayoutLabels();
  // A tela de trás re-renderiza o tempo todo: o ouvinte lê o valor atual por referência e não é recriado.
  const latest = useRef({ value, onChange, label });
  latest.current = { value, onChange, label };

  useEffect(() => {
    if (!listening) return;
    const apply = (code: string) => {
      const { value, onChange, label } = latest.current;
      const r = assignKey(value, listening.action, listening.slot, code);
      onChange(r.binds);
      setNotice(r.takenFrom ? `${label(code)} saiu de "${BIND_LABEL[r.takenFrom]}".` : null);
      setListening(null);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") return setListening(null);
      if (e.code === "Backspace" || e.code === "Delete") {
        latest.current.onChange(clearKey(latest.current.value, listening.action, listening.slot));
        setNotice(null);
        return setListening(null);
      }
      if (!isBindableCode(e.code)) return setNotice(`${e.code} não pode ser usada.`);
      apply(e.code);
    };
    const onMouse = (e: MouseEvent) => {
      // O clique que abriu a escuta não conta: só os próximos.
      if ((e.target as HTMLElement | null)?.closest?.("[data-bind-slot]")) {
        if (e.button === 0) return;
      }
      e.preventDefault();
      e.stopPropagation();
      apply(`Mouse${e.button}`);
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
    };
  }, [listening]);

  return (
    <div className="keybinds" data-testid="keybinds">
      <div className="keybinds-head">
        <h3 className="label" style={{ marginTop: 22 }}>Teclas</h3>
        <button className="btn-mini ghost" onClick={() => { onChange(sanitizeKeybinds(DEFAULT_KEYBINDS)); setNotice("Teclas padrão restauradas."); }} data-testid="keybinds-reset">Restaurar padrão</button>
      </div>
      <p className="muted" style={{ fontSize: 12 }}>Clique num espaço e aperte a tecla ou o botão do mouse. Esc cancela; Backspace limpa. Salvas na sua conta.</p>
      {notice && <p className="small keybind-notice" data-testid="keybind-notice">{notice}</p>}
      {BIND_GROUPS.map((g) => (
        <div key={g.label} className="keybind-group">
          <div className="label small">{g.label}</div>
          {g.actions.map((a) => (
            <div key={a} className="keybind-row" data-testid={`bind-${a}`}>
              <span>{BIND_LABEL[a]}</span>
              {([0, 1] as const).map((slot) => {
                const on = listening?.action === a && listening.slot === slot;
                return (
                  <button key={slot} data-bind-slot className={`keybind-slot ${on ? "listening" : ""} ${value[a][slot] ? "" : "empty"}`} onClick={() => setListening(on ? null : { action: a, slot })} data-testid={`bind-${a}-${slot}`}>
                    {on ? "Aperte…" : label(value[a][slot])}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
