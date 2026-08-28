import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { PIPELINE_STAGES } from "../domain/constants.js";
import type { BioecosRepository } from "../repositories/bioecos.repository.js";
import {
  authenticateCredentials, createSessionToken, dashboardUnauthorized, requireDashboardSession, secureSecretEqual,
} from "../security/dashboard-auth.js";
import { MemoryDashboardSessionStore, type DashboardSessionStore } from "../security/dashboard-session.store.js";
import type { RuntimeSecretStore } from "../security/runtime-secret.store.js";
import { ConversationService } from "../services/conversation.service.js";
import { EvolutionService, parseEvolutionOutboundWebhook, parseEvolutionWebhook } from "../services/evolution.service.js";
import { OpenAIResponsesClient } from "../services/openai.service.js";
import { NoopCoordinatorNotifier, type CoordinatorNotifier } from "../services/coordinator-notification.service.js";
import type { ConversationWorkflowState } from "../domain/types.js";
import type { KnowledgeEmbeddingService } from "../services/knowledge-embedding.service.js";
import type { WebhookJobService } from "../services/webhook-job.service.js";

interface Dependencies {
  env: Env;
  repository: BioecosRepository;
  evolution: EvolutionService;
  conversations: ConversationService;
  openai: OpenAIResponsesClient;
  secrets: RuntimeSecretStore;
  coordinatorNotifier?: CoordinatorNotifier;
  embeddings?: KnowledgeEmbeddingService;
  webhookJobs?: WebhookJobService;
  dashboardSessions?: DashboardSessionStore;
}

function assertAdmin(request: FastifyRequest, env: Env): void {
  const supplied = request.headers["x-admin-key"];
  if (typeof supplied !== "string" || !secureSecretEqual(supplied, env.ADMIN_API_KEY)) {
    const error = new Error("Não autorizado") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }
}

