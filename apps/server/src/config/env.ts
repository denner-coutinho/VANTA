import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  PUBLIC_APP_URL: z.string().url().default("http://localhost:5173"),
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET precisa ter pelo menos 32 caracteres"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  MAIL_FROM: z.string().default("VANTA: FRONTLINE <no-reply@vanta.gg>"),
  /** Custo de memória do Argon2id em KiB (OWASP: mínimo 19 MiB). Reduzido só nos testes. */
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(1024).default(19456),
  /** Atrás de proxy reverso (nginx, load balancer), confie no X-Forwarded-For. */
  TRUST_PROXY: z.coerce.boolean().default(false),
  REDIS_KEY_PREFIX: z.string().default("vanta:"),
  /** Caminho público das rotas /auth, como o NAVEGADOR as vê (o cliente acessa a API por /api). */
  REFRESH_COOKIE_PATH: z.string().startsWith("/").default("/api/auth"),
});

export type AppConfig = z.infer<typeof envSchema> & { corsOrigins: string[]; isProd: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === "production" && c.JWT_ACCESS_SECRET.startsWith("troque-este")) {
    throw new Error("JWT_ACCESS_SECRET padrão não pode ser usado em produção.");
  }
  return {
    ...c,
    corsOrigins: c.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    isProd: c.NODE_ENV === "production",
  };
}
