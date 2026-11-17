import { z } from "zod";

/** Nome de jogador: 3–16 caracteres, letras, números, _ e -. Único (case-insensitive). */
export const usernameSchema = z
  .string()
  .trim()
  .min(3, "O nome de jogador precisa ter pelo menos 3 caracteres.")
  .max(16, "O nome de jogador pode ter no máximo 16 caracteres.")
  .regex(/^[A-Za-z0-9_-]+$/, "Use apenas letras, números, _ e -.");

export const emailSchema = z.string().trim().toLowerCase().max(254).email("E-mail inválido.");

/** Senha: 10–128 caracteres, com pelo menos uma letra e um número. */
export const passwordSchema = z
  .string()
  .min(10, "A senha precisa ter pelo menos 10 caracteres.")
  .max(128, "A senha pode ter no máximo 128 caracteres.")
  .regex(/[A-Za-z]/, "A senha precisa conter pelo menos uma letra.")
  .regex(/[0-9]/, "A senha precisa conter pelo menos um número.");

export const registerSchema = z.object({
  username: usernameSchema,
  email: emailSchema,
  password: passwordSchema,
  acceptTerms: z.literal(true, { error: "Você precisa aceitar os Termos de Uso." }),
  birthDate: z.iso.date({ error: "Data de nascimento inválida." }),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  /** E-mail ou nome de jogador. */
  identifier: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Código de 6 dígitos do app autenticador. */
export const totpCodeSchema = z.string().trim().regex(/^\d{6}$/, "Digite os 6 números do app autenticador.");
/** Código do app (6 dígitos) ou de recuperação (XXXXX-XXXXX). */
export const mfaCodeSchema = z.string().trim().min(6).max(20).regex(/^(\d{6}|[A-Za-z0-9]{5}-?[A-Za-z0-9]{5})$/, "Código inválido.");
export const loginMfaSchema = z.object({ mfaToken: z.string().min(20).max(200), code: mfaCodeSchema });
export const mfaSetupSchema = z.object({ password: z.string().min(1).max(128) });
export const mfaEnableSchema = z.object({ code: totpCodeSchema });
export const mfaDisableSchema = z.object({ password: z.string().min(1).max(128), code: mfaCodeSchema });
export const mfaRegenerateSchema = z.object({ code: totpCodeSchema });

export const forgotPasswordSchema = z.object({ email: emailSchema });
export const resetPasswordSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const verifyEmailSchema = z.object({ token: z.string().min(20).max(200) });

/** Idade mínima para criar conta (ECA/LGPD: menores de 13 não podem criar conta sozinhos). */
export const MIN_ACCOUNT_AGE = 13;

export function ageFromBirthDate(birthDate: string, now = new Date()): number {
  const b = new Date(`${birthDate}T00:00:00Z`);
  let age = now.getUTCFullYear() - b.getUTCFullYear();
  const m = now.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < b.getUTCDate())) age--;
  return age;
}
