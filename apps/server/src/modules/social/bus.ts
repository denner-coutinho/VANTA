import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import type { SocialEvent } from "@vanta/shared";

export type SocialHandler = (to: string, ev: SocialEvent) => void;

/**
 * Barramento de eventos sociais entre a API (onde mudam amizades e bloqueios)
 * e os servidores de jogo (onde os jogadores estão conectados).
 */
export interface SocialBus {
  publish(to: string[], ev: SocialEvent): Promise<void>;
  subscribe(handler: SocialHandler): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

/** Em memória: API e servidor de jogo no mesmo processo (testes). */
export class MemorySocialBus implements SocialBus {
  private ee = new EventEmitter();
  async publish(to: string[], ev: SocialEvent) {
    for (const id of to) this.ee.emit("ev", id, ev);
  }
  async subscribe(handler: SocialHandler) {
    this.ee.on("ev", handler);
    return async () => void this.ee.off("ev", handler);
  }
  async close() {
    this.ee.removeAllListeners();
  }
}

/**
 * Redis Pub/Sub: funciona com vários processos de jogo. A entrega é "no máximo uma vez":
 * se ninguém estiver ouvindo, o evento se perde — por isso o cliente sempre relê a lista
 * de amigos pela API ao abrir o painel; o evento só adianta a atualização.
 */
export class RedisSocialBus implements SocialBus {
  private pub: Redis;
  private sub: Redis | null = null;
  constructor(private url: string, private channel: string) {
    this.pub = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: false });
  }
  async publish(to: string[], ev: SocialEvent) {
    if (!to.length) return;
    await this.pub.publish(this.channel, JSON.stringify({ to, ev }));
  }
  async subscribe(handler: SocialHandler) {
    if (!this.sub) {
      this.sub = new Redis(this.url, { maxRetriesPerRequest: null });
      await this.sub.subscribe(this.channel);
    }
    const sub = this.sub;
    const onMessage = (ch: string, raw: string) => {
      if (ch !== this.channel) return;
      try {
        const { to, ev } = JSON.parse(raw) as { to: string[]; ev: SocialEvent };
        for (const id of to) handler(id, ev);
      } catch {
        /* mensagem malformada: ignora */
      }
    };
    sub.on("message", onMessage);
    return async () => void sub.off("message", onMessage);
  }
  async close() {
    this.pub.disconnect();
    this.sub?.disconnect();
  }
}
