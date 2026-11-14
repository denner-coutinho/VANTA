import type { Redis } from "ioredis";

/**
 * Proteção contra força bruta no login, em duas camadas (Redis):
 *  • por conta+IP: 5 falhas em 15 min → bloqueio de 15 min para aquele IP naquela conta;
 *  • por conta (qualquer IP): 20 falhas em 1 h → bloqueio de 1 h (ataque distribuído).
 * Um login bem-sucedido zera o contador conta+IP.
 */
export class LoginThrottle {
  static readonly PAIR_LIMIT = 5;
  static readonly PAIR_WINDOW_SEC = 15 * 60;
  static readonly ACCOUNT_LIMIT = 20;
  static readonly ACCOUNT_WINDOW_SEC = 60 * 60;

  constructor(private readonly redis: Redis) {}

  private pairKey(id: string, ip: string) {
    return `login:fail:pair:${id}:${ip}`;
  }
  private accountKey(id: string) {
    return `login:fail:acct:${id}`;
  }

  /** Retorna segundos restantes de bloqueio, ou 0 se liberado. */
  async lockedFor(identifier: string, ip: string): Promise<number> {
    const id = identifier.toLowerCase();
    const [pair, acct] = await this.redis.mget(this.pairKey(id, ip), this.accountKey(id));
    if (Number(pair ?? 0) >= LoginThrottle.PAIR_LIMIT) return Math.max(1, await this.redis.ttl(this.pairKey(id, ip)));
    if (Number(acct ?? 0) >= LoginThrottle.ACCOUNT_LIMIT) return Math.max(1, await this.redis.ttl(this.accountKey(id)));
    return 0;
  }

  async registerFailure(identifier: string, ip: string): Promise<void> {
    const id = identifier.toLowerCase();
    await this.redis
      .multi()
      .incr(this.pairKey(id, ip))
      .expire(this.pairKey(id, ip), LoginThrottle.PAIR_WINDOW_SEC, "NX")
      .incr(this.accountKey(id))
      .expire(this.accountKey(id), LoginThrottle.ACCOUNT_WINDOW_SEC, "NX")
      .exec();
  }

  async registerSuccess(identifier: string, ip: string): Promise<void> {
    await this.redis.del(this.pairKey(identifier.toLowerCase(), ip));
  }
}
