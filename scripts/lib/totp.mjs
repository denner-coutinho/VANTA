// TOTP (RFC 6238) para os E2Es: faz o papel do app autenticador do celular.
import { createHmac } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function decode(s) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of s.replace(/[\s=]/g, "").toUpperCase()) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
/** Código do passo de 30 s em `offset` passos a partir de agora. */
export function totp(secret, offset = 0) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000) + offset));
  const h = createHmac("sha1", decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1e6).padStart(6, "0");
}
/** Espera o próximo passo de 30 s (o servidor não aceita o mesmo código duas vezes). */
export async function nextTotp(secret) {
  await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 300));
  return totp(secret);
}
