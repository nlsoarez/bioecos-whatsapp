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
  const app = await buildApp({ env, repository, evolution, conversations, openai, secrets });
  return { app, secrets };
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
});
