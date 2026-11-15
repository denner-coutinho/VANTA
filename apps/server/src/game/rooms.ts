import { MODES, ROOM_SPECTATOR_MAX, roomMaxPlayers, type RoomListItem, type RoomSettings, type RoomTeam, type RoomView } from "@vanta/shared";
import type { Match } from "./match.js";

export interface RoomMember {
  userId: string;
  team: RoomTeam;
  joinedAt: number;
}

export interface Room {
  /** Id da linha Room no banco. */
  id: string;
  code: string;
  ownerId: string;
  settings: RoomSettings;
  passwordHash: string | null;
  locked: boolean;
  members: Map<string, RoomMember>;
  /** Removidos pelo dono: não voltam nem com o código. */
  banned: Set<string>;
  /** Convidado → expiração. Convite dispensa a senha (não dispensa sala trancada nem banimento). */
  invites: Map<string, number>;
  match: Match | null;
}

export type RoomError = { code: string; message: string };
const err = (code: string, message: string): RoomError => ({ code, message });

/**
 * Estado das salas personalizadas (memória do processo de jogo; o banco guarda o registro).
 * Só regras, sem rede nem banco: o GameServer faz a parte de I/O.
 */
export class RoomManager {
  private rooms = new Map<string, Room>();
  private byUser = new Map<string, string>();
  private joinSeq = 0;

  of(userId: string): Room | null {
    const code = this.byUser.get(userId);
    return code ? (this.rooms.get(code) ?? null) : null;
  }