export async function registerRoutes(app: FastifyInstance, dependencies: Dependencies): Promise<void> {
  const { env, repository, evolution, conversations, openai, secrets } = dependencies;
  const coordinatorNotifier = dependencies.coordinatorNotifier ?? new NoopCoordinatorNotifier();
  const dashboardSessions = dependencies.dashboardSessions ?? new MemoryDashboardSessionStore();
  const requireSession = async (request: FastifyRequest) => {
    const payload = requireDashboardSession(request, env);
    if (!await dashboardSessions.isActive(payload)) throw dashboardUnauthorized();
    return payload;
  };

  app.get("/live", async () => ({ status: "ok", backend: true }));

  app.get("/health", async (_request, reply) => {
    let database = false;
    try { database = await repository.health(); } catch { database = false; }
    const [evolutionState, webhookState] = await Promise.all([evolution.health(), evolution.webhookStatus()]);
    const aiSecret = await secrets.status("OPENAI_API_KEY");
    const aiConfigured = Boolean(env.OPENAI_API_KEY) || aiSecret.configured;
    const aiHealth = openai.getHealthStatus();
    const operational = database && evolutionState.reachable && evolutionState.state === "open"
      && webhookState.healthy && aiConfigured && aiHealth.state === "operational";
    return reply.code(operational ? 200 : 503).send({
      status: operational ? "operational" : "attention",
      checks: {
        database,
        evolution: evolutionState.reachable,
        webhook: webhookState.healthy,
        ai: aiConfigured && aiHealth.state === "operational",
      },
    });
  });

  app.get("/ready", async (_request, reply) => {
    const [database, evolutionState, webhookState, embeddingState, queueState] = await Promise.all([
      repository.health().catch(() => false), evolution.health(), evolution.webhookStatus(),
      dependencies.embeddings?.status().catch(() => null) ?? null,
      dependencies.webhookJobs?.status().catch(() => null) ?? null,
    ]);
    const aiSecret = await secrets.status("OPENAI_API_KEY");
    const aiConfigured = Boolean(env.OPENAI_API_KEY) || aiSecret.configured;
    const aiHealth = openai.getHealthStatus();
    const ready = database && evolutionState.reachable && evolutionState.state === "open" && webhookState.healthy && aiConfigured
      && aiHealth.state === "operational" && (embeddingState?.pending ?? 0) === 0 && (queueState?.failed ?? 0) === 0;
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ready" : "not_ready" });
  });

  app.post("/webhooks/evolution", async (request, reply) => {
    const suppliedSecret = request.headers["x-webhook-secret"];
    if (env.EVOLUTION_WEBHOOK_SECRET
      && (typeof suppliedSecret !== "string" || !secureSecretEqual(suppliedSecret, env.EVOLUTION_WEBHOOK_SECRET))) {
      return reply.code(401).send({ error: "Webhook não autorizado" });
    }
    const inbound = parseEvolutionWebhook(request.body);
    const outbound = inbound ? null : parseEvolutionOutboundWebhook(request.body);
    if (!inbound && !outbound) return reply.code(202).send({ accepted: false, reason: "ignored_event" });
    if (dependencies.webhookJobs) {
      const accepted = await dependencies.webhookJobs.enqueue(inbound
        ? { kind: "inbound", message: inbound }
        : { kind: "human_outbound", message: outbound! });
      return reply.code(202).send({ accepted, status: accepted ? "queued" : "duplicate" });
    }
    if (inbound) {
      const result = await conversations.handle(inbound);
      return reply.code(200).send({ accepted: true, status: result.status });
    }
    const automated = evolution.isAutomatedOutbound(outbound!.phone, outbound!.content);
    const accepted = automated ? false : await repository.recordHumanOutbound(outbound!);
    return reply.code(202).send({ accepted, status: automated ? "automated_echo" : "human_outbound" });
  });

  app.post("/dashboard/auth/login", { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } }, async (request, reply) => {
    const credentials = z.object({
      username: z.string().min(1).max(100),
      password: z.string().min(1).max(500),
    }).parse(request.body);
    const clientId = request.ip;
    if (!authenticateCredentials(env, credentials.username, credentials.password, clientId)) {
      return reply.code(401).send({ error: "Usuário ou senha inválidos" });
    }
    const token = createSessionToken(env, credentials.username);
    const session = requireDashboardSession({ headers: { authorization: `Bearer ${token}` } } as FastifyRequest, env);
    await dashboardSessions.register(session);
    return {
      token,
      expiresInSeconds: env.DASHBOARD_SESSION_TTL_MINUTES * 60,
      user: { username: credentials.username },
    };
  });

  app.get("/dashboard/auth/session", async (request) => {
    const session = await requireSession(request);
    return { authenticated: true, user: { username: session.sub }, expiresAt: new Date(session.exp).toISOString() };
  });

  app.post("/dashboard/auth/logout", async (request, reply) => {
    const session = await requireSession(request);
    await dashboardSessions.revoke(session);
    return reply.code(204).send();
  });

  app.get("/dashboard/overview", async (request) => {
    await requireSession(request);
    const [database, evolutionState, webhookState, ai, coordinator, dashboard, followupSettings, embeddings, queue] = await Promise.all([
      repository.health().catch(() => false),
      evolution.connectionState(),
      evolution.webhookStatus(),
      secrets.status("OPENAI_API_KEY"),
      secrets.status("COORDINATOR_WHATSAPP"),
      repository.getDashboard(),
      repository.getMonthlyFollowupSettings(),
      dependencies.embeddings?.status().catch(() => null) ?? null,
      dependencies.webhookJobs?.status().catch(() => null) ?? null,
    ]);
    const aiConfigured = Boolean(env.OPENAI_API_KEY) || ai.configured;
    const aiHealth = openai.getHealthStatus();
    return {
      status: database && evolutionState.state === "open" && webhookState.healthy && aiConfigured
        && aiHealth.state === "operational" && (embeddings?.pending ?? 0) === 0 ? "operational" : "attention",
      services: {
        api: true,
        database,
        automation: { mode: "ai-only", aiRequired: true, operational: aiConfigured && aiHealth.state === "operational" },
        ai: { configured: aiConfigured, updatedAt: ai.updatedAt, model: env.AI_MODEL, health: aiHealth },
        whatsapp: { ...evolutionState, webhook: webhookState },
        coordinator: { configured: coordinator.configured, updatedAt: coordinator.updatedAt },
      },
      metrics: { ...(dashboard as Record<string, unknown>), followupSettings },
      operations: { embeddings, queue, retentionDays: env.DATA_RETENTION_DAYS },
      checkedAt: new Date().toISOString(),
    };
  });

  app.put("/dashboard/settings/openai-key", async (request, reply) => {
    await requireSession(request);
    const { apiKey } = z.object({ apiKey: z.string().min(20).max(500) }).parse(request.body);
    try {
      await openai.validateApiKey(apiKey);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Chave OpenAI inválida" });
    }
    await secrets.set("OPENAI_API_KEY", apiKey);
    const health = await openai.testCredit();
    const embeddings = await dependencies.embeddings?.status() ?? null;
    if (health.state === "operational" && dependencies.embeddings) void dependencies.embeddings.runPending();
    return { configured: true, updatedAt: new Date().toISOString(), health,
      embeddings: embeddings ? { ...embeddings, triggered: health.state === "operational" } : null };
  });

  app.post("/dashboard/openai/test", async (request) => {
    await requireSession(request);
    const aiConfigured = Boolean(env.OPENAI_API_KEY) || (await secrets.status("OPENAI_API_KEY")).configured;
    if (!aiConfigured) throw httpError(409, "Configure a chave OpenAI antes de testar o crédito");
    return openai.testCredit();
  });

  app.delete("/dashboard/settings/openai-key", async (request) => {
    await requireSession(request);
    await secrets.delete("OPENAI_API_KEY");
    return { configured: false };
  });

  app.put("/dashboard/settings/monthly-followup", async (request) => {
    await requireSession(request);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(request.body);
    return repository.setMonthlyFollowupEnabled(enabled);
  });

  app.put("/dashboard/settings/coordinator-phone", async (request) => {
    await requireSession(request);
    const { phone } = z.object({ phone: z.string().min(10).max(30) }).parse(request.body);
    const digits = phone.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) throw httpError(400, "Número do coordenador inválido");
    await secrets.set("COORDINATOR_WHATSAPP", digits);
    return { configured: true, updatedAt: new Date().toISOString(), masked: `••••${digits.slice(-4)}` };
  });

  app.delete("/dashboard/settings/coordinator-phone", async (request) => {
    await requireSession(request);
    await secrets.delete("COORDINATOR_WHATSAPP");
    return { configured: false };
  });

  app.get("/dashboard/leads", async (request) => {
    await requireSession(request);
    const { filter } = z.object({ filter: z.string().max(50).default("all") }).parse(request.query);
    return { leads: await repository.getLeads(filter) };
  });

  app.get<{ Params: { contactId: string } }>("/dashboard/leads/:contactId", async (request, reply) => {
    await requireSession(request);
    const lead = await repository.getContactView(request.params.contactId);
    return lead ? { lead } : reply.code(404).send({ error: "Lead não encontrado" });
  });

  app.get<{ Params: { conversationId: string } }>("/dashboard/conversations/:conversationId", async (request, reply) => {
    await requireSession(request);
    const contactId = await repository.getConversationContactId(request.params.conversationId);
    if (!contactId) return reply.code(404).send({ error: "Conversa não encontrada" });
    return { lead: await repository.getContactView(contactId) };
  });

  app.get<{ Params: { contactId: string } }>("/dashboard/leads/:contactId/export", async (request, reply) => {
    await requireSession(request);
    const data = await repository.exportContactData(request.params.contactId);
    if (!data) return reply.code(404).send({ error: "Lead não encontrado" });
    reply.header("content-disposition", `attachment; filename=lead-${request.params.contactId}.json`);
    return data;
  });

  app.delete<{ Params: { contactId: string } }>("/dashboard/leads/:contactId", async (request, reply) => {
    const session = await requireSession(request);
    const values = z.object({ confirm: z.literal("EXCLUIR") }).parse(request.body);
    void values;
    const deleted = await repository.deleteContactData(request.params.contactId, `dashboard:${session.sub}`);
    return deleted ? { deleted: true } : reply.code(404).send({ error: "Lead não encontrado" });
  });

  app.patch<{ Params: { conversationId: string } }>("/dashboard/conversations/:conversationId/workflow", async (request) => {
    await requireSession(request);
    const values = z.object({
      state: z.enum(["ai_attending", "awaiting_coordinator", "coordinator_attending", "conversation_finished", "enrollment_completed", "not_interested"]),
      reason: z.string().min(2).max(500),
    }).parse(request.body);
    const owner = values.state === "ai_attending" ? "ai" : "coordinator";
    await repository.setConversationWorkflow(request.params.conversationId, values.state as ConversationWorkflowState, owner, values.reason);
    return { ok: true, state: values.state, owner };
  });

  app.get("/dashboard/notifications/failed", async (request) => {
    await requireSession(request);
    return { notifications: await repository.getFailedCoordinatorNotifications(50) };
  });

  app.post<{ Params: { id: string } }>("/dashboard/notifications/:id/retry", async (request) => {
    await requireSession(request);
    return coordinatorNotifier.retry(request.params.id);
  });

  app.post("/dashboard/webhooks/retry-failed", async (request) => {
    await requireSession(request);
    if (!dependencies.webhookJobs) return { retried: 0 };
    return { retried: await dependencies.webhookJobs.retryFailed() };
  });

  app.get("/dashboard/whatsapp", async (request) => {
    await requireSession(request);
    return evolution.connectionState();
  });

  app.post("/dashboard/whatsapp/connect", async (request) => {
    await requireSession(request);
    return evolution.connect();
  });

  app.post("/dashboard/whatsapp/webhook", async (request) => {
    await requireSession(request);
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
