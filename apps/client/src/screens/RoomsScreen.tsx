import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  MAP_REGISTRY,
  MODES,
  WEAPON_CATEGORIES,
  WEAPON_CATEGORY_LABEL,
  defaultRoomSettings,
  normalizeRoomCode,
  roomPasswordSchema,
  roomSettingsSchema,
  type QueueMode,
  type RoomListItem,
  type RoomSettings,
} from "@vanta/shared";
import { gameSocket, type SocketStatus } from "../net/GameSocket";
import { Button } from "../components/ui";
import { uiSound } from "../audio/ui-sound";
import { useAuth } from "../auth/AuthContext";

export const mapName = (code: string) => MAP_REGISTRY[code]?.name ?? code;

/** Lista pública de salas, entrar por código (com senha quando pedir) e criar sala. */
export function RoomsScreen() {
  const navigate = useNavigate();
  const { me } = useAuth();
  const [status, setStatus] = useState<SocketStatus>(gameSocket.status);
  const [rooms, setRooms] = useState<RoomListItem[] | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [needPassword, setNeedPassword] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastJoin = useRef("");

  useEffect(() => {
    gameSocket.connect();
    // Já está numa sala: vai direto para o lobby.
    if (gameSocket.room) navigate("/sala", { replace: true });
    const offS = gameSocket.onStatus(setStatus);
    const off = gameSocket.on((m) => {
      if (m.t === "room_list") setRooms(m.rooms);
      else if (m.t === "room" && m.room) {
        uiSound.success();
        navigate("/sala");
      } else if (m.t === "welcome") gameSocket.send({ t: "room_list" });
      else if (m.t === "error") {
        if (m.code === "ROOM_PASSWORD") setNeedPassword((cur) => cur ?? lastJoin.current);
        if (m.code === "ROOM_BAD_PASSWORD") setError(m.message);
      }
    });
    const ask = () => gameSocket.send({ t: "room_list" });
    ask();
    const t = window.setInterval(ask, 4000);
    return () => {
      off();
      offS();
      clearInterval(t);
    };
  }, [navigate]);

  const join = (raw: string, pw?: string) => {
    const c = normalizeRoomCode(raw);
    if (c.length !== 6) return setError("O código tem 6 letras/números.");
    setError(null);
    setCode(c);
    lastJoin.current = c;
    uiSound.click();
    gameSocket.send({ t: "room_join", code: c, ...(pw ? { password: pw } : {}) });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    join(code);
  };
  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    if (needPassword) join(needPassword, password);
  };

  return (
    <div className="screen play-screen">
      <div className="play-wrap stagger">
        <div className="play-head">
          <Button variant="ghost" onClick={() => navigate("/menu")}>← Menu</Button>
          <span className={`net-dot ${status}`}>{status === "online" ? "Conectado ao servidor de jogo" : status === "offline" ? "Servidor de jogo indisponível" : "Conectando…"}</span>
        </div>
        <h1>Salas personalizadas</h1>
        <p className="muted">Monte partidas com suas regras e chame quem quiser. Partidas de sala ficam no seu histórico, mas não contam para estatísticas do perfil nem para o ranqueado.</p>

        <div className="rooms-top">
          <form className="panel cut side-block room-code-form" onSubmit={submitCode}>
            <span className="label">Entrar com código</span>
            <div className="add-row">
              <input className="input code-input" value={code} onChange={(e) => setCode(normalizeRoomCode(e.target.value))} placeholder="EX.: VX7K2Q" maxLength={6} data-testid="room-code-input" />
              <Button type="submit" data-testid="room-code-join">Entrar</Button>
            </div>
            {error && !needPassword && <p className="error small">{error}</p>}
          </form>
          <div className="panel cut side-block">
            <span className="label">Sua sala</span>
            <p className="muted small">Você vira o dono: escolhe mapa, modo e regras, organiza os times e começa a partida.</p>
            <Button onClick={() => { uiSound.click(); setCreating(true); }} disabled={status !== "online"} data-testid="room-create-open">Criar sala</Button>
          </div>
        </div>

        <div className="panel cut room-list-panel">
          <div className="side-head">
            <span className="label">Salas públicas</span>
            <button className="btn-mini ghost" onClick={() => gameSocket.send({ t: "room_list" })}>Atualizar</button>
          </div>
          {rooms === null ? <p className="muted">Carregando…</p> : rooms.length === 0 ? (
            <p className="muted empty">Nenhuma sala pública agora. Crie a sua e convide amigos.</p>
          ) : (
            <table className="room-table" data-testid="room-list">
              <thead><tr><th>Sala</th><th>Código</th><th>Modo</th><th>Mapa</th><th>Jogadores</th><th>Situação</th><th>Dono</th><th /></tr></thead>
              <tbody>
                {rooms.map((r) => (
                  <tr key={r.code} data-testid={`room-row-${r.code}`}>
                    <td><strong>{r.name}</strong>{r.hasPassword && <span className="pill lock-pill" title="Com senha">senha</span>}</td>
                    <td className="mono">{r.code}</td>
                    <td>{r.mode}</td>
                    <td>{mapName(r.map)}</td>
                    <td>{r.players}/{r.maxPlayers}{r.spectators ? <span className="muted small"> +{r.spectators} assistindo</span> : null}</td>
                    <td>{r.locked ? <span className="muted">Trancada</span> : r.status === "in_match" ? <span className="presence-text match">Em partida</span> : <span className="presence-text online">No lobby</span>}</td>
                    <td>{r.ownerName}</td>
                    <td>
                      <button className="btn-mini" disabled={r.locked} onClick={() => join(r.code)} data-testid={`room-join-${r.code}`}>{r.status === "in_match" ? "Assistir" : "Entrar"}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {needPassword && (
        <div className="overlay-center" onClick={() => setNeedPassword(null)}>
          <form className="panel cut report-dialog" onClick={(e) => e.stopPropagation()} onSubmit={submitPassword} data-testid="room-password-dialog">
            <span className="label">Sala {needPassword}</span>
            <h3>Esta sala tem senha</h3>
            <input className="input" type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} maxLength={32} placeholder="Senha da sala" data-testid="room-password-input" />
            {error && <p className="error small">{error}</p>}
            <div className="row-end">
              <Button type="button" variant="ghost" onClick={() => setNeedPassword(null)}>Cancelar</Button>
              <Button type="submit" data-testid="room-password-submit">Entrar</Button>
            </div>
          </form>
        </div>
      )}

      {creating && (
        <div className="overlay-center" onClick={() => setCreating(false)}>
          <section className="panel cut room-settings-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Criar sala">
            <span className="label">Nova sala</span>
            <h3>Criar sala</h3>
            <RoomSettingsForm
              initial={defaultRoomSettings(me?.user.username ?? "Jogador")}
              submitLabel="Criar sala"
              withPassword
              onCancel={() => setCreating(false)}
              onSubmit={(settings, pw) => {
                gameSocket.send({ t: "room_create", settings, ...(pw ? { password: pw } : {}) });
              }}
            />
          </section>
        </div>
      )}
    </div>
  );
}

/** Formulário de regras da sala (criar e editar). Valida com o mesmo esquema que o servidor usa. */
export function RoomSettingsForm({
  initial,
  submitLabel,
  withPassword,
  hasPassword,
  onSubmit,
  onCancel,
}: {
  initial: RoomSettings;
  submitLabel: string;
  withPassword?: boolean;
  /** Edição: a sala já tem senha (o campo vazio mantém; "remover" tira). */
  hasPassword?: boolean;
  onSubmit: (s: RoomSettings, password: string | null | undefined) => void;
  onCancel: () => void;
}) {
  const [s, setS] = useState<RoomSettings>(initial);
  const [pw, setPw] = useState("");
  const [removePw, setRemovePw] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof RoomSettings>(k: K, v: RoomSettings[K]) => setS((cur) => ({ ...cur, [k]: v }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const parsed = roomSettingsSchema.safeParse(s);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Regras inválidas.");
    let password: string | null | undefined;
    if (removePw) password = null;
    else if (pw) {
      const p = roomPasswordSchema.safeParse(pw);
      if (!p.success) return setError(p.error.issues[0]?.message ?? "Senha inválida.");
      password = pw;
    }
    setError(null);
    uiSound.click();
    onSubmit(parsed.data, password);
  };

  return (
    <form className="room-form" onSubmit={submit} data-testid="room-settings-form">
      <label className="field-inline">
        <span className="label">Nome</span>
        <input className="input" value={s.name} maxLength={32} onChange={(e) => set("name", e.target.value)} data-testid="room-name" />
      </label>
      <div className="room-form-grid">
        <label className="field-inline">
          <span className="label">Modo (jogadores)</span>
          <select className="input" value={s.mode} onChange={(e) => set("mode", e.target.value as QueueMode)} data-testid="room-mode">
            {(Object.keys(MODES) as QueueMode[]).map((m) => <option key={m} value={m}>{MODES[m].label} · até {MODES[m].teamSize * 2}</option>)}
          </select>
        </label>
        <label className="field-inline">
          <span className="label">Mapa</span>
          <select className="input" value={s.map} onChange={(e) => set("map", e.target.value)} data-testid="room-map">
            {Object.keys(MAP_REGISTRY).map((c) => <option key={c} value={c}>{mapName(c)}</option>)}
          </select>
        </label>
        <label className="field-inline">
          <span className="label">Rounds para vencer</span>
          <input className="input" type="number" min={1} max={15} value={s.roundsToWin} onChange={(e) => set("roundsToWin", Number(e.target.value))} data-testid="room-rounds" />
        </label>
        <label className="field-inline">
          <span className="label">Duração do round (s)</span>
          <input className="input" type="number" min={30} max={300} step={5} value={s.roundTimeSec} onChange={(e) => set("roundTimeSec", Number(e.target.value))} data-testid="room-round-time" />
        </label>
      </div>
      <span className="label">Armas liberadas</span>
      <div className="report-reasons">
        {WEAPON_CATEGORIES.map((c) => {
          const on = s.weapons.includes(c);
          return (
            <button key={c} type="button" className={`chip ${on ? "on" : ""}`} aria-pressed={on} onClick={() => set("weapons", on ? s.weapons.filter((x) => x !== c) : [...s.weapons, c])} data-testid={`room-weapon-${c}`}>
              {WEAPON_CATEGORY_LABEL[c]}
            </button>
          );
        })}
      </div>
      <div className="room-toggles">
        <label><input type="checkbox" checked={s.friendlyFire} onChange={(e) => set("friendlyFire", e.target.checked)} data-testid="room-ff" /> Fogo amigo</label>
        <label><input type="checkbox" checked={s.headshotsOnly} onChange={(e) => set("headshotsOnly", e.target.checked)} data-testid="room-hs" /> Só headshot</label>
        <label><input type="checkbox" checked={s.allowSpectators} onChange={(e) => set("allowSpectators", e.target.checked)} data-testid="room-spec" /> Permitir espectadores</label>
        <label><input type="checkbox" checked={s.isPrivate} onChange={(e) => set("isPrivate", e.target.checked)} data-testid="room-private" /> Privada (fora da lista; só código ou convite)</label>
      </div>
      {withPassword && (
        <label className="field-inline">
          <span className="label">{hasPassword ? "Nova senha (vazio mantém a atual)" : "Senha (opcional)"}</span>
          <div className="add-row">
            <input className="input" type="password" value={pw} maxLength={32} disabled={removePw} onChange={(e) => setPw(e.target.value)} placeholder="4 a 32 caracteres" data-testid="room-password" />
            {hasPassword && <label className="small"><input type="checkbox" checked={removePw} onChange={(e) => setRemovePw(e.target.checked)} /> remover</label>}
          </div>
        </label>
      )}
      {error && <p className="error small">{error}</p>}
      <div className="row-end">
        <Button type="button" variant="ghost" onClick={onCancel}>Cancelar</Button>
        <Button type="submit" data-testid="room-settings-submit">{submitLabel}</Button>
      </div>
    </form>
  );
}
