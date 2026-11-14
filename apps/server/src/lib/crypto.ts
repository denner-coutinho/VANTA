import { createHash, randomBytes } from "node:crypto";

/** Token aleatório de 256 bits, seguro para URL. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Tokens de alta entropia são armazenados como SHA-256 (não precisam de hash lento). */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
