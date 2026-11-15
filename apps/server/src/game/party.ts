import { randomUUID } from "node:crypto";
import { PARTY_INVITE_TTL_MS, PARTY_MAX, type PartyView } from "@vanta/shared";

export interface Party {
  id: string;
  leaderId: string;
  members: string[];
  /** Convidado → instante em que o convite expira. */
  invites: Map<string, number>;
}

/** Estado dos grupos (só memória do processo de jogo; um grupo some quando fica com uma pessoa só). */
export class PartyManager {
  private parties = new Map<string, Party>();
  private byUser = new Map<string, string>();

  of(userId: string): Party | null {
    const id = this.byUser.get(userId);
    return id ? (this.parties.get(id) ?? null) : null;
  }

  get(id: string) {
    return this.parties.get(id) ?? null;
  }

  /** Grupo do usuário, criando um com ele como líder se ainda não tiver. */
  ensure(userId: string): Party {
    const existing = this.of(userId);
    if (existing) return existing;
    const p: Party = { id: randomUUID(), leaderId: userId, members: [userId], invites: new Map() };
    this.parties.set(p.id, p);
    this.byUser.set(userId, p.id);
    return p;
  }

  pruneInvites(p: Party, now = Date.now()) {
    for (const [id, exp] of p.invites) if (exp <= now) p.invites.delete(id);
  }

  isFull(p: Party) {
    return p.members.length >= PARTY_MAX;
  }

  invite(p: Party, userId: string, now = Date.now()) {
    const expiresAt = now + PARTY_INVITE_TTL_MS;
    p.invites.set(userId, expiresAt);
    return expiresAt;
  }

  /** Consome um convite válido; null se não existe ou expirou. */
  takeInvite(partyId: string, userId: string, now = Date.now()): Party | null {
    const p = this.parties.get(partyId);
    if (!p) return null;
    const exp = p.invites.get(userId);
    p.invites.delete(userId);
    if (!exp || exp <= now) return null;
    return p;
  }

  join(p: Party, userId: string) {
    if (!p.members.includes(userId)) p.members.push(userId);
    this.byUser.set(userId, p.id);
  }

  /**
   * Tira alguém do grupo. Se o líder sai, o próximo vira líder.
   * Se sobra só uma pessoa e nenhum convite pendente, o grupo é desfeito.
   * Devolve o grupo restante (ou null) e quem ficou sem grupo por causa da dissolução.
   */
  remove(userId: string, now = Date.now()): { party: Party | null; orphaned: string[] } {
    const p = this.of(userId);
    this.byUser.delete(userId);
    if (!p) return { party: null, orphaned: [] };
    p.members = p.members.filter((m) => m !== userId);
    if (p.leaderId === userId && p.members.length) p.leaderId = p.members[0]!;
    return this.dissolveIfAlone(p, now);
  }

  dissolveIfAlone(p: Party, now = Date.now()): { party: Party | null; orphaned: string[] } {
    this.pruneInvites(p, now);
    if (p.members.length > 1 || (p.members.length === 1 && p.invites.size > 0)) return { party: p, orphaned: [] };
    const orphaned = [...p.members];
    for (const m of p.members) this.byUser.delete(m);
    this.parties.delete(p.id);
    return { party: null, orphaned };
  }

  view(p: Party, info: (id: string) => { username: string; character: string; online: boolean }, now = Date.now()): PartyView {
    this.pruneInvites(p, now);
    return { id: p.id, leaderId: p.leaderId, members: p.members.map((id) => ({ id, ...info(id) })), invited: [...p.invites.keys()] };
  }
}
