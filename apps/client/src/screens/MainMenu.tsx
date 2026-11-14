import { useEffect, useMemo, useState } from "react";
import { RANKS, rankProgress, type ActiveEvent } from "@vanta/shared";
import { useAuth } from "../auth/AuthContext";
import { api } from "../api/client";
import { Logo } from "../components/Logo";
import { RankEmblem } from "../components/RankEmblem";
import { useToast } from "../components/ui";
import { MenuScene, type GraphicsQuality } from "../three/MenuScene";
import { uiSound } from "../audio/ui-sound";
import { ProfilePanel } from "./ProfilePanel";
import { SettingsPanel, loadSettings, type LocalSettings } from "./SettingsPanel";

interface Character { id: string; code: string; name: string; role: string; lore: string; personality: string; primaryColor: string }
interface Season { name: string; endsAt: string }

/** Itens do menu. `phase` indica quando a funcionalidade entra no roadmap (não há botão falso). */
const NAV: Array<{ key: string; label: string; phase?: number; hint: string }> = [
  { key: "play", label: "Jogar", phase: 2, hint: "Treinamento e partidas casuais" },
  { key: "ranked", label: "Ranqueado", phase: 5, hint: "Matchmaking por MMR e 15 patentes" },
  { key: "rooms", label: "Salas", phase: 3, hint: "Salas personalizadas com código" },
  { key: "store", label: "Loja", phase: 6, hint: "Skins e cosméticos com VANTA COINS" },
  { key: "inventory", label: "Inventário", phase: 6, hint: "Equipar itens adquiridos" },
  { key: "profile", label: "Perfil", hint: "Conta, progresso e segurança" },
];

