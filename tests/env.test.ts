import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

const productionEnv = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://bioecos:secret@postgres:5432/bioecos",
  EVOLUTION_API_URL: "https://evolution.example.com",
  EVOLUTION_API_KEY: "evolution-secret",
  EVOLUTION_INSTANCE_NAME: "bioecos",
  EVOLUTION_WEBHOOK_SECRET: "webhook-secret",
  ADMIN_API_KEY: "admin-secret-key",
  PII_ENCRYPTION_KEY: "pii-secret",
  DASHBOARD_PASSWORD: "dashboard-password-secret",
  DASHBOARD_SESSION_SECRET: "dashboard-session-secret-at-least-32-chars",
};

describe("configuração de produção", () => {
  it("permite instalar sem a chave OpenAI controlada pelo usuário", () => {
    const env = loadEnv(productionEnv);
    expect(env.OPENAI_API_KEY).toBe("");
  });

  it("continua exigindo os segredos operacionais da aplicação", () => {
    expect(() => loadEnv({ ...productionEnv, EVOLUTION_API_KEY: "" }))
      .toThrow(/EVOLUTION_API_KEY é obrigatória/);
  });
});
