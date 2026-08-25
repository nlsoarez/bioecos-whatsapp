import cors from "@fastify/cors";
import Fastify from "fastify";
import type { Env } from "./config/env.js";
import { registerRoutes } from "./http/routes.js";
import type { BioecosRepository } from "./repositories/bioecos.repository.js";
import type { RuntimeSecretStore } from "./security/runtime-secret.store.js";
import { ConversationService } from "./services/conversation.service.js";
import { EvolutionService } from "./services/evolution.service.js";
import { OpenAIResponsesClient } from "./services/openai.service.js";

export interface AppDependencies {
  env: Env;
  repository: BioecosRepository;
  evolution: EvolutionService;
  conversations: ConversationService;
  openai: OpenAIResponsesClient;
  secrets: RuntimeSecretStore;
}

export async function buildApp(dependencies: AppDependencies) {
  const app = Fastify({ logger: { level: dependencies.env.LOG_LEVEL }, bodyLimit: 1_048_576 });
  const allowedOrigins = dependencies.env.ADMIN_CORS_ORIGINS
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: allowedOrigins.length === 0 ? false : allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-admin-key", "x-webhook-secret"],
  });
  await registerRoutes(app, dependencies);
  app.setErrorHandler((error, _request, reply) => {
    const candidate = error as { statusCode?: unknown; message?: unknown };
    const statusCode = typeof candidate.statusCode === "number" ? candidate.statusCode : 500;
    const message = error instanceof Error ? error.message : String(candidate.message ?? "Erro");
    app.log.error(error);
    return reply.code(statusCode).send({ error: statusCode >= 500 ? "Erro interno" : message });
  });
  return app;
}
