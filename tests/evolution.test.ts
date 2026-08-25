import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { EvolutionService, normalizePhone, parseEvolutionWebhook } from "../src/services/evolution.service.js";

describe("Evolution webhook v2", () => {
  it("normaliza e extrai MESSAGES_UPSERT", () => {
    const result = parseEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { id: "ABC123", remoteJid: "5521971970274@s.whatsapp.net", fromMe: false },
        pushName: "Cliente",
        message: { conversation: "Olá" },
        messageTimestamp: 1_700_000_000,
      },
    });
    expect(result?.externalMessageId).toBe("ABC123");
    expect(result?.phone).toBe("5521971970274");
    expect(result?.content).toBe("Olá");
  });

  it("ignora mensagens próprias e grupos", () => {
    expect(parseEvolutionWebhook({ data: { key: { id: "1", remoteJid: "55@g.us", fromMe: false }, message: { conversation: "x" } } })).toBeNull();
    expect(parseEvolutionWebhook({ data: { key: { id: "2", remoteJid: "5521971970274@s.whatsapp.net", fromMe: true }, message: { conversation: "x" } } })).toBeNull();
  });

  it("rejeita telefone inválido", () => {
    expect(() => normalizePhone("123")).toThrow("inválido");
  });

  it("configura e confirma o recebimento com segredo no cabeçalho", async () => {
    const env = loadEnv({
      DATABASE_URL: "postgresql://test:test@localhost/test",
      EVOLUTION_API_URL: "https://evolution.example.com",
      EVOLUTION_API_KEY: "evolution-secret",
      EVOLUTION_INSTANCE_NAME: "bioecos",
      EVOLUTION_WEBHOOK_SECRET: "webhook-secret",
      PUBLIC_API_URL: "https://api.example.com/bioecos",
      ADMIN_API_KEY: "admin-secret-key",
    });
    let configuredBody: Record<string, unknown> | null = null;
    const request = async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        configuredBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ ok: true }), { status: 201 });
      }
      return new Response(JSON.stringify({
        enabled: true,
        url: "https://api.example.com/bioecos/webhooks/evolution",
        events: ["MESSAGES_UPSERT"],
      }), { status: 200 });
    };
    const evolution = new EvolutionService(env, request as typeof fetch);
    await expect(evolution.configureWebhook()).resolves.toMatchObject({ healthy: true });
    expect(configuredBody).toMatchObject({ webhook: { headers: { "x-webhook-secret": "webhook-secret" } } });
  });

  it("envia texto no formato aceito pela Evolution v2 instalada", async () => {
    const env = loadEnv({
      DATABASE_URL: "postgresql://test:test@localhost/test",
      EVOLUTION_API_URL: "https://evolution.example.com",
      EVOLUTION_API_KEY: "evolution-secret",
      EVOLUTION_INSTANCE_NAME: "bioecos",
      ADMIN_API_KEY: "admin-secret-key",
    });
    let body: Record<string, unknown> | null = null;
    const request = async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ key: { id: "sent-1" } }), { status: 201 });
    };
    const evolution = new EvolutionService(env, request as typeof fetch);
    await expect(evolution.sendText("5521971970274", "Olá")).resolves.toMatchObject({ externalMessageId: "sent-1" });
    expect(body).toEqual({ number: "5521971970274", text: "Olá" });
  });
});
