import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { CHAT_MAX_LEN, MODES, ROOM_SPECTATOR_MAX, SPECTATOR_DELAY_MS, WEAPON_CATEGORY_LABEL, type RoomMemberView, type RoomTeam, type RoomView } from "@vanta/shared";
import { gameSocket, type SocketStatus } from "../net/GameSocket";
import { Button, useToast } from "../components/ui";
import { uiSound } from "../audio/ui-sound";
import { useAuth } from "../auth/AuthContext";
import { useSocial } from "../social/SocialContext";
import { PresenceDot } from "../social/FriendsPanel";
import { TEAM_COLORS } from "../game/OnlineRuntime";
import { RoomSettingsForm, mapName } from "./RoomsScreen";

const TEAM_NAME = ["Time A", "Time B"] as const;

/** Lobby da sala: código, regras, times, espectadores, convites, chat e controles do dono. */
export function RoomLobby() {
  const navigate = useNavigate();
  const toast = useToast();
  const { me } = useAuth();
  const social = useSocial();
  const [room, setRoom] = useState<RoomView | null>(gameSocket.room);
  const [status, setStatus] = useState<SocketStatus>(gameSocket.status);
  const [editing, setEditing] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const myId = me?.user.id;

  useEffect(() => {
    gameSocket.connect();
    const offS = gameSocket.onStatus(setStatus);
    const off = gameSocket.on((m) => {
      if (m.t === "room") {
        setRoom(m.room);
        if (!m.room) navigate("/salas", { replace: true });
        else setEditing(false);
      } else if (m.t === "match") {
        uiSound.success();
        navigate("/partida");
      } else if (m.t === "spec_start") {
        navigate("/assistir");
      } else if (m.t === "welcome" && m.inMatch) {
        navigate("/partida");
      }
    });
    // A sala pode ter chegado entre a primeira renderização e a inscrição acima (ex.: aceitar um convite
    // manda o pedido e abre esta tela na hora): sincroniza com o que o socket já sabe.
    setRoom(gameSocket.room);
    setStatus(gameSocket.status);
    // Sem sala conhecida (ex.: recarregou a página): espera o servidor reenviar ou volta para a lista.
    const t = window.setTimeout(() => {
      if (gameSocket.room) setRoom(gameSocket.room);
      else if (gameSocket.status === "online") navigate("/salas", { replace: true });
    }, 3000);
    return () => {
      off();
      offS();
      clearTimeout(t);
    };
  }, [navigate]);

  const lines = social.chat.filter((l) => l.channel === "room");
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines.length]);

  if (!room) {
    return (
      <div className="screen play-screen"><div className="play-wrap"><p className="muted">Carregando a sala…</p></div></div>
    );
  }

  const owner = room.ownerId === myId;
  const mine = room.members.find((m) => m.id === myId);
  const inMatch = room.status === "in_match";
  const s = room.settings;
  const teamSize = MODES[s.mode].teamSize;
  const team = (t: RoomTeam) => room.members.filter((m) => m.team === t);
  const spectators = team(null);
  const canStart = owner && !inMatch && team(0).length > 0 && team(1).length > 0;
  const memberIds = new Set(room.members.map((m) => m.id));
  const invitable = (social.overview?.friends ?? []).filter((f) => !memberIds.has(f.id) && (social.presence.get(f.id) ?? "offline") !== "offline");

  const send = (e: FormEvent) => {
    e.preventDefault();
    social.sendChat("room", text);
    setText("");
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(room.code);
      toast("Código copiado", `Mande ${room.code} para quem você quer chamar.`);
    } catch {
      toast("Código da sala", room.code);
    }
  };
  const moveTo = (userId: string, t: RoomTeam) => gameSocket.send({ t: "room_team", ...(userId !== myId ? { userId } : {}), team: t });

  const memberRow = (m: RoomMemberView) => (
    <li key={m.id} className="room-member" data-testid={`room-member-${m.username}`} data-team={m.team === null ? "spec" : m.team}>
      <span className={`presence-dot ${m.online ? "online" : "offline"}`} title={m.online ? "Online" : "Caiu: tem alguns segundos para voltar"} />
      <strong>{m.username}</strong>
      {m.id === room.ownerId && <span className="pill">Dono</span>}
      {m.id === myId && <span className="pill you-pill">Você</span>}
      {owner && !inMatch && m.id !== myId && (
        <span className="row-actions">
          {m.team !== 0 && <button className="btn-mini ghost" onClick={() => moveTo(m.id, 0)} title="Mover para o Time A">A</button>}
          {m.team !== 1 && <button className="btn-mini ghost" onClick={() => moveTo(m.id, 1)} title="Mover para o Time B">B</button>}
          {m.team !== null && s.allowSpectators && <button className="btn-mini ghost" onClick={() => moveTo(m.id, null)} title="Mover para espectadores">👁</button>}
          <button className="btn-mini ghost danger" onClick={() => gameSocket.send({ t: "room_kick", userId: m.id })} data-testid={`room-kick-${m.username}`}>Remover</button>
        </span>
      )}
    </li>
  );

  return (
    <div className="screen play-screen room-lobby">
      <div className="play-wrap stagger">
        <div className="play-head">
          <Button variant="ghost" onClick={() => gameSocket.send({ t: "room_leave" })} disabled={inMatch && mine?.team !== null} data-testid="room-leave">← Sair da sala</Button>
          <span className={`net-dot ${status}`}>{status === "online" ? "Conectado ao servidor de jogo" : "Reconectando…"}</span>
        </div>

        <div className="room-header">
          <div>
            <span className="label">Sala personalizada{s.isPrivate ? " · privada" : " · pública"}{room.hasPassword ? " · com senha" : ""}{room.locked ? " · trancada" : ""}</span>
            <h1 data-testid="room-title">{s.name}</h1>
          </div>
          <button className="panel cut room-code" onClick={() => void copy()} title="Copiar código" data-testid="room-code">
            <span className="label">Código</span>
            <strong className="mono">{room.code}</strong>
          </button>
        </div>

        <div className="room-rules panel cut" data-testid="room-rules">
          <span><b>{MODES[s.mode].label}</b></span>
          <span>{mapName(s.map)}</span>
          <span>{s.roundsToWin} round{s.roundsToWin > 1 ? "s" : ""} para vencer</span>
          <span>{s.roundTimeSec} s por round</span>
          <span>{s.friendlyFire ? "Fogo amigo ligado" : "Sem fogo amigo"}</span>
          {s.headshotsOnly && <span>Só headshot</span>}
          <span>{s.weapons.length === 5 ? "Todas as armas" : s.weapons.map((w) => WEAPON_CATEGORY_LABEL[w]).join(", ")}</span>
          <span>{s.allowSpectators ? `Espectadores: até ${ROOM_SPECTATOR_MAX}, com ${SPECTATOR_DELAY_MS / 1000} s de atraso` : "Sem espectadores"}</span>
        </div>

        {inMatch && (
          <div className="panel cut room-live" data-testid="room-live">
            <strong>Partida em andamento</strong>
            {mine?.team === null ? (
              <Button onClick={() => gameSocket.send({ t: "room_join", code: room.code })} data-testid="room-watch">Assistir</Button>
            ) : (
              <Button onClick={() => navigate("/partida")}>Voltar para a partida</Button>
            )}
          </div>
        )}

        <div className="room-teams">
          {([0, 1] as const).map((t) => (
            <div key={t} className="panel cut room-team" style={{ borderTopColor: TEAM_COLORS[t] }} data-testid={`room-team-${t}`}>
              <div className="side-head">
                <span className="label" style={{ color: TEAM_COLORS[t] }}>{TEAM_NAME[t]} · {team(t).length}/{teamSize}</span>
                {!inMatch && mine?.team !== t && team(t).length < teamSize && <button className="btn-mini" onClick={() => moveTo(myId!, t)} data-testid={`room-join-team-${t}`}>Entrar</button>}
              </div>
              <ul className="room-members">{team(t).map(memberRow)}{team(t).length === 0 && <li className="muted small">Vazio</li>}</ul>
            </div>
          ))}
          <div className="panel cut room-team spectators" data-testid="room-spectators">
            <div className="side-head">
              <span className="label">Espectadores · {spectators.length}/{ROOM_SPECTATOR_MAX}</span>
              {!inMatch && s.allowSpectators && mine?.team !== null && spectators.length < ROOM_SPECTATOR_MAX && <button className="btn-mini ghost" onClick={() => moveTo(myId!, null)} data-testid="room-join-spec">Assistir</button>}
            </div>
            <ul className="room-members">{spectators.map(memberRow)}{spectators.length === 0 && <li className="muted small">{s.allowSpectators ? "Ninguém assistindo" : "Desativado"}</li>}</ul>
          </div>
        </div>

        <div className="room-bottom">
          <div className="panel cut side-block room-chat">
            <span className="label">Chat da sala</span>
            <div className="party-chat" ref={log} data-testid="room-chat">
              {lines.length === 0 ? <span className="muted small">{inMatch ? "Durante a partida, só quem assiste fala aqui." : "Combine as regras com a galera."}</span> : lines.map((l) => (
                <div key={l.id} className="chat-line"><b>{l.from.username}:</b> {l.text}</div>
              ))}
            </div>
            <form onSubmit={send} className="party-chat-form">
              <input className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={CHAT_MAX_LEN} placeholder="Mensagem para a sala" data-testid="room-chat-input" />
            </form>
          </div>

          <div className="panel cut side-block room-actions">
            <span className="label">Ações</span>
            <Button variant="ghost" onClick={() => setInviting(true)} disabled={room.locked} data-testid="room-invite-open">Convidar amigos</Button>
            {owner ? (
              <>
                <Button variant="ghost" onClick={() => setEditing(true)} disabled={inMatch} data-testid="room-edit">Editar regras</Button>
                <Button variant="ghost" onClick={() => gameSocket.send({ t: "room_lock", locked: !room.locked })} data-testid="room-lock">{room.locked ? "Destrancar entrada" : "Trancar entrada"}</Button>
                <Button variant="ghost" onClick={() => gameSocket.send({ t: "room_close" })} disabled={inMatch} data-testid="room-close">Encerrar sala</Button>
                <Button onClick={() => { uiSound.click(); gameSocket.send({ t: "room_start" }); }} disabled={!canStart || status !== "online"} data-testid="room-start">Começar partida</Button>
                {!canStart && !inMatch && <p className="muted small">Cada time precisa de pelo menos um jogador.</p>}
              </>
            ) : (
              <p className="muted small">Só o dono muda as regras e começa a partida. Seu arsenal é o escolhido em Jogar (armas fora das categorias liberadas são trocadas).</p>
            )}
          </div>
        </div>
      </div>

      {editing && (
        <div className="overlay-center" onClick={() => setEditing(false)}>
          <section className="panel cut room-settings-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Editar regras">
            <span className="label">Sala {room.code}</span>
            <h3>Editar regras</h3>
            <RoomSettingsForm initial={s} submitLabel="Salvar" withPassword hasPassword={room.hasPassword} onCancel={() => setEditing(false)} onSubmit={(settings, password) => gameSocket.send({ t: "room_update", settings, ...(password !== undefined ? { password } : {}) })} />
          </section>
        </div>
      )}

      {inviting && (
        <div className="overlay-center" onClick={() => setInviting(false)}>
          <section className="panel cut report-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Convidar amigos" data-testid="room-invite-dialog">
            <span className="label">Convidar para {room.code}</span>
            <h3>Amigos online</h3>
            {invitable.length === 0 ? <p className="muted">Nenhum amigo online fora da sala. Você também pode mandar o código {room.code}.</p> : (
              <ul className="friend-list">
                {invitable.map((f) => (
                  <li key={f.id} className="friend-row">
                    <PresenceDot state={social.presence.get(f.id) ?? "offline"} />
                    <div className="who"><strong>{f.username}</strong></div>
                    <div className="row-actions">
                      <button className="btn-mini" onClick={() => { gameSocket.send({ t: "room_invite", userId: f.id }); toast("Convite enviado", `${f.username} pode entrar sem senha por 2 minutos.`); }} data-testid={`room-invite-${f.username}`}>Convidar</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <div className="row-end"><Button variant="ghost" onClick={() => setInviting(false)}>Fechar</Button></div>
          </section>
        </div>
      )}
    </div>
  );
}
