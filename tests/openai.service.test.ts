import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { OpenAIResponsesClient } from "../src/services/openai.service.js";

const env = loadEnv({
  DATABASE_URL: "postgresql://test:test@localhost/test",
  EVOLUTION_API_URL: "http://evolution:8080",
  EVOLUTION_INSTANCE_NAME: "bioecos",
  ADMIN_API_KEY: "admin-secret-key",
  AI_MODEL: "gpt-4.1-mini",
});

describe("diagnóstico de crédito OpenAI", () => {
  it("distingue falta de crédito de limite temporário", async () => {
    const request = async () => new Response(JSON.stringify({
      error: { type: "insufficient_quota", code: "insufficient_quota" },
    }), { status: 429 });
    const client = new OpenAIResponsesClient(env, request as typeof fetch, async () => "sk-test");
    await expect(client.testCredit()).resolves.toMatchObject({
      state: "insufficient_quota",
      message: "Sem crédito ou limite de gastos atingido",
    });
  });

  it("marca a chave como operacional quando uma resposta mínima funciona", async () => {
    const request = async () => new Response(JSON.stringify({ output_text: "OK" }), { status: 200 });
    const client = new OpenAIResponsesClient(env, request as typeof fetch, async () => "sk-test");
    await expect(client.testCredit()).resolves.toMatchObject({ state: "operational" });
  });
});
