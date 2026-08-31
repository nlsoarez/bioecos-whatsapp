import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { OpenAIResponsesClient } from "../src/services/openai.service.js";
import { InMemoryRepository } from "./support/in-memory.repository.js";

const env = loadEnv({
  DATABASE_URL: "postgresql://test:test@localhost/test",
  EVOLUTION_API_URL: "http://evolution:8080",
  EVOLUTION_INSTANCE_NAME: "bioecos",
  ADMIN_API_KEY: "admin-secret-key",
  AI_MODEL: "gpt-4.1-mini",
});

describe("diagnóstico de crédito OpenAI", () => {
  it("distingue chave ausente de chave inválida", async () => {
    const request = async () => {
      throw new Error("A OpenAI não deve ser consultada sem chave");
    };
    const client = new OpenAIResponsesClient(env, request as typeof fetch, async () => null);
    await expect(client.testCredit()).resolves.toMatchObject({
      state: "not_configured",
      message: "Chave OpenAI não configurada",
    });
  });

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
    let requestBody: Record<string, unknown> | undefined;
    const request = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ output_text: "OK" }), { status: 200 });
    };
    const client = new OpenAIResponsesClient(env, request as typeof fetch, async () => "sk-test");
    await expect(client.testCredit()).resolves.toMatchObject({ state: "operational" });
    expect(requestBody).toMatchObject({
      model: "gpt-4.1-mini",
      input: "Responda apenas OK.",
      max_output_tokens: 32,
      store: false,
    });
  });

  it("mostra a causa segura de uma requisição recusada sem expor a chave", async () => {
    const request = async () => new Response(JSON.stringify({
      error: {
        type: "invalid_request_error",
        message: "Invalid max_output_tokens; token sk-proj-sensitive must not leak",
      },
    }), { status: 400 });
    const client = new OpenAIResponsesClient(env, request as typeof fetch, async () => "sk-test");
    await expect(client.testCredit()).resolves.toMatchObject({
      state: "unavailable",
      message: "Solicitação OpenAI recusada: Invalid max_output_tokens; token [chave protegida] must not leak",
    });
  });
});

describe("continuidade da conversa OpenAI", () => {
  it("não duplica a mensagem atual dentro do histórico estruturado", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const request = async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ output_text: "Resposta coerente" }), { status: 200 });
    };
    const client = new OpenAIResponsesClient(env, request as typeof fetch, async () => "sk-test");
    await client.respond({
      prompt: "Responda com contexto.",
      context: new InMemoryRepository().context,
      recentMessages: [
        { direction: "outbound", content: "Qual é o objetivo?", timestamp: new Date("2026-08-27T12:00:00Z") },
        { direction: "inbound", content: "Trabalhar com isso", timestamp: new Date("2026-08-27T12:01:00Z") },
      ],
      userMessage: "Trabalhar com isso",
      knowledge: [],
      tools: { execute: async () => ({ ok: true }) },
    });
    const input = requestBody?.input as Array<{ content?: Array<{ text?: string }> }>;
    const structured = input[0]?.content?.[0]?.text ?? "";
    expect(structured.match(/Trabalhar com isso/g)).toHaveLength(1);
    expect(structured).toContain("Qual é o objetivo?");
    expect(requestBody?.temperature).toBe(0.2);
  });
});
