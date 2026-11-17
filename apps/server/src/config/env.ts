import { z } from "zod";

/** "true"/"1"/"yes" → true. (z.coerce.boolean transformaria "false" em true.) */
const bool = (d: boolean) => z.preprocess((v) => (v === undefined || v === "" ? d : typeof v === "boolean" ? v : ["true", "1", "yes", "sim"].includes(String(v).trim().toLowerCase())), z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default("0.0.0.0"),
  GAME_PORT: z.coerce.number().int().default(4100),
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
  /**
   * Atrás de proxy: número de proxies confiáveis na frente (ex.: 1 = só o nginx). "true" confia em
   * todos e deixa o IP falsificável pelo cabeçalho X-Forwarded-For; prefira o número.
   */
  TRUST_PROXY: z.preprocess((v) => (v === undefined || v === "" ? false : /^\d+$/.test(String(v)) ? Number(v) : ["true", "1", "yes"].includes(String(v).toLowerCase())), z.union([z.boolean(), z.number().int().min(0).max(10)])),
  /** Só para testar o pacote de produção em http://localhost. Em produção real fica false (exige https). */
  ALLOW_INSECURE_HTTP: bool(false),
  REDIS_KEY_PREFIX: z.string().default("vanta:"),
  /** Limite geral de requisições por IP por minuto (rotas sensíveis têm limites próprios, menores). */
  RATE_LIMIT_PER_MIN: z.coerce.number().int().min(10).max(1_000_000).default(300),
  /** Libera GET /metrics (Prometheus) com "Authorization: Bearer <token>". Vazio: endpoint desligado. */
  METRICS_TOKEN: z.string().optional().default(""),
  /** Caminho público das rotas /auth, como o NAVEGADOR as vê (o cliente acessa a API por /api). */
  REFRESH_COOKIE_PATH: z.string().startsWith("/").default("/api/auth"),
  /** Stripe (Fase 6). Sem as duas chaves, a compra de VANTA COINS fica desativada (nunca simulada). */
  STRIPE_SECRET_KEY: z.string().optional().default("").refine((k) => !k || /^(sk|rk)_(test|live)_/.test(k), "STRIPE_SECRET_KEY deve começar com sk_test_, sk_live_, rk_test_ ou rk_live_"),
  STRIPE_WEBHOOK_SECRET: z.string().optional().default("").refine((k) => !k || k.startsWith("whsec_"), "STRIPE_WEBHOOK_SECRET deve começar com whsec_"),
});

export type AppConfig = z.infer<typeof envSchema> & { corsOrigins: string[]; isProd: boolean };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === "production") {
    const problems = productionProblems(c);
    if (problems.length) throw new Error(`Configuração insegura para produção:\n${problems.map((p) => `  • ${p}`).join("\n")}`);
  }
  if (!!c.STRIPE_SECRET_KEY !== !!c.STRIPE_WEBHOOK_SECRET) {
    throw new Error("Configure STRIPE_SECRET_KEY e STRIPE_WEBHOOK_SECRET juntas (ou nenhuma, para desativar pagamentos).");
  }
  return {
    ...c,
    corsOrigins: c.CORS_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean),
    isProd: c.NODE_ENV === "production",
  };
}

/** O que impede subir em produção. Exportado para teste. */
export function productionProblems(c: z.infer<typeof envSchema>): string[] {
  const out: string[] = [];
  const secret = c.JWT_ACCESS_SECRET;
  if (secret.startsWith("troque-este") || secret.includes("segredo-de-teste")) out.push("JWT_ACCESS_SECRET é o valor de exemplo: gere um novo.");
  if (new Set(secret).size < 16) out.push("JWT_ACCESS_SECRET tem pouca variedade de caracteres: gere um aleatório (48 bytes).");
  try {
    const db = new URL(c.DATABASE_URL);
    if (["vanta", "postgres", "password", ""].includes(decodeURIComponent(db.password))) out.push("DATABASE_URL usa a senha de desenvolvimento.");
  } catch { /* já validado como URL */ }
  if (!c.PUBLIC_APP_URL.startsWith("https://") && !c.ALLOW_INSECURE_HTTP) out.push("PUBLIC_APP_URL precisa ser https:// (ou ALLOW_INSECURE_HTTP=true só para teste local).");
  if (c.CORS_ORIGINS.split(",").some((o) => o.trim() === "*")) out.push("CORS_ORIGINS não pode ser *.");
  if (c.METRICS_TOKEN && (c.METRICS_TOKEN.length < 24 || new Set(c.METRICS_TOKEN).size < 10)) out.push("METRICS_TOKEN curto demais: gere um aleatório (24 bytes ou mais).");
  if (!c.SMTP_HOST) out.push("SMTP_HOST é obrigatório (sem ele os links de e-mail iriam para o log).");
  return out;
}
