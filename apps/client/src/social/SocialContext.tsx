import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatChannel, PartyView, PresenceState, ReportReasonCode, ServerMessage, SocialOverviewResponse } from "@vanta/shared";
import { api, ApiError } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { gameSocket } from "../net/GameSocket";
import { useToast } from "../components/ui";
import { uiSound } from "../audio/ui-sound";
import { loadLoadout } from "../game/loadout";

export interface ChatLine {
  id: number;
  channel: ChatChannel;
  from: { id: string; username: string };
  text: string;
  at: number;
}

export interface PartyInvite {
  partyId: string;
  from: { id: string; username: string };
  expiresAt: number;
}

interface SocialState {
  overview: SocialOverviewResponse | null;
  presence: Map<string, PresenceState>;
  party: PartyView | null;
  invites: PartyInvite[];
  /** Chat do grupo e da partida atual (a tela de partida filtra o que é dela). */
  chat: ChatLine[];
  onlineFriends: number;
  /** Fila em que o jogador (ou o grupo dele) está agora. */
  searching: { mode: string; inQueue: number; needed: number } | null;
  refresh(): Promise<void>;
  /** Executa uma ação da API mostrando o erro num aviso; devolve true se deu certo. */
  run(fn: () => Promise<unknown>, okTitle?: string, okBody?: string): Promise<boolean>;
  addFriend(username: string): Promise<boolean>;
  accept(requestId: string): Promise<boolean>;
  decline(requestId: string): Promise<boolean>;
  cancel(requestId: string): Promise<boolean>;
  removeFriend(userId: string): Promise<boolean>;
  block(userId: string): Promise<boolean>;
  unblock(userId: string): Promise<boolean>;
  mute(userId: string): Promise<boolean>;
  unmute(userId: string): Promise<boolean>;
  report(userId: string, reason: ReportReasonCode, description?: string, matchId?: string): Promise<boolean>;
  inviteToParty(userId: string): void;
  respondInvite(partyId: string, accept: boolean): void;
  leaveParty(): void;
  kick(userId: string): void;
  sendChat(channel: ChatChannel, text: string): void;
  clearMatchChat(): void;
}

const Ctx = createContext<SocialState | null>(null);
let chatSeq = 0;

/**
 * Estado social do jogador logado: amigos (API), presença, grupo, convites e chat (servidor de jogo).
 * A conexão com o servidor de jogo fica aberta desde o menu para os avisos chegarem na hora.
 */
