import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createPool } from "./db/client.js";
import { PostgresRepository } from "./repositories/postgres.repository.js";
import { RuntimeSecretStore } from "./security/runtime-secret.store.js";
import { ConversationService } from "./services/conversation.service.js";
import { EvolutionService } from "./services/evolution.service.js";
import { OpenAIResponsesClient } from "./services/openai.service.js";

const env = loadEnv();
const pool = createPool(env);
const repository = new PostgresRepository(pool, env.PII_ENCRYPTION_KEY);
const evolution = new EvolutionService(env);
const secrets = new RuntimeSecretStore(env.RUNTIME_SECRETS_PATH, env.PII_ENCRYPTION_KEY);
const agent = new OpenAIResponsesClient(env, fetch, async () => (
  (await secrets.get("OPENAI_API_KEY")) ?? (env.OPENAI_API_KEY || null)
));
const conversations = new ConversationService(repository, agent, evolution);
const app = await buildApp({ env, repository, evolution, conversations, openai: agent, secrets });

const close = async (signal: string) => {
  app.log.info({ signal }, "Encerrando aplicação");
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on("SIGTERM", () => void close("SIGTERM"));
process.on("SIGINT", () => void close("SIGINT"));

await app.listen({ host: "0.0.0.0", port: env.PORT });
