import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { PIPELINE_STAGES } from "../domain/constants.js";
import type { BioecosRepository } from "../repositories/bioecos.repository.js";
import { authenticateCredentials, createSessionToken, requireDashboardSession } from "../security/dashboard-auth.js";
import type { RuntimeSecretStore } from "../security/runtime-secret.store.js";
import { ConversationService } from "../services/conversation.service.js";
import { EvolutionService, parseEvolutionWebhook } from "../services/evolution.service.js";
import { OpenAIResponsesClient } from "../services/openai.service.js";

interface Dependencies {
  env: Env;
  repository: BioecosRepository;
  evolution: EvolutionService;
  conversations: ConversationService;
  openai: OpenAIResponsesClient;
  secrets: RuntimeSecretStore;
}

function assertAdmin(request: FastifyRequest, env: Env): void {
  if (request.headers["x-admin-key"] !== env.ADMIN_API_KEY) {
    const error = new Error("Não autorizado") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }
}

export async function registerRoutes(app: FastifyInstance, dependencies: Dependencies): Promise<void> {
  const { env, repository, evolution, conversations, openai, secrets } = dependencies;

  app.get("/health", async (_request, reply) => {
    let database = false;
    try { database = await repository.health(); } catch { database = false; }
    const [evolutionState, webhookState] = await Promise.all([evolution.health(), evolution.webhookStatus()]);
    const aiSecret = await secrets.status("OPENAI_API_KEY");
    const aiConfigured = Boolean(env.OPENAI_API_KEY) || aiSecret.configured;
    return reply.code(database ? 200 : 503).send({
      status: database ? "ok" : "degraded",
      backend: true,
      database,
      evolution: { ...evolutionState, webhook: webhookState },
      ai: { configured: aiConfigured, provider: env.AI_PROVIDER, model: env.AI_MODEL },
      automation: { mode: env.AUTOMATION_MODE, aiFallbackConfigured: aiConfigured },
    });
  });

  app.post("/webhooks/evolution", async (request, reply) => {
    if (env.EVOLUTION_WEBHOOK_SECRET && request.headers["x-webhook-secret"] !== env.EVOLUTION_WEBHOOK_SECRET) {
      return reply.code(401).send({ error: "Webhook não autorizado" });
    }
    const inbound = parseEvolutionWebhook(request.body);
    if (!inbound) return reply.code(202).send({ accepted: false, reason: "ignored_event" });
    const result = await conversations.handle(inbound);
    return reply.code(200).send({ accepted: true, status: result.status });
  });

  app.post("/dashboard/auth/login", async (request, reply) => {
    const credentials = z.object({
      username: z.string().min(1).max(100),
      password: z.string().min(1).max(500),
    }).parse(request.body);
    const clientId = request.ip;
    if (!authenticateCredentials(env, credentials.username, credentials.password, clientId)) {
      return reply.code(401).send({ error: "Usuário ou senha inválidos" });
    }
    return {
      token: createSessionToken(env, credentials.username),
      expiresInSeconds: env.DASHBOARD_SESSION_TTL_MINUTES * 60,
      user: { username: credentials.username },
    };
  });

  app.get("/dashboard/auth/session", async (request) => {
    const session = requireDashboardSession(request, env);
    return { authenticated: true, user: { username: session.sub }, expiresAt: new Date(session.exp).toISOString() };
  });

  app.get("/dashboard/overview", async (request) => {
    requireDashboardSession(request, env);
    const [database, evolutionState, webhookState, ai, dashboard] = await Promise.all([
      repository.health().catch(() => false),
      evolution.connectionState(),
      evolution.webhookStatus(),
      secrets.status("OPENAI_API_KEY"),
      repository.getDashboard(),
    ]);
    const aiConfigured = Boolean(env.OPENAI_API_KEY) || ai.configured;
    const aiHealth = openai.getHealthStatus();
    return {
      status: database && evolutionState.state === "open" && webhookState.healthy ? "operational" : "attention",
      services: {
        api: true,
        database,
        automation: { mode: env.AUTOMATION_MODE, aiFallback: aiConfigured && aiHealth.state === "operational" },
        ai: { configured: aiConfigured, updatedAt: ai.updatedAt, model: env.AI_MODEL, health: aiHealth },
        whatsapp: { ...evolutionState, webhook: webhookState },
      },
      metrics: dashboard,
      checkedAt: new Date().toISOString(),
    };
  });

  app.put("/dashboard/settings/openai-key", async (request, reply) => {
    requireDashboardSession(request, env);
    const { apiKey } = z.object({ apiKey: z.string().min(20).max(500) }).parse(request.body);
    try {
      await openai.validateApiKey(apiKey);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Chave OpenAI inválida" });
    }
    await secrets.set("OPENAI_API_KEY", apiKey);
    const health = await openai.testCredit();
    return { configured: true, updatedAt: new Date().toISOString(), health };
  });

  app.post("/dashboard/openai/test", async (request) => {
    requireDashboardSession(request, env);
    const aiConfigured = Boolean(env.OPENAI_API_KEY) || (await secrets.status("OPENAI_API_KEY")).configured;
    if (!aiConfigured) throw httpError(409, "Configure a chave OpenAI antes de testar o crédito");
    return openai.testCredit();
  });

  app.delete("/dashboard/settings/openai-key", async (request) => {
    requireDashboardSession(request, env);
    await secrets.delete("OPENAI_API_KEY");
    return { configured: false };
  });

  app.get("/dashboard/whatsapp", async (request) => {
    requireDashboardSession(request, env);
    return evolution.connectionState();
  });

  app.post("/dashboard/whatsapp/connect", async (request) => {
    requireDashboardSession(request, env);
    return evolution.connect();
  });

  app.post("/dashboard/whatsapp/webhook", async (request) => {
    requireDashboardSession(request, env);
    return evolution.configureWebhook();
  });

  app.get("/admin/dashboard", async (request) => {
    assertAdmin(request, env);
    return repository.getDashboard();
  });

  app.get<{ Params: { contactId: string } }>("/admin/contacts/:contactId", async (request, reply) => {
    assertAdmin(request, env);
    const result = await repository.getContactView(request.params.contactId);
    return result ? result : reply.code(404).send({ error: "Contato não encontrado" });
  });

  app.patch<{ Params: { conversationId: string } }>("/admin/conversations/:conversationId/pause", async (request) => {
    assertAdmin(request, env);
    const { paused } = z.object({ paused: z.boolean() }).parse(request.body);
    await repository.setAutomationPaused(request.params.conversationId, paused, "admin");
    return { ok: true, paused };
  });

  app.patch<{ Params: { conversationId: string } }>("/admin/conversations/:conversationId/pipeline", async (request) => {
    assertAdmin(request, env);
    const values = z.object({ stage: z.enum(PIPELINE_STAGES), reason: z.string().min(3).max(500) }).parse(request.body);
    const context = await repository.getContext(request.params.conversationId);
    await repository.moveCard(context, values.stage, values.reason);
    return { ok: true, stage: values.stage };
  });
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}
