import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createPool } from "./db/client.js";
import { PostgresRepository } from "./repositories/postgres.repository.js";
import { RuntimeSecretStore } from "./security/runtime-secret.store.js";
import { ConversationService } from "./services/conversation.service.js";
import { EvolutionService } from "./services/evolution.service.js";
import { OpenAIResponsesClient } from "./services/openai.service.js";
import { MonthlyFollowupService } from "./services/monthly-followup.service.js";
import { CoordinatorNotificationService } from "./services/coordinator-notification.service.js";

const env = loadEnv();
const pool = createPool(env);
const repository = new PostgresRepository(pool, env.PII_ENCRYPTION_KEY);
const evolution = new EvolutionService(env);
const secrets = new RuntimeSecretStore(env.RUNTIME_SECRETS_PATH, env.PII_ENCRYPTION_KEY);
const agent = new OpenAIResponsesClient(env, fetch, async () => (
  (await secrets.get("OPENAI_API_KEY")) ?? (env.OPENAI_API_KEY || null)
));
const coordinatorNotifier = new CoordinatorNotificationService(
  repository,
  evolution,
  async () => secrets.get("COORDINATOR_WHATSAPP"),
  env.DASHBOARD_PUBLIC_URL,
);
const conversations = new ConversationService(repository, agent, evolution, coordinatorNotifier);
const monthlyFollowup = new MonthlyFollowupService(repository, evolution);
const app = await buildApp({ env, repository, evolution, conversations, openai: agent, secrets, coordinatorNotifier });

const runMonthlyFollowup = async () => {
  try {
    const result = await monthlyFollowup.runOnce();
    if (result.sent || result.failed) app.log.info(result, "Ciclo de acompanhamento mensal concluído");
  } catch (error) {
    app.log.error(error, "Falha no ciclo de acompanhamento mensal");
  }
};
const followupTimer = setInterval(() => void runMonthlyFollowup(), env.FOLLOWUP_WORKER_INTERVAL_MS);
followupTimer.unref();

const close = async (signal: string) => {
  app.log.info({ signal }, "Encerrando aplicação");
  clearInterval(followupTimer);
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on("SIGTERM", () => void close("SIGTERM"));
process.on("SIGINT", () => void close("SIGINT"));

await app.listen({ host: "0.0.0.0", port: env.PORT });
setTimeout(() => void runMonthlyFollowup(), 30_000).unref();

try {
  const webhook = await evolution.configureWebhook();
  app.log.info({ healthy: webhook.healthy }, "Webhook Evolution verificado na inicialização");
} catch (error) {
  app.log.error(error, "Não foi possível configurar o webhook Evolution na inicialização");
}
