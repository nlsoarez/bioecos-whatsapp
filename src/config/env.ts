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
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: booleanString,
  BIOECOS_SITE_URL: z.url().default("https://www.bioecoscursos.com.br/"),
  INTEGRAL_GIFT_ENABLED: booleanString,
  AUTOMATION_TIMEZONE: z.string().default("America/Sao_Paulo"),
  AUTOMATION_START_HOUR: z.coerce.number().int().min(0).max(23).default(0),
  AUTOMATION_END_HOUR: z.coerce.number().int().min(1).max(24).default(24),
  AI_PROVIDER: z.enum(["openai"]).default("openai"),
  AI_MODEL: z.string().min(1).default("gpt-4.1-mini"),
  AI_EMBEDDING_MODEL: z.string().min(1).default("text-embedding-3-small"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.url().default("https://api.openai.com/v1"),
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
  for (const key of ["EVOLUTION_API_KEY", "EVOLUTION_WEBHOOK_SECRET", "PII_ENCRYPTION_KEY"] as const) {
    if (!env[key]) context.addIssue({ code: "custom", path: [key], message: `${key} é obrigatória em produção` });
  }
});

export type Env = z.infer<typeof schema>;

export function loadEnv(input: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(input);
}
