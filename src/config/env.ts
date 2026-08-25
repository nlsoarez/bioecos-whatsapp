import "dotenv/config";
import { z } from "zod";

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  ADMIN_CORS_ORIGINS: z.string().default(""),
  DASHBOARD_USERNAME: z.string().min(3).default("admin"),
  DASHBOARD_PASSWORD: z.string().min(12).default("change-this-password"),
  DASHBOARD_SESSION_SECRET: z.string().min(32).default("change-this-session-secret-32-chars"),
  DASHBOARD_SESSION_TTL_MINUTES: z.coerce.number().int().min(15).max(1_440).default(480),
  RUNTIME_SECRETS_PATH: z.string().min(1).default("./data/runtime-secrets.json"),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: booleanString,
  BIOECOS_SITE_URL: z.url().default("https://www.bioecoscursos.com.br/"),
  INTEGRAL_GIFT_ENABLED: booleanString,
  AUTOMATION_TIMEZONE: z.string().default("America/Sao_Paulo"),
  AUTOMATION_START_HOUR: z.coerce.number().int().min(0).max(23).default(0),
  AUTOMATION_END_HOUR: z.coerce.number().int().min(1).max(24).default(24),
  AUTOMATION_MODE: z.literal("hybrid").default("hybrid"),
  FOLLOWUP_WORKER_INTERVAL_MS: z.coerce.number().int().min(60_000).default(300_000),
  AI_PROVIDER: z.enum(["openai"]).default("openai"),
  AI_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  AI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
  PUBLIC_API_URL: z.string().default(""),
  EVOLUTION_API_VERSION: z.literal("2").default("2"),
  EVOLUTION_API_URL: z.url(),
  EVOLUTION_API_KEY: z.string().default(""),
  EVOLUTION_INSTANCE_NAME: z.string().min(1),
  EVOLUTION_WEBHOOK_SECRET: z.string().default(""),
  EVOLUTION_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  EVOLUTION_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(3),
  ADMIN_API_KEY: z.string().min(12),
  PII_ENCRYPTION_KEY: z.string().default(""),
}).superRefine((env, context) => {
  if (env.NODE_ENV !== "production") return;
  for (const key of ["EVOLUTION_API_KEY", "EVOLUTION_WEBHOOK_SECRET", "PII_ENCRYPTION_KEY", "DASHBOARD_PASSWORD", "DASHBOARD_SESSION_SECRET"] as const) {
    if (!env[key]) context.addIssue({ code: "custom", path: [key], message: `${key} é obrigatória em produção` });
  }
  if (env.DASHBOARD_PASSWORD === "change-this-password") {
    context.addIssue({ code: "custom", path: ["DASHBOARD_PASSWORD"], message: "DASHBOARD_PASSWORD deve ser alterada em produção" });
  }
  if (env.DASHBOARD_SESSION_SECRET === "change-this-session-secret-32-chars") {
    context.addIssue({ code: "custom", path: ["DASHBOARD_SESSION_SECRET"], message: "DASHBOARD_SESSION_SECRET deve ser alterada em produção" });
  }
});

export type Env = z.infer<typeof schema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(input);
}
