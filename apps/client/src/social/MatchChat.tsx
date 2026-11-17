import { useEffect, useRef, useState, type FormEvent } from "react";
import { CHAT_CHANNEL_LABEL, CHAT_MAX_LEN, type ChatChannel } from "@vanta/shared";
import { useSocial } from "./SocialContext";
import { matchesBind } from "../game/input";

/**
 * Chat da partida. A tecla de chat (Enter) abre o chat da equipe; Shift + ela ou a tecla de chat de todos (Y) abre o de todos.
 * Enquanto digita, o ponteiro é liberado (o jogo não recebe as teclas) e volta ao enviar ou com Esc.
 */
export function MatchChat({ teamChat, myTeamIds, onTyping, resume, disabled }: { teamChat: boolean; myTeamIds: Set<string>; onTyping: (t: boolean) => void; resume: () => void; disabled?: boolean }) {
  const social = useSocial();
  const [channel, setChannel] = useState<ChatChannel | null>(null);
  const [text, setText] = useState("");
  const [, setTick] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const lines = social.chat.slice(-8);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const team = matchesBind("chat", e.code) || (e.code === "NumpadEnter" && matchesBind("chat", "Enter"));
      const all = matchesBind("chatAll", e.code);
      if (channel || disabled || (!team && !all)) return;
      if (document.activeElement && ["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
      e.preventDefault();
      const ch: ChatChannel = all || e.shiftKey || !teamChat ? "all" : "team";
      setChannel(ch);
      onTyping(true);
      document.exitPointerLock?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [channel, disabled, teamChat, onTyping]);

  // Foca o campo assim que ele aparece. Se o ponteiro for travado enquanto digita
  // (pedido de trava que chegou atrasado), solta de novo: as teclas são do chat.
  useEffect(() => {
    if (!channel) return;
    input.current?.focus();
    const onLock = () => {
      if (document.pointerLockElement) document.exitPointerLock?.();
      input.current?.focus();
    };
    document.addEventListener("pointerlockchange", onLock);
    return () => document.removeEventListener("pointerlockchange", onLock);
  }, [channel]);

  // Mensagens antigas somem da tela sozinhas (continuam visíveis enquanto digita).
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  function close(send: boolean) {
    if (send && channel) social.sendChat(channel, text);
    setText("");
    setChannel(null);
    onTyping(false);
    resume();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    close(true);
  }

  const now = Date.now();
  const visible = channel ? lines : lines.filter((l) => now - l.at < 10_000);
  return (
    <div className={`match-chat ${channel ? "open" : ""}`} data-testid="match-chat">
      <div className={`chat-log ${visible.length ? "" : "empty"}`}>
        {visible.map((l) => (
          <div key={l.id} className={`chat-line ch-${l.channel}`}>
            <span className="ch">[{CHAT_CHANNEL_LABEL[l.channel]}]</span>{" "}
            <b className={myTeamIds.has(l.from.id) ? "ally" : "enemy"}>{l.from.username}:</b> {l.text}
          </div>
        ))}
      </div>
      {channel ? (
        <form onSubmit={submit} className="chat-form">
          <span className="label">{CHAT_CHANNEL_LABEL[channel]}</span>
          <input
            ref={input}
            className="input"
            value={text}
            maxLength={CHAT_MAX_LEN}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close(false);
              }
            }}
            onBlur={() => channel && close(false)}
            data-testid="match-chat-input"
          />
        </form>
      ) : (
        !disabled && <span className="chat-hint muted small">Enter: {teamChat ? "equipe · Shift+Enter: todos" : "chat"}</span>
      )}
    </div>
  );
}
