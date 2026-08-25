import cors from "@fastify/cors";
import Fastify from "fastify";
import type { Env } from "./config/env.js";
import { registerRoutes } from "./http/routes.js";
import type { BioecosRepository } from "./repositories/bioecos.repository.js";
import { ConversationService } from "./services/conversation.service.js";
import { EvolutionService } from "./services/evolution.service.js";

export interface AppDependencies {
  env: Env;
  repository: BioecosRepository;
  evolution: EvolutionService;
  conversations: ConversationService;
}

export async function buildApp(dependencies: AppDependencies) {
  const app = Fastify({ logger: { level: dependencies.env.LOG_LEVEL }, bodyLimit: 1_048_576 });
  const allowedOrigins = dependencies.env.ADMIN_CORS_ORIGINS
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: allowedOrigins.length === 0 ? false : allowedOrigins,
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
