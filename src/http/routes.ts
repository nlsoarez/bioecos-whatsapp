import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { PIPELINE_STAGES } from "../domain/constants.js";
import { DuplicateIgnoredPhoneError, type BioecosRepository } from "../repositories/bioecos.repository.js";
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
import {
  DuplicateKnowledgeError, KNOWLEDGE_KINDS, UnsafeKnowledgeError, type KnowledgeManagement,
} from "../services/knowledge-management.service.js";

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
  knowledgeManagement?: KnowledgeManagement;
}

const PORTAL_ROOT = resolve(process.cwd(), "docs");
const PORTAL_ASSETS = new Map([
  ["app.js", "application/javascript; charset=utf-8"],
  ["bioecos-favicon.ico", "image/x-icon"],
  ["bioecos-share.jpg", "image/jpeg"],
  ["config.js", "application/javascript; charset=utf-8"],
  ["frame-guard.js", "application/javascript; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
]);

async function sendPortalFile(reply: FastifyReply, file: string, contentType: string) {
  const content = await readFile(resolve(PORTAL_ROOT, file));
  return reply
    .type(contentType)
    .header("cache-control", "no-store, max-age=0")
    .header("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    .send(content);
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

  app.get("/", async (_request, reply) => sendPortalFile(reply, "index.html", "text/html; charset=utf-8"));
  app.get("/portal", async (_request, reply) => sendPortalFile(reply, "index.html", "text/html; charset=utf-8"));
  app.get("/portal/", async (_request, reply) => sendPortalFile(reply, "index.html", "text/html; charset=utf-8"));
  app.get<{ Params: { file: string } }>("/portal/assets/:file", async (request, reply) => {
    const contentType = PORTAL_ASSETS.get(request.params.file);
    if (!contentType) return reply.code(404).send({ error: "Arquivo não encontrado" });
    return sendPortalFile(reply, `assets/${request.params.file}`, contentType);
  });

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
    if (await repository.isPhoneIgnored((inbound ?? outbound!).phone)) {
      return reply.code(202).send({ accepted: false, status: "ignored" });
    }
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

  const structuredDataSchema = z.record(z.string().max(60), z.string().trim().max(2_000).nullable());
  const managedKnowledgeSchema = z.object({
    kind: z.enum(KNOWLEDGE_KINDS),
    category: z.string().trim().min(1).max(80).default("Geral"),
    title: z.string().trim().min(3).max(180),
    content: z.string().trim().min(10).max(120_000),
    courseName: z.string().trim().max(180).nullable().default(null),
    structuredData: structuredDataSchema.default({}),
    active: z.boolean().default(true),
    confirmConflict: z.boolean().optional(),
  });
  const documentUploadSchema = z.object({
    filename: z.string().min(1).max(220), mimeType: z.string().min(1).max(150), base64: z.string().min(8).max(5_600_000),
    title: z.string().trim().min(3).max(180), category: z.string().trim().min(1).max(80).default("Documentos"),
    courseName: z.string().trim().max(180).nullable().default(null), active: z.boolean().default(true),
  });
  const mediaSchema = z.object({
    entryId: z.string().uuid().nullable().default(null), courseName: z.string().trim().max(180).nullable().default(null),
    category: z.string().trim().min(1).max(80).default("Imagens"), description: z.string().trim().min(3).max(1_000),
    keywords: z.array(z.string().trim().min(1).max(50)).max(20).default([]),
    filename: z.string().min(1).max(220).optional(), mimeType: z.string().min(1).max(100).optional(),
    base64: z.string().min(8).max(7_100_000).optional(), active: z.boolean().default(true),
  });

  const knowledgeService = () => {
    if (!dependencies.knowledgeManagement) throw httpError(503, "Gerenciador de conhecimento indisponível");
    return dependencies.knowledgeManagement;
  };

  app.get("/dashboard/knowledge", async (request) => {
    await requireSession(request);
    const { search, kind } = z.object({ search: z.string().trim().max(150).default(""), kind: z.string().max(30).default("") }).parse(request.query);
    return { entries: await knowledgeService().list(search, kind) };
  });

  app.post("/dashboard/knowledge", { bodyLimit: 1_048_576 }, async (request, reply) => {
    const session = await requireSession(request);
    try {
      const { confirmConflict, ...parsed } = managedKnowledgeSchema.parse(request.body);
      const entry = await knowledgeService().create({ ...parsed, ...(confirmConflict === undefined ? {} : { confirmConflict }) }, `dashboard:${session.sub}`);
      return reply.code(201).send({ entry });
    } catch (error) { return handleKnowledgeError(reply, error); }
  });

  app.patch<{ Params: { id: string } }>("/dashboard/knowledge/:id", { bodyLimit: 1_048_576 }, async (request, reply) => {
    const session = await requireSession(request);
    try {
      const { confirmConflict, ...parsed } = managedKnowledgeSchema.parse(request.body);
      const entry = await knowledgeService().update(z.string().uuid().parse(request.params.id), { ...parsed, ...(confirmConflict === undefined ? {} : { confirmConflict }) }, `dashboard:${session.sub}`);
      return entry ? { entry } : reply.code(404).send({ error: "Conhecimento não encontrado" });
    } catch (error) { return handleKnowledgeError(reply, error); }
  });

  app.delete<{ Params: { id: string } }>("/dashboard/knowledge/:id", async (request, reply) => {
    const session = await requireSession(request);
    const removed = await knowledgeService().remove(z.string().uuid().parse(request.params.id), `dashboard:${session.sub}`);
    return removed ? { removed: true } : reply.code(404).send({ error: "Conhecimento não encontrado" });
  });

  app.get("/dashboard/knowledge/history", async (request) => {
    await requireSession(request);
    const { entryId } = z.object({ entryId: z.string().uuid().optional() }).parse(request.query);
    return { history: await knowledgeService().history(entryId ?? "") };
  });

  app.post("/dashboard/knowledge/documents", { bodyLimit: 6_500_000 }, async (request, reply) => {
    const session = await requireSession(request);
    try {
      const entry = await knowledgeService().uploadDocument(documentUploadSchema.parse(request.body), `dashboard:${session.sub}`);
      return reply.code(201).send({ entry });
    } catch (error) { return handleKnowledgeError(reply, error); }
  });

  app.get("/dashboard/knowledge/media", async (request) => {
    await requireSession(request);
    const { search } = z.object({ search: z.string().trim().max(150).default("") }).parse(request.query);
    return { media: await knowledgeService().listMedia(search) };
  });

  app.post("/dashboard/knowledge/media", { bodyLimit: 7_500_000 }, async (request, reply) => {
    const session = await requireSession(request);
    try {
      const media = await knowledgeService().createMedia(mediaSchema.extend({ filename: z.string().min(1), mimeType: z.string().min(1), base64: z.string().min(8) }).parse(request.body), `dashboard:${session.sub}`);
      return reply.code(201).send({ media });
    } catch (error) { return handleKnowledgeError(reply, error); }
  });

  app.patch<{ Params: { id: string } }>("/dashboard/knowledge/media/:id", { bodyLimit: 7_500_000 }, async (request, reply) => {
    const session = await requireSession(request);
    try {
      const { filename, mimeType, base64, ...parsed } = mediaSchema.parse(request.body);
      const media = await knowledgeService().updateMedia(z.string().uuid().parse(request.params.id), {
        ...parsed,
        ...(filename === undefined ? {} : { filename }),
        ...(mimeType === undefined ? {} : { mimeType }),
        ...(base64 === undefined ? {} : { base64 }),
      }, `dashboard:${session.sub}`);
      return media ? { media } : reply.code(404).send({ error: "Imagem não encontrada" });
    } catch (error) { return handleKnowledgeError(reply, error); }
  });

  app.delete<{ Params: { id: string } }>("/dashboard/knowledge/media/:id", async (request, reply) => {
    const session = await requireSession(request);
    const removed = await knowledgeService().removeMedia(z.string().uuid().parse(request.params.id), `dashboard:${session.sub}`);
    return removed ? { removed: true } : reply.code(404).send({ error: "Imagem não encontrada" });
  });

  app.get<{ Params: { id: string } }>("/dashboard/knowledge/media/:id/file", async (request, reply) => {
    await requireSession(request);
    const file = await knowledgeService().getMediaFile(z.string().uuid().parse(request.params.id));
    if (!file) return reply.code(404).send({ error: "Imagem não encontrada" });
    return reply.type(file.mimeType).header("content-disposition", `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`).send(file.data);
  });

  app.post("/dashboard/knowledge/test", async (request) => {
    await requireSession(request);
    const { question } = z.object({ question: z.string().trim().min(3).max(1_000) }).parse(request.body);
    const embedding = await openai.embed(question).catch(() => null);
    const knowledge = await repository.searchKnowledge(question, embedding, 8);
    const answer = await openai.answerKnowledgeTest(question, knowledge);
    return { answer, sources: knowledge.map(({ id, title, score }) => ({ id, title, score })) };
  });

  const ignoredPhoneSchema = z.object({
    phoneNumber: z.string().min(10).max(40),
    name: z.string().trim().max(100).nullable().default(null),
    note: z.string().trim().max(500).nullable().default(null),
    active: z.boolean().default(true),
  });

  app.get("/dashboard/settings/ignored-numbers", async (request) => {
    await requireSession(request);
    const { search } = z.object({ search: z.string().trim().max(100).default("") }).parse(request.query);
    return { ignoredNumbers: await repository.listIgnoredPhoneNumbers(search) };
  });

  app.post("/dashboard/settings/ignored-numbers", async (request, reply) => {
    const session = await requireSession(request);
    const values = ignoredPhoneSchema.parse(request.body);
    try {
      const ignoredNumber = await repository.createIgnoredPhoneNumber(values, `dashboard:${session.sub}`);
      return reply.code(201).send({ ignoredNumber });
    } catch (error) {
      if (error instanceof DuplicateIgnoredPhoneError) return reply.code(409).send({ error: error.message });
      if (error instanceof Error && error.message.includes("telefone inválido")) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/dashboard/settings/ignored-numbers/:id", async (request, reply) => {
    const session = await requireSession(request);
    const values = ignoredPhoneSchema.parse(request.body);
    try {
      const ignoredNumber = await repository.updateIgnoredPhoneNumber(request.params.id, values, `dashboard:${session.sub}`);
      return ignoredNumber ? { ignoredNumber } : reply.code(404).send({ error: "Número ignorado não encontrado" });
    } catch (error) {
      if (error instanceof DuplicateIgnoredPhoneError) return reply.code(409).send({ error: error.message });
      if (error instanceof Error && error.message.includes("telefone inválido")) return reply.code(400).send({ error: error.message });
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>("/dashboard/settings/ignored-numbers/:id", async (request, reply) => {
    const session = await requireSession(request);
    const deleted = await repository.deleteIgnoredPhoneNumber(request.params.id, `dashboard:${session.sub}`);
    return deleted ? { deleted: true } : reply.code(404).send({ error: "Número ignorado não encontrado" });
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
    return { notifications: (await repository.listCoordinatorNotifications("failed", 50)).map(publicNotification) };
  });

  app.get("/dashboard/notifications", async (request) => {
    await requireSession(request);
    const values = z.object({
      status: z.preprocess((value) => value === "" ? undefined : value,
        z.enum(["pending", "processing", "accepted", "failed"]).optional()),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    return { notifications: (await repository.listCoordinatorNotifications(values.status ?? "", values.limit)).map(publicNotification) };
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

  app.get("/dashboard/whatsapp/qr", async (request) => {
    await requireSession(request);
    const connection = await evolution.connectionState();
    if (connection.state === "open") return { connection, qrCode: null };
    return { connection, qrCode: await evolution.refreshQrCode() };
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

function publicNotification(notification: import("../domain/types.js").CoordinatorNotificationRecord) {
  const digits = notification.recipientPhone?.replace(/\D/g, "") ?? "";
  return {
    ...notification,
    recipientPhone: undefined,
    recipientMasked: digits ? `••••${digits.slice(-4)}` : null,
    deliveryMeaning: notification.status === "accepted" ? "Aceita pelo provedor; leitura não confirmada" : null,
  };
}

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function handleKnowledgeError(reply: FastifyReply, error: unknown) {
  if (error instanceof DuplicateKnowledgeError) return reply.code(409).send({ error: error.message });
  if (error instanceof UnsafeKnowledgeError) return reply.code(400).send({ error: error.message });
  if (error instanceof Error && /arquivo|documento|imagem|conteúdo|campo obrigatório|conhecimento associado/i.test(error.message)) {
    return reply.code(400).send({ error: error.message });
  }
  throw error;
}