  byCode(code: string): Room | null {
    return this.rooms.get(code) ?? null;
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  create(id: string, code: string, ownerId: string, settings: RoomSettings, passwordHash: string | null): Room {
    const room: Room = { id, code, ownerId, settings, passwordHash, locked: false, members: new Map(), banned: new Set(), invites: new Map(), match: null };
    this.rooms.set(code, room);
    this.addMember(room, ownerId, 0);
    return room;
  }

  players(room: Room, team?: 0 | 1): RoomMember[] {
    return [...room.members.values()].filter((m) => (team === undefined ? m.team !== null : m.team === team));
  }

  spectators(room: Room): RoomMember[] {
    return [...room.members.values()].filter((m) => m.team === null);
  }

  private addMember(room: Room, userId: string, team: RoomTeam) {
    room.members.set(userId, { userId, team, joinedAt: ++this.joinSeq });
    this.byUser.set(userId, room.code);
  }

  /** Time com vaga (o menor primeiro) ou null se os dois estão cheios. */
  private openTeam(room: Room): 0 | 1 | null {
    const size = MODES[room.settings.mode].teamSize;
    const a = this.players(room, 0).length;
    const b = this.players(room, 1).length;
    if (a >= size && b >= size) return null;
    if (a >= size) return 1;
    if (b >= size) return 0;
    return a <= b ? 0 : 1;
  }

  /**
   * Regras de entrada (a senha é conferida antes, pelo servidor). Quem entra com a partida em
   * andamento só pode assistir.
   */
  join(room: Room, userId: string, opts: { spectate: boolean; invited: boolean }, now = Date.now()): RoomTeam | RoomError {
    if (room.members.has(userId)) return room.members.get(userId)!.team;
    if (room.banned.has(userId)) return err("ROOM_BANNED", "Você foi removido desta sala pelo dono.");
    if (room.locked) return err("ROOM_LOCKED", "A sala está trancada.");
    const canSpectate = room.settings.allowSpectators && this.spectators(room).length < ROOM_SPECTATOR_MAX;
    let team: RoomTeam;
    if (opts.spectate || room.match) {
      if (!room.settings.allowSpectators) return err(room.match ? "ROOM_IN_MATCH" : "ROOM_NO_SPECTATORS", room.match ? "A partida já começou e esta sala não aceita espectadores." : "Esta sala não aceita espectadores.");
      if (!canSpectate) return err("ROOM_FULL", "Limite de espectadores atingido.");
      team = null;
    } else {
      team = this.openTeam(room);
      if (team === null) {
        if (!canSpectate) return err("ROOM_FULL", "A sala está cheia.");
      }
    }
    room.invites.delete(userId);
    this.pruneInvites(room, now);
    this.addMember(room, userId, team);
    return team;
  }

  pruneInvites(room: Room, now = Date.now()) {
    for (const [id, exp] of room.invites) if (exp <= now) room.invites.delete(id);
  }

  hasInvite(room: Room, userId: string, now = Date.now()) {
    const exp = room.invites.get(userId);
    return exp !== undefined && exp > now;
  }

  /**
   * Remove alguém. Se era o dono, passa para quem entrou primeiro (jogador antes de espectador).
   * Devolve `closed` quando a sala ficou vazia.
   */
  leave(room: Room, userId: string): { closed: boolean; newOwner: string | null } {
    if (!room.members.delete(userId)) return { closed: false, newOwner: null };
    this.byUser.delete(userId);
    if (room.members.size === 0) {
      this.rooms.delete(room.code);
      return { closed: true, newOwner: null };
    }
    if (room.ownerId === userId) {
      const next = [...room.members.values()].sort((a, b) => Number(a.team === null) - Number(b.team === null) || a.joinedAt - b.joinedAt)[0]!;
      room.ownerId = next.userId;
      return { closed: false, newOwner: next.userId };
    }
    return { closed: false, newOwner: null };
  }

  /** Fecha a sala: devolve quem estava nela. */
  close(room: Room): string[] {
    const ids = [...room.members.keys()];
    for (const id of ids) this.byUser.delete(id);
    room.members.clear();
    this.rooms.delete(room.code);
    return ids;
  }

  setTeam(room: Room, userId: string, team: RoomTeam): RoomError | null {
    const m = room.members.get(userId);
    if (!m) return err("ROOM_NOT_MEMBER", "Este jogador não está na sala.");
    if (room.match) return err("ROOM_IN_MATCH", "Espere a partida acabar.");
    if (m.team === team) return null;
    if (team === null) {
      if (!room.settings.allowSpectators) return err("ROOM_NO_SPECTATORS", "Esta sala não aceita espectadores.");
      if (this.spectators(room).length >= ROOM_SPECTATOR_MAX) return err("ROOM_FULL", "Limite de espectadores atingido.");
    } else if (this.players(room, team).length >= MODES[room.settings.mode].teamSize) {
      return err("ROOM_TEAM_FULL", "Este time está cheio.");
    }
    m.team = team;
    return null;
  }

  /** Confere se as novas regras cabem em quem já está na sala. */
  checkSettings(room: Room, next: RoomSettings): RoomError | null {
    if (room.match) return err("ROOM_IN_MATCH", "Espere a partida acabar para mudar as regras.");
    const size = MODES[next.mode].teamSize;
    if (this.players(room, 0).length > size || this.players(room, 1).length > size) return err("ROOM_TOO_MANY", "Há jogadores demais em um time para esse modo. Mova alguém antes.");
    if (!next.allowSpectators && this.spectators(room).length) return err("ROOM_HAS_SPECTATORS", "Tire os espectadores (ou mova-os para um time) antes de desativar.");
    return null;
  }

  canStart(room: Room): RoomError | null {
    if (room.match) return err("ROOM_IN_MATCH", "A partida já está em andamento.");
    if (!this.players(room, 0).length || !this.players(room, 1).length) return err("ROOM_NEED_PLAYERS", "Cada time precisa de pelo menos um jogador.");
    return null;
  }

  view(room: Room, info: (id: string) => { username: string; character: string; online: boolean }): RoomView {
    return {
      id: room.id,
      code: room.code,
      ownerId: room.ownerId,
      settings: room.settings,
      hasPassword: !!room.passwordHash,
      locked: room.locked,
      status: room.match && !room.match.isEnded ? "in_match" : "lobby",
      members: [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt).map((m) => ({ id: m.userId, team: m.team, ...info(m.userId) })),
      maxPlayers: roomMaxPlayers(room.settings.mode),
      matchId: room.match && !room.match.isEnded ? room.match.id : null,
    };
  }

  listItem(room: Room, ownerName: string): RoomListItem {
    return {
      code: room.code,
      name: room.settings.name,
      mode: room.settings.mode,
      map: room.settings.map,
      players: this.players(room).length,
      maxPlayers: roomMaxPlayers(room.settings.mode),
      spectators: this.spectators(room).length,
      status: room.match && !room.match.isEnded ? "in_match" : "lobby",
      ownerName,
      hasPassword: !!room.passwordHash,
      locked: room.locked,
    };
  }
}