export function SocialProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const toast = useToast();
  const [overview, setOverview] = useState<SocialOverviewResponse | null>(null);
  const [presence, setPresence] = useState<Map<string, PresenceState>>(new Map());
  const [party, setParty] = useState<PartyView | null>(null);
  const [invites, setInvites] = useState<PartyInvite[]>([]);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [searching, setSearching] = useState<SocialState["searching"]>(null);
  const authed = status === "authenticated";
  const refreshTimer = useRef<number | null>(null);
  const lastMatchId = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setOverview(await api.get<SocialOverviewResponse>("/social/overview"));
    } catch {
      /* mantém a última lista */
    }
  }, []);

  // Vários eventos seguidos (ex.: bloquear desfaz amizade e cancela pedidos) viram uma recarga só.
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refresh(), 150);
  }, [refresh]);

  useEffect(() => {
    if (!authed) {
      gameSocket.disconnect();
      setOverview(null);
      setPresence(new Map());
      setParty(null);
      setInvites([]);
      setChat([]);
      return;
    }
    gameSocket.connect();
    void refresh();
    const off = gameSocket.on((m: ServerMessage) => {
      switch (m.t) {
        case "welcome":
          // O servidor usa este arsenal quando o líder do grupo entra na fila.
          gameSocket.send({ t: "loadout", loadout: loadLoadout() });
          return;
        case "presence":
          setPresence((prev) => {
            const next = m.full ? new Map<string, PresenceState>() : new Map(prev);
            for (const [id, s] of m.list) next.set(id, s);
            return next;
          });
          return;
        case "social": {
          const ev = m.ev;
          if (ev.k === "friend_request") {
            uiSound.success();
            toast("Pedido de amizade", `${ev.from.username} quer ser seu amigo. Abra Amigos para responder.`);
          } else if (ev.k === "friend_accepted") {
            toast("Novo amigo", `Você e ${ev.friend.username} agora são amigos.`);
          }
          refreshSoon();
          return;
        }
        case "party":
          setParty(m.party);
          if (!m.party) setChat((c) => c.filter((l) => l.channel !== "party"));
          return;
        case "party_invite":
          uiSound.success();
          setInvites((list) => [...list.filter((i) => i.partyId !== m.partyId), { partyId: m.partyId, from: m.from, expiresAt: m.expiresAt }]);
          return;
        case "chat":
          setChat((c) => [...c.slice(-99), { id: ++chatSeq, channel: m.channel, from: m.from, text: m.text, at: m.at }]);
          return;
        case "queue":
          setSearching(m.state === "searching" ? { mode: m.mode ?? "", inQueue: m.inQueue ?? 0, needed: m.needed ?? 0 } : null);
          return;
        case "match":
          setSearching(null);
          // A mesma partida pode reenviar as informações (reconexão/ressincronização): só limpa o chat se mudou.
          if (m.info.matchId !== lastMatchId.current) setChat((c) => c.filter((l) => l.channel === "party"));
          lastMatchId.current = m.info.matchId;
          return;
        case "error":
          if (["NOT_FRIEND", "OFFLINE", "PARTY_NOT_LEADER", "ALREADY_IN_PARTY", "IN_QUEUE", "PARTY_FULL", "INVITE_EXPIRED", "IN_MATCH", "CHAT_BANNED", "CHAT_RATE", "NO_PARTY", "NOT_IN_MATCH"].includes(m.code)) {
            uiSound.error();
            toast("Social", m.message);
          }
          return;
      }
    });
    return () => {
      off();
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [authed, refresh, refreshSoon, toast]);

  // Convites vencidos somem sozinhos.
  useEffect(() => {
    if (!invites.length) return;
    const t = window.setInterval(() => setInvites((list) => list.filter((i) => i.expiresAt > Date.now())), 1000);
    return () => clearInterval(t);
  }, [invites.length]);

  const run = useCallback(
    async (fn: () => Promise<unknown>, okTitle?: string, okBody?: string) => {
      try {
        await fn();
        if (okTitle) toast(okTitle, okBody ?? "");
        await refresh();
        return true;
      } catch (e) {
        uiSound.error();
        toast("Não deu certo", e instanceof ApiError ? e.message : "Tente de novo em instantes.");
        return false;
      }
    },
    [refresh, toast],
  );

  const value = useMemo<SocialState>(
    () => ({
      overview,
      presence,
      party,
      invites,
      chat,
      searching,
      onlineFriends: overview?.friends.filter((f) => (presence.get(f.id) ?? "offline") !== "offline").length ?? 0,
      refresh,
      run,
      addFriend: (username) =>
        run(async () => {
          const r = await api.post<{ status: "sent" | "accepted" }>("/social/requests", { username });
          toast(r.status === "accepted" ? "Novo amigo" : "Pedido enviado", r.status === "accepted" ? `Você e ${username} agora são amigos.` : `Aguardando ${username} aceitar.`);
        }),
      accept: (id) => run(() => api.post(`/social/requests/${id}/accept`)),
      decline: (id) => run(() => api.post(`/social/requests/${id}/decline`)),
      cancel: (id) => run(() => api.del(`/social/requests/${id}`)),
      removeFriend: (userId) => run(() => api.del(`/social/friends/${userId}`), "Amizade desfeita"),
      block: (userId) => run(() => api.post("/social/blocks", { userId }), "Jogador bloqueado", "Ele não pode mais te convidar, mandar pedidos nem falar com você no chat."),
      unblock: (userId) => run(() => api.del(`/social/blocks/${userId}`), "Desbloqueado"),
      mute: (userId) => run(() => api.post("/social/mutes", { userId }), "Jogador silenciado", "Você não vai mais ver as mensagens dele no chat."),
      unmute: (userId) => run(() => api.del(`/social/mutes/${userId}`), "Silêncio removido"),
      report: (userId, reason, description, matchId) =>
        run(() => api.post("/reports", { userId, reason, ...(description ? { description } : {}), ...(matchId ? { matchId } : {}) }), "Denúncia enviada", "Obrigado. A moderação vai analisar."),
      inviteToParty: (userId) => {
        gameSocket.send({ t: "party_invite", userId });
        toast("Convite enviado", "O convite vale por 60 segundos.");
      },
      respondInvite: (partyId, accept) => {
        gameSocket.send({ t: "party_respond", partyId, accept });
        setInvites((list) => list.filter((i) => i.partyId !== partyId));
      },
      leaveParty: () => gameSocket.send({ t: "party_leave" }),
      kick: (userId) => gameSocket.send({ t: "party_kick", userId }),
      sendChat: (channel, text) => {
        if (text.trim()) gameSocket.send({ t: "chat", channel, text });
      },
      clearMatchChat: () => setChat((c) => c.filter((l) => l.channel === "party")),
    }),
    [overview, presence, party, invites, chat, searching, refresh, run, toast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSocial(): SocialState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSocial fora do SocialProvider");
  return v;
}