export function MainMenu() {
  const { me, logout } = useAuth();
  const toast = useToast();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [charIndex, setCharIndex] = useState(0);
  const [events, setEvents] = useState<ActiveEvent[] | null>(null);
  const [season, setSeason] = useState<Season | null>(null);
  const [panel, setPanel] = useState<"profile" | "settings" | null>(null);
  const [settings, setSettings] = useState<LocalSettings>(loadSettings);

  useEffect(() => {
    api.get<Character[]>("/content/characters").then((list) => {
      setCharacters(list);
      const mainId = me?.profile.mainCharacterId;
      const idx = list.findIndex((c) => c.id === mainId);
      if (idx >= 0) setCharIndex(idx);
    }).catch(() => setCharacters([]));
    api.get<ActiveEvent[]>("/content/events/active").then(setEvents).catch(() => setEvents([]));
    api.get<Season | null>("/content/season").then(setSeason).catch(() => setSeason(null));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const character = characters[charIndex];
  const points = me?.ranked?.points ?? 0;
  const rp = useMemo(() => rankProgress(points), [points]);

  if (!me) return null;

  function onNav(key: string, phase?: number) {
    if (key === "profile") return setPanel("profile");
    if (phase) {
      uiSound.error();
      toast(`Fase ${phase} do roadmap`, "Este modo ainda está em desenvolvimento e será liberado quando for testado de ponta a ponta.");
    }
  }

  async function selectCharacter(delta: number) {
    if (!characters.length) return;
    const next = (charIndex + delta + characters.length) % characters.length;
    setCharIndex(next);
    uiSound.hover();
    await api.post("/me/character", { characterId: characters[next]!.id }).catch(() => undefined);
  }

  const xpPct = me.profile.xpForNext ? (me.profile.xpIntoLevel / me.profile.xpForNext) * 100 : 100;

  return (
    <div className="screen menu">
      <MenuScene accent={character?.primaryColor ?? "#287BFF"} quality={settings.quality as GraphicsQuality} />
      <div className="menu-shade" />
      <div className="scanlines" />

      <header className="menu-top">
        <Logo size="sm" />
        <div className="menu-top-right">
          <div className="chip panel cut-sm cut" title="VANTA COINS">
            <span className="vc-icon">VC</span>
            <strong data-testid="wallet-balance">{me.wallet.balance.toLocaleString("pt-BR")}</strong>
          </div>
          <div className="chip panel cut-sm cut level-chip" title={`${me.profile.xpIntoLevel} / ${me.profile.xpForNext} XP`}>
            <span className="label">Nível</span>
            <strong data-testid="player-level">{me.profile.level}</strong>
            <div className="xp"><div style={{ width: `${xpPct}%` }} /></div>
          </div>
          <button className="player-chip panel cut cut-sm" onClick={() => setPanel("profile")} onMouseEnter={() => uiSound.hover()}>
            <RankEmblem order={rp.rank.order} size={34} />
            <div>
              <strong>{me.user.username}</strong>
              <span className="label" style={{ color: rp.rank.color }}>{me.ranked ? rp.rank.name : "Sem patente"}</span>
            </div>
          </button>
          <button className="icon-btn panel cut cut-sm" aria-label="Configurações" onClick={() => setPanel("settings")} onMouseEnter={() => uiSound.hover()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
          </button>
          <button className="icon-btn panel cut cut-sm" aria-label="Sair" onClick={() => void logout()} onMouseEnter={() => uiSound.hover()}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></svg>
          </button>
        </div>
      </header>

      <nav className="menu-nav stagger" aria-label="Menu principal">
        {NAV.map((n, i) => (
          <button
            key={n.key}
            className={`nav-item ${i === 0 ? "primary" : ""} ${n.phase ? "locked" : ""}`}
            onClick={() => onNav(n.key, n.phase)}
            onMouseEnter={() => uiSound.hover()}
            data-testid={`nav-${n.key}`}
          >
            <span className="nav-label">{n.label}</span>
            <span className="nav-hint">{n.hint}</span>
            {n.phase && <span className="nav-lock">Fase {n.phase}</span>}
          </button>
        ))}
      </nav>

      {character && (
        <section className="operator-card stagger" key={character.code}>
          <div className="label" style={{ color: character.primaryColor }}>{character.role}</div>
          <h2 style={{ textShadow: `0 0 40px ${character.primaryColor}66` }}>{character.name}</h2>
          <p>{character.lore}</p>
          <div className="operator-switch">
            <button className="icon-btn panel cut cut-sm" aria-label="Operador anterior" onClick={() => void selectCharacter(-1)}>‹</button>
            <span className="label">{String(charIndex + 1).padStart(2, "0")} / {String(characters.length).padStart(2, "0")}</span>
            <button className="icon-btn panel cut cut-sm" aria-label="Próximo operador" onClick={() => void selectCharacter(1)}>›</button>
          </div>
          <div className="operator-note">Modelo provisório procedural · modelos rigados na Fase 4</div>
        </section>
      )}

      <aside className="menu-side stagger">
        <div className="panel cut side-block">
          <div className="side-head"><span className="label">Temporada</span></div>
          {season ? (
            <>
              <strong>{season.name}</strong>
              <span className="muted">Termina em {new Date(season.endsAt).toLocaleDateString("pt-BR")}</span>
            </>
          ) : (
            <span className="muted">Pré-temporada. O ranqueado abre com a Temporada 1.</span>
          )}
          <div className="rank-row">
            <RankEmblem order={rp.rank.order} size={44} />
            <div style={{ flex: 1 }}>
              <strong style={{ color: rp.rank.color }}>{rp.rank.name}</strong>
              <div className="xp"><div style={{ width: `${rp.progress * 100}%`, background: rp.rank.color }} /></div>
              <span className="muted">{points} PP {rp.next ? `· próxima: ${rp.next.name} (${rp.next.minPoints} PP)` : ""}</span>
            </div>
          </div>
        </div>

        <div className="panel cut side-block">
          <div className="side-head"><span className="label">Eventos ativos</span></div>
          {events === null ? <span className="muted">Carregando…</span> : events.length === 0 ? <span className="muted">Nenhum evento ativo no momento.</span> : events.map((e) => (
            <div key={e.id} className="event-row"><strong>{e.name}</strong><span className="muted">{e.description}</span></div>
          ))}
        </div>

        <div className="panel cut side-block">
          <div className="side-head"><span className="label">Amigos online</span><span className="pill">0</span></div>
          <span className="muted">Nenhum amigo online. O sistema de amigos e convites chega na Fase 7.</span>
        </div>
      </aside>

      <footer className="menu-foot">
        <span className="label">{RANKS.length} patentes · 5 mapas · 10 armas · 8 operadores</span>
        <span className="label"><span className="dot" /> Conectado</span>
      </footer>

      {panel === "profile" && <ProfilePanel onClose={() => setPanel(null)} />}
      {panel === "settings" && <SettingsPanel value={settings} onChange={setSettings} onClose={() => setPanel(null)} />}
    </div>
  );
}

