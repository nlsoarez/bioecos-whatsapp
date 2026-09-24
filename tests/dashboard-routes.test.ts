import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { RuntimeSecretStore } from "../src/security/runtime-secret.store.js";
import { ConversationService } from "../src/services/conversation.service.js";
import { EvolutionService } from "../src/services/evolution.service.js";
import { OpenAIResponsesClient } from "../src/services/openai.service.js";
import type { WebhookJobService } from "../src/services/webhook-job.service.js";
import { InMemoryRepository } from "./support/in-memory.repository.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "bioecos-dashboard-"));
  directories.push(directory);
  const env = loadEnv({
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    EVOLUTION_API_URL: "http://evolution:8080",
    EVOLUTION_API_KEY: "evolution-secret",
    EVOLUTION_INSTANCE_NAME: "bioecos",
    EVOLUTION_WEBHOOK_SECRET: "webhook-secret-at-least-32-characters",
    ADMIN_API_KEY: "admin-secret-key",
    PII_ENCRYPTION_KEY: "encryption-secret",
    DASHBOARD_USERNAME: "operador",
    DASHBOARD_PASSWORD: "dashboard-password-secret",
    DASHBOARD_SESSION_SECRET: "dashboard-session-secret-at-least-32-chars",
    RUNTIME_SECRETS_PATH: join(directory, "runtime-secrets.json"),
  });
  const repository = new InMemoryRepository();
  const request = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.includes("connectionState")) return new Response(JSON.stringify({ instance: { state: "close" } }), { status: 200 });
    if (url.includes("/instance/connect/")) return new Response(JSON.stringify({ base64: "data:image/png;base64,AAAA", count: 1 }), { status: 200 });
    return new Response(JSON.stringify({}), { status: init?.method === "POST" ? 201 : 200 });
  };
  const secrets = new RuntimeSecretStore(env.RUNTIME_SECRETS_PATH, env.PII_ENCRYPTION_KEY);
  const evolution = new EvolutionService(env, request as typeof fetch);
  const openai = new OpenAIResponsesClient(env, request as typeof fetch, async () => secrets.get("OPENAI_API_KEY"));
  const conversations = new ConversationService(repository, openai, evolution);
  const queued: unknown[] = [];
  const webhookJobs = {
    enqueue: async (payload: unknown) => { queued.push(payload); return true; },
    status: async () => ({ pending: 0, processing: 0, failed: 0 }),
    retryFailed: async () => 0,
  } as unknown as WebhookJobService;
  const app = await buildApp({ env, repository, evolution, conversations, openai, secrets, webhookJobs });
  return { app, secrets, repository, queued };
}

