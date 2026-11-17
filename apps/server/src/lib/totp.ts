import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238, HMAC-SHA1, 30 s, 6 dígitos): o mesmo que Google Authenticator, Authy, 1Password,
 * Aegis e afins usam. Implementado aqui para não depender de biblioteca de terceiros na autenticação.
 */
export const TOTP_PERIOD = 30;
export const TOTP_DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("base32 inválido");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo novo: 20 bytes (160 bits, o tamanho recomendado pela RFC 4226). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const off = h[h.length - 1]! & 15;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const totpStep = (nowMs = Date.now()) => Math.floor(nowMs / 1000 / TOTP_PERIOD);

export function totp(secretB32: string, nowMs = Date.now()): string {
  return hotp(base32Decode(secretB32), totpStep(nowMs));
}

/**
 * Confere o código aceitando um passo antes e um depois (relógio do celular adiantado ou atrasado).
 * Devolve o passo que bateu (para impedir reuso do mesmo código) ou null.
 */
export function verifyTotp(secretB32: string, code: string, nowMs = Date.now(), window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = base32Decode(secretB32);
  const now = totpStep(nowMs);
  const given = Buffer.from(code);
  let hit: number | null = null;
  // Percorre a janela inteira sempre (tempo constante em relação a qual passo bateu).
  for (let s = now - window; s <= now + window; s++) {
    if (timingSafeEqual(Buffer.from(hotp(key, s)), given) && hit === null) hit = s;
  }
  return hit;
}

export function otpauthUrl(secretB32: string, account: string, issuer = "VANTA FRONTLINE"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/**
 * Cifra do segredo no banco (AES-256-GCM). Um vazamento do banco sozinho não entrega os segredos:
 * a chave fica só na configuração do servidor (MFA_ENCRYPTION_KEY).
 */
export class SecretBox {
  private readonly key: Buffer;
  constructor(material: string) {
    this.key = Buffer.from(hkdfSync("sha256", Buffer.from(material), Buffer.from("vanta-mfa-salt"), Buffer.from("vanta-mfa-v1"), 32));
  }
  seal(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
    return `v1.${iv.toString("base64url")}.${body.toString("base64url")}.${c.getAuthTag().toString("base64url")}`;
  }
  open(sealed: string): string {
    const [v, iv, body, tag] = sealed.split(".");
    if (v !== "v1" || !iv || !body || !tag) throw new Error("segredo cifrado inválido");
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  }
}

/** Códigos de recuperação: 10 caracteres (50 bits) em dois blocos, sem letras que confundem. */
const RC_ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function newRecoveryCode(): string {
  const b = randomBytes(10);
  let s = "";
  for (const x of b) s += RC_ALPHA[x & 31];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}
export const normalizeRecoveryCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");
