import argon2 from "argon2";

export class PasswordHasher {
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly memoryCost: number) {}

  hash(password: string): Promise<string> {
    // Argon2id com parâmetros recomendados pela OWASP (m=19 MiB, t=2, p=1).
    return argon2.hash(password, { type: argon2.argon2id, memoryCost: this.memoryCost, timeCost: 2, parallelism: 1 });
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  /** Executa uma verificação falsa para que "usuário inexistente" leve o mesmo tempo que "senha errada". */
  async verifyDummy(password: string): Promise<void> {
    this.dummyHash ??= this.hash("dummy-password-for-timing-1");
    await this.verify(await this.dummyHash, password);
  }
}
