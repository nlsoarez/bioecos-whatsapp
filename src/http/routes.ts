import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import { PIPELINE_STAGES } from "../domain/constants.js";
import type { BioecosRepository } from "../repositories/bioecos.repository.js";
import { ConversationService } from "../services/conversation.service.js";
import { EvolutionService, parseEvolutionWebhook } from "../services/evolution.service.js";

interface Dependencies {
  env: Env;
  repository: BioecosRepository;
  evolution: EvolutionService;
  conversations: ConversationService;
}

function assertAdmin(request: FastifyRequest, env: Env): void {
  if (request.headers["x-admin-key"] !== env.ADMIN_API_KEY) {
    const error = new Error("Não autorizado") as Error & { statusCode: number };
    error.statusCode = 401;
    throw error;
  }
}

export async function registerRoutes(app: FastifyInstance, dependencies: Dependencies): Promise<void> {
  const { env, repository, evolution, conversations } = dependencies;

  app.get("/health", async (_request, reply) => {
    let database = false;
    try { database = await repository.health(); } catch { database = false; }
    const evolutionState = await evolution.health();
    const ok = database;
    return reply.code(ok ? 200 : 503).send({
      status: ok ? "ok" : "degraded",
      backend: true,
      database,
      evolution: evolutionState,
      ai: { configured: Boolean(env.OPENAI_API_KEY), provider: env.AI_PROVIDER, model: env.AI_MODEL },
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

