import { GAME_PROTOCOL_VERSION, type ClientMessage, type MatchInfo, type QueueMode, type MatchProgressWire, type RankedResultWire, type RoomView, type ServerMessage, type SpectatorInfo } from "@vanta/shared";
import { api } from "../api/client";

type Listener = (m: ServerMessage) => void;
export type SocketStatus = "idle" | "connecting" | "online" | "reconnecting" | "offline";

/**
 * Conexão única com o servidor de jogo, compartilhada entre telas (fila → partida).
 * Autentica com o token de acesso da API; reconecta sozinha com espera crescente.
 */
class GameSocket {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: SocketStatus) => void>();
  private retry = 0;
  private retryTimer: number | null = null;
  private wanted = false;
  status: SocketStatus = "idle";
  userId: string | null = null;
  /** Última partida recebida (para a tela de partida montar mesmo se a mensagem chegou antes). */
  match: MatchInfo | null = null;
  inMatch = false;
  /** Último resultado ranqueado gravado pelo servidor (pode chegar logo depois do fim da partida). */
  rankedResult: RankedResultWire | null = null;
  /** XP, medalhas e missões da última partida (chega logo depois de gravada). */
  progress: MatchProgressWire | null = null;
  /** Sala personalizada atual e a partida que está assistindo (as telas montam com o último estado). */
  room: RoomView | null = null;
  spectate: SpectatorInfo | null = null;
  rtt = 0;
  private pingTimer: number | null = null;

  private url() {
    const base = (import.meta.env.VITE_GAME_URL as string | undefined) ?? `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/game`;
    return base;
  }

  private setStatus(s: SocketStatus) {
    this.status = s;
    this.statusListeners.forEach((l) => l(s));
  }

  /** Garante a conexão (idempotente). */
  connect() {
    this.wanted = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    void this.open();
  }

  private async open() {
    this.setStatus(this.retry ? "reconnecting" : "connecting");
    let token = api.token;
    if (!token) token = (await api.refresh())?.accessToken ?? null;
    if (!token) {
      this.setStatus("offline");
      return;
    }
    const ws = new WebSocket(this.url());
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: "hello", token: token!, v: GAME_PROTOCOL_VERSION });
    };
    ws.onmessage = (e) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data as string);
      } catch {
        return;
      }
      if (msg.t === "welcome") {
        this.retry = 0;
        this.userId = msg.userId;
        this.inMatch = msg.inMatch;
        if (!msg.inMatch) this.match = null;
        // O servidor reenvia a sala logo depois, se ainda fizer parte dela.
        this.room = null;
        this.spectate = null;
        this.setStatus("online");
        this.startPing();
      } else if (msg.t === "match") {
        this.match = msg.info;
        this.inMatch = true;
        this.rankedResult = null;
        this.progress = null;
      } else if (msg.t === "progress") {
        this.progress = msg;
      } else if (msg.t === "ranked_result") {
        this.rankedResult = msg;
      } else if (msg.t === "left_match") {
        this.match = null;
        this.inMatch = false;
      } else if (msg.t === "room") {
        this.room = msg.room;
        if (!msg.room) this.spectate = null;
      } else if (msg.t === "spec_start") {
        this.spectate = msg.info;
      } else if (msg.t === "spec_end") {
        this.spectate = null;
      } else if (msg.t === "pong") {
        this.rtt = performance.now() - msg.n;
      } else if (msg.t === "snap" && msg.ev.some((ev) => ev.k === "match_end")) {
        this.inMatch = false;
      }
      this.listeners.forEach((l) => l(msg));
    };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopPing();
      // 4001: sessão inválida (tenta renovar o token uma vez); 4004: outra aba assumiu.
      if (e.code === 4004 || e.code === 4003 || e.code === 4009) {
        this.wanted = false;
        this.setStatus("offline");
        return;
      }
      if (!this.wanted) {
        this.setStatus("idle");
        return;
      }
      const delay = Math.min(8000, 500 * 2 ** this.retry++);
      this.setStatus("reconnecting");
      // 4001: o servidor recusou o token (expirado ou revogado). Renova pelo cookie antes de tentar de novo;
      // se a renovação falhar, a própria API desloga (sessão realmente encerrada).
      this.retryTimer = window.setTimeout(() => void (e.code === 4001 ? api.refresh().then((r) => { if (r && this.wanted) void this.open(); }) : this.open()), delay);
    };
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = window.setInterval(() => this.send({ t: "ping", n: Math.floor(performance.now()) }), 2000);
  }
  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  disconnect() {
    this.wanted = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close(1000);
    this.ws = null;
    this.setStatus("idle");
  }

  send(m: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  queue(mode: QueueMode, loadout: string[], ranked = false) {
    this.send({ t: "queue", mode, loadout, ...(ranked ? { ranked: true } : {}) });
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  }
  onStatus(l: (s: SocketStatus) => void) {
    this.statusListeners.add(l);
    return () => void this.statusListeners.delete(l);
  }
}

export const gameSocket = new GameSocket();

// Só em desenvolvimento: usado pelos testes E2E para provar que o servidor recusa pedidos que a tela não deixa fazer.
if (import.meta.env.DEV) (window as unknown as { __vantaSocket: GameSocket }).__vantaSocket = gameSocket;
