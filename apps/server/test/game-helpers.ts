import { WebSocket } from "ws";
import type { ServerMessage } from "@vanta/shared";

/** Cliente WebSocket de teste: guarda as mensagens e espera por tipo. */
export class TestClient {
  ws: WebSocket;
  msgs: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: Array<() => void> = [];
  constructor(url: string, origin?: string) {
    this.ws = new WebSocket(url, origin ? { headers: { origin } } : undefined);
    this.ws.on("message", (d) => {
      this.msgs.push(JSON.parse(d.toString()));
      this.waiters.splice(0).forEach((w) => w());
    });
    this.ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
      this.waiters.splice(0).forEach((w) => w());
    });
    this.ws.on("error", () => {});
  }
  open() {
    return new Promise<void>((res, rej) => {
      if (this.ws.readyState === WebSocket.OPEN) return res();
      this.ws.once("open", () => res());
      this.ws.once("error", rej);
      this.ws.once("unexpected-response", () => rej(new Error("rejeitado")));
    });
  }
  send(o: unknown) {
    this.ws.send(JSON.stringify(o));
  }
  async waitFor<T extends ServerMessage["t"]>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 3000): Promise<Extract<ServerMessage, { t: T }>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = this.msgs.find((m) => m.t === t && pred(m as Extract<ServerMessage, { t: T }>));
      if (found) return found as Extract<ServerMessage, { t: T }>;
      if (this.closed) throw new Error(`conexão fechada (${this.closed.code} ${this.closed.reason}) esperando ${t}`);
      if (Date.now() > deadline) throw new Error(`timeout esperando ${t}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  async waitClosed(ms = 3000) {
    const deadline = Date.now() + ms;
    while (!this.closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    return this.closed;
  }
  close() {
    this.ws.close();
  }
}
