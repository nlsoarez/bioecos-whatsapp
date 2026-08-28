import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import type { Env } from "./config/env.js";
import { registerRoutes } from "./http/routes.js";
import type { BioecosRepository } from "./repositories/bioecos.repository.js";
import type { RuntimeSecretStore } from "./security/runtime-secret.store.js";
import { ConversationService } from "./services/conversation.service.js";
import { EvolutionService } from "./services/evolution.service.js";
import { OpenAIResponsesClient } from "./services/openai.service.js";
import type { CoordinatorNotifier } from "./services/coordinator-notification.service.js";
import type { KnowledgeEmbeddingService } from "./services/knowledge-embedding.service.js";
import type { WebhookJobService } from "./services/webhook-job.service.js";
import type { DashboardSessionStore } from "./security/dashboard-session.store.js";
import { ZodError } from "zod";

export interface AppDependencies {
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

export async function buildApp(dependencies: AppDependencies) {
  const app = Fastify({
    logger: { level: dependencies.env.LOG_LEVEL },
    bodyLimit: 1_048_576,
    trustProxy: ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 200, timeWindow: "1 minute" });
  const allowedOrigins = dependencies.env.ADMIN_CORS_ORIGINS
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: allowedOrigins.length === 0 ? false : allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-admin-key", "x-webhook-secret"],
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/dashboard/") || request.url.startsWith("/admin/")) {
      reply.header("cache-control", "no-store, max-age=0");
      reply.header("pragma", "no-cache");
    }
    return payload;
  });
  await registerRoutes(app, dependencies);
  app.setErrorHandler((error, _request, reply) => {
    const candidate = error as { statusCode?: unknown; message?: unknown };
    const statusCode = error instanceof ZodError ? 400
      : typeof candidate.statusCode === "number" ? candidate.statusCode : 500;
    const message = error instanceof Error ? error.message : String(candidate.message ?? "Erro");
    if (statusCode >= 500) app.log.error(error);
    else if (statusCode === 429) app.log.warn({ statusCode }, "Limite de requisições excedido");
    return reply.code(statusCode).send({ error: statusCode >= 500 ? "Erro interno" : message });
  });
  return app;
}