describe("rotas do dashboard", () => {
  it("protege o overview e autentica o operador", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/dashboard/overview" })).statusCode).toBe(401);
    const login = await app.inject({
      method: "POST",
      url: "/dashboard/auth/login",
      payload: { username: "operador", password: "dashboard-password-secret" },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token as string;
    const overview = await app.inject({ method: "GET", url: "/dashboard/overview", headers: { authorization: `Bearer ${token}` } });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().services.ai.configured).toBe(false);
    expect(overview.headers["cache-control"]).toContain("no-store");
    const logout = await app.inject({ method: "POST", url: "/dashboard/auth/logout", headers: { authorization: `Bearer ${token}` } });
    expect(logout.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/dashboard/overview", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
    await app.close();
  });

  it("valida e persiste a chave sem devolvê-la ao cliente", async () => {
    const { app, secrets } = await setup();
    const login = await app.inject({
      method: "POST",
      url: "/dashboard/auth/login",
      payload: { username: "operador", password: "dashboard-password-secret" },
    });
    const token = login.json().token as string;
    const apiKey = "sk-proj-valid-example-api-key-value";
    const response = await app.inject({
      method: "PUT",
      url: "/dashboard/settings/openai-key",
      headers: { authorization: `Bearer ${token}` },
      payload: { apiKey },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(apiKey);
    expect(response.json().health.state).toBe("operational");
    expect(await secrets.get("OPENAI_API_KEY")).toBe(apiKey);
    await app.close();
  });

  it("mantém a configuração técnica do WhatsApp independente da chave de IA", async () => {
    const { app } = await setup();
    const login = await app.inject({
      method: "POST",
      url: "/dashboard/auth/login",
      payload: { username: "operador", password: "dashboard-password-secret" },
    });
    const response = await app.inject({
      method: "POST",
      url: "/dashboard/whatsapp/connect",
      headers: { authorization: `Bearer ${login.json().token as string}` },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().base64).toContain("data:image/png;base64,");
    await app.close();
  });

  it("ativa e desativa o acompanhamento mensal somente com sessão válida", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "PUT", url: "/dashboard/settings/monthly-followup", payload: { enabled: true } })).statusCode).toBe(401);
    const login = await app.inject({
      method: "POST", url: "/dashboard/auth/login",
      payload: { username: "operador", password: "dashboard-password-secret" },
    });
    const response = await app.inject({
      method: "PUT", url: "/dashboard/settings/monthly-followup",
      headers: { authorization: `Bearer ${login.json().token as string}` }, payload: { enabled: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ enabled: true, intervalDays: 30, maxAttempts: 3 });
    await app.close();
  });

  it("limita força bruta, rejeita corpo excessivo e não expõe erro interno", async () => {
    const { app } = await setup();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/dashboard/auth/login",
        headers: { "x-forwarded-for": "198.51.100.25" },
        payload: { username: "operador", password: `incorreta-${attempt}` },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).not.toContain(500);
    expect(statuses.at(-1)).toBe(429);

    const invalidSchema = await app.inject({
      method: "POST", url: "/dashboard/auth/login",
      headers: { "x-forwarded-for": "198.51.100.26" }, payload: { username: 123, password: false },
    });
    expect(invalidSchema.statusCode).toBe(400);
    expect(invalidSchema.body).not.toContain("stack");

    const oversized = await app.inject({
      method: "POST", url: "/webhooks/evolution",
      headers: { "content-type": "application/json", "x-webhook-secret": "invalid" },
      payload: JSON.stringify({ content: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("rejeita webhook sem o segredo correto e restringe CORS", async () => {
    const { app } = await setup();
    const payload = {
      event: "messages.upsert",
      data: {
        key: { id: "security-test", remoteJid: "5521971970274@s.whatsapp.net", fromMe: false },
        message: { conversation: "Olá" },
        messageTimestamp: 1_700_000_000,
      },
    };
    expect((await app.inject({ method: "POST", url: "/webhooks/evolution", payload })).statusCode).toBe(401);
    expect((await app.inject({
      method: "POST", url: "/webhooks/evolution",
      headers: { "x-webhook-secret": "segredo-incorreto" }, payload,
    })).statusCode).toBe(401);

    const cors = await app.inject({
      method: "OPTIONS", url: "/dashboard/overview",
      headers: { origin: "https://attacker.example", "access-control-request-method": "GET" },
    });
    expect(cors.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("gerencia números ignorados, normaliza formatos e rejeita duplicados", async () => {
    const { app } = await setup();
    expect((await app.inject({ method: "GET", url: "/dashboard/settings/ignored-numbers" })).statusCode).toBe(401);
    const login = await app.inject({
      method: "POST", url: "/dashboard/auth/login",
      payload: { username: "operador", password: "dashboard-password-secret" },
    });
    const headers = { authorization: `Bearer ${login.json().token as string}` };
    const created = await app.inject({
      method: "POST", url: "/dashboard/settings/ignored-numbers", headers,
      payload: { phoneNumber: "(21) 99999-9999", name: "Helder", note: "Número pessoal", active: true },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().ignoredNumber).toMatchObject({ phoneNumber: "5521999999999", name: "Helder", active: true });
    expect((await app.inject({
      method: "POST", url: "/dashboard/settings/ignored-numbers", headers,
      payload: { phoneNumber: "+55 21 99999-9999", name: null, note: null, active: true },
    })).statusCode).toBe(409);
    const listed = await app.inject({ method: "GET", url: "/dashboard/settings/ignored-numbers?search=Helder", headers });
    expect(listed.json().ignoredNumbers).toHaveLength(1);
    const id = created.json().ignoredNumber.id as string;
    const updated = await app.inject({
      method: "PATCH", url: `/dashboard/settings/ignored-numbers/${id}`, headers,
      payload: { phoneNumber: "21999999999", name: "Helder editado", note: "Pessoal", active: false },
    });
    expect(updated.json().ignoredNumber).toMatchObject({ phoneNumber: "5521999999999", active: false });
    expect((await app.inject({ method: "DELETE", url: `/dashboard/settings/ignored-numbers/${id}`, headers })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/dashboard/settings/ignored-numbers", headers })).json().ignoredNumbers).toHaveLength(0);
    await app.close();
  });

  it("encerra webhook de número ativo antes da fila e libera após desativação ou exclusão", async () => {
    const { app, repository, queued } = await setup();
    const item = await repository.createIgnoredPhoneNumber({
      phoneNumber: "+55 21 99999-9999", name: "Protegido", note: null, active: true,
    }, "test");
    const payload = {
      event: "messages.upsert",
      data: { key: { id: "ignored-1", remoteJid: "5521999999999@s.whatsapp.net", fromMe: false },
        message: { conversation: "Olá" }, messageTimestamp: 1_700_000_000 },
    };
    const headers = { "x-webhook-secret": "webhook-secret-at-least-32-characters" };
    const ignored = await app.inject({ method: "POST", url: "/webhooks/evolution", headers, payload });
    expect(ignored.statusCode).toBe(202);
    expect(ignored.json()).toMatchObject({ accepted: false, status: "ignored" });
    expect(queued).toHaveLength(0);

    await repository.updateIgnoredPhoneNumber(item.id, { ...item, active: false }, "test");
    payload.data.key.id = "inactive-1";
    expect((await app.inject({ method: "POST", url: "/webhooks/evolution", headers, payload })).json().status).toBe("queued");
    expect(queued).toHaveLength(1);

    await repository.deleteIgnoredPhoneNumber(item.id, "test");
    payload.data.key.id = "deleted-1";
    expect((await app.inject({ method: "POST", url: "/webhooks/evolution", headers, payload })).json().status).toBe("queued");
    expect(queued).toHaveLength(2);
    await app.close();
  });
});
