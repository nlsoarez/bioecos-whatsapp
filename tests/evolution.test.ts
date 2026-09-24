import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";
import { EvolutionService, normalizePhone, parseEvolutionOutboundWebhook, parseEvolutionWebhook } from "../src/services/evolution.service.js";

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

  it("rejeita conteúdo e identificadores excessivos antes da fila e da OpenAI", () => {
    const payload = (id: string, content: string) => ({
      event: "messages.upsert",
      data: {
        key: { id, remoteJid: "5521971970274@s.whatsapp.net", fromMe: false },
        pushName: "Cliente",
        message: { conversation: content },
        messageTimestamp: 1_700_000_000,
      },
    });
    expect(parseEvolutionWebhook(payload("bounded", "A".repeat(4_096)))?.content).toHaveLength(4_096);
    expect(parseEvolutionWebhook(payload("too-large", "A".repeat(4_097)))).toBeNull();
    expect(parseEvolutionWebhook(payload("I".repeat(201), "Olá"))).toBeNull();
    expect(parseEvolutionWebhook(payload("invalid\r\nid", "Olá"))).toBeNull();
    expect(parseEvolutionWebhook(payload("nul-content", "Olá\u0000mundo"))).toBeNull();
  });

  it("normaliza timestamp fora da faixa representável sem derrubar o webhook", () => {
    const result = parseEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { id: "invalid-date", remoteJid: "5521971970274@s.whatsapp.net", fromMe: false },
        message: { conversation: "Olá" },
        messageTimestamp: Number.MAX_VALUE,
      },
    });
    expect(result?.timestamp).toBeInstanceOf(Date);
    expect(Number.isNaN(result?.timestamp.getTime())).toBe(false);
  });

  it("separa mensagem própria para registrar intervenção humana", () => {
    const result = parseEvolutionOutboundWebhook({
      event: "messages.upsert",
      data: { key: { id: "manual-1", remoteJid: "5521971970274@s.whatsapp.net", fromMe: true },
        message: { conversation: "Atendimento manual" }, messageTimestamp: 1_700_000_000 },
    });
    expect(result).toMatchObject({ externalMessageId: "manual-1", phone: "5521971970274", content: "Atendimento manual" });
  });

  it("rejeita telefone inválido", () => {
    expect(() => normalizePhone("123")).toThrow("inválido");
  });

  it("converte máscaras brasileiras e DDI para o mesmo número canônico", () => {
    const canonical = "5521999999999";
    expect(normalizePhone("(21) 99999-9999")).toBe(canonical);
    expect(normalizePhone("21999999999")).toBe(canonical);
    expect(normalizePhone("+55 21 99999-9999")).toBe(canonical);
    expect(normalizePhone("5521999999999@s.whatsapp.net")).toBe(canonical);
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

  it("não mantém eco automatizado quando o envio falha definitivamente", async () => {
    const env = loadEnv({
      DATABASE_URL: "postgresql://test:test@localhost/test",
      EVOLUTION_API_URL: "https://evolution.example.com",
      EVOLUTION_API_KEY: "evolution-secret",
      EVOLUTION_INSTANCE_NAME: "bioecos",
      EVOLUTION_MAX_RETRIES: "0",
      ADMIN_API_KEY: "admin-secret-key",
    });
    const request = async () => new Response(JSON.stringify({ error: "offline" }), { status: 503 });
    const evolution = new EvolutionService(env, request as typeof fetch);
    await expect(evolution.sendText("5521971970274", "Falhou")).rejects.toThrow("503");
    expect(evolution.isAutomatedOutbound("5521971970274", "Falhou")).toBe(false);
  });

  it("não repete erro 4xx definitivo da Evolution", async () => {
    const env = loadEnv({
      DATABASE_URL: "postgresql://test:test@localhost/test",
      EVOLUTION_API_URL: "https://evolution.example.com",
      EVOLUTION_API_KEY: "evolution-secret",
      EVOLUTION_INSTANCE_NAME: "bioecos",
      EVOLUTION_MAX_RETRIES: "3",
      ADMIN_API_KEY: "admin-secret-key",
    });
    let requests = 0;
    const request = async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
    };
    const evolution = new EvolutionService(env, request as typeof fetch);
    await expect(evolution.sendText("5521971970274", "Inválida")).rejects.toThrow("400");
    expect(requests).toBe(1);
    expect(evolution.isAutomatedOutbound("5521971970274", "Inválida")).toBe(false);
  });
});
