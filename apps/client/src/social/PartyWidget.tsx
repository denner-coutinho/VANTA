import { useEffect, useRef, useState, type FormEvent } from "react";
import { CHAT_MAX_LEN, PARTY_MAX } from "@vanta/shared";
import { useAuth } from "../auth/AuthContext";
import { useSocial } from "./SocialContext";

/** Grupo atual: membros, líder, sair/remover e chat do grupo. Some quando não há grupo. */
export function PartyWidget({ onInvite }: { onInvite?: () => void }) {
  const social = useSocial();
  const { me } = useAuth();
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const party = social.party;
  const lines = social.chat.filter((l) => l.channel === "party");

  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight });
  }, [lines.length]);

  if (!party) return null;
  const leader = party.leaderId === me?.user.id;

  function send(e: FormEvent) {
    e.preventDefault();
    social.sendChat("party", text);
    setText("");
  }

  return (
    <div className="panel cut side-block party-widget" data-testid="party-widget">
      <div className="side-head">
        <span className="label">Grupo · {party.members.length}/{PARTY_MAX}</span>
        <button className="btn-mini ghost" onClick={() => social.leaveParty()} data-testid="party-leave">Sair</button>
      </div>
      <ul className="party-members">
        {party.members.map((m) => (
          <li key={m.id} data-testid={`party-member-${m.username}`}>
            <span className={`presence-dot ${m.online ? "online" : "offline"}`} />
            <strong>{m.username}</strong>
            {m.id === party.leaderId && <span className="pill">Líder</span>}
            {leader && m.id !== me?.user.id && <button className="btn-mini ghost" onClick={() => social.kick(m.id)}>Remover</button>}
          </li>
        ))}
        {party.invited.length > 0 && <li className="muted small">{party.invited.length} convite(s) aguardando resposta…</li>}
      </ul>
      {social.searching && <p className="party-searching" data-testid="party-searching">Procurando partida {social.searching.mode} · {social.searching.inQueue}/{social.searching.needed} na fila</p>}
      <p className="muted small">{leader ? "Você é o líder: quando entrar na fila em Jogar, o grupo inteiro entra junto (casual)." : "Só o líder entra na fila. Escolha seu arsenal em Jogar."}</p>
      {leader && party.members.length < PARTY_MAX && onInvite && <button className="btn-mini" onClick={onInvite}>Convidar amigos</button>}
      <div className="party-chat" ref={log} data-testid="party-chat">
        {lines.length === 0 ? <span className="muted small">Chat do grupo</span> : lines.map((l) => (
          <div key={l.id} className="chat-line"><b>{l.from.username}:</b> {l.text}</div>
        ))}
      </div>
      <form onSubmit={send} className="party-chat-form">
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} maxLength={CHAT_MAX_LEN} placeholder="Mensagem para o grupo" data-testid="party-chat-input" />
      </form>
    </div>
  );
}

/** Convites de grupo recebidos: aparecem em qualquer tela (menos durante a partida). */
export function InviteStack() {
  const social = useSocial();
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!social.invites.length) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [social.invites.length]);
  if (!social.invites.length || location.pathname === "/partida") return null;
  return (
    <div className="invite-stack" role="status" aria-live="polite">
      {social.invites.map((i) => (
        <div key={i.partyId} className="panel cut cut-sm invite-card" data-testid="party-invite">
          <span className="label">Convite de grupo</span>
          <strong>{i.from.username} chamou você para o grupo</strong>
          <span className="muted small">Expira em {Math.max(0, Math.ceil((i.expiresAt - Date.now()) / 1000))} s</span>
          <div className="row-end">
            <button className="btn-mini ghost" onClick={() => social.respondInvite(i.partyId, false)}>Recusar</button>
            <button className="btn-mini" onClick={() => social.respondInvite(i.partyId, true)} data-testid="party-invite-accept">Entrar</button>
          </div>
        </div>
      ))}
    </div>
  );
}
