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
import { KnowledgeEmbeddingService } from "./services/knowledge-embedding.service.js";
import { WebhookJobService } from "./services/webhook-job.service.js";
import { DataRetentionService } from "./services/data-retention.service.js";
import { PostgresDashboardSessionStore } from "./security/dashboard-session.store.js";
import { PiiCipher } from "./security/pii-cipher.js";

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
const embeddings = new KnowledgeEmbeddingService(pool, agent);
const webhookJobs = new WebhookJobService(pool, conversations, repository, evolution, new PiiCipher(env.PII_ENCRYPTION_KEY));
const retention = new DataRetentionService(pool, env.DATA_RETENTION_DAYS);
const dashboardSessions = new PostgresDashboardSessionStore(pool);
await repository.migrateLegacyPii();
const app = await buildApp({
  env, repository, evolution, conversations, openai: agent, secrets, coordinatorNotifier, embeddings, webhookJobs,
  dashboardSessions,
});

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
const webhookTimer = setInterval(() => void webhookJobs.runOnce().catch((error) => app.log.error(error, "Falha no worker de webhooks")), env.WEBHOOK_WORKER_INTERVAL_MS);
webhookTimer.unref();
const aiHealthTimer = setInterval(() => void agent.testCredit().then((status) => {
  if (status.state === "operational") return embeddings.runPending();
  return null;
}).catch((error) => app.log.error(error, "Falha na verificação periódica da OpenAI")), env.OPENAI_HEALTH_INTERVAL_MS);
aiHealthTimer.unref();
const retentionTimer = setInterval(() => void retention.runOnce().catch((error) => app.log.error(error, "Falha na retenção de dados")), 24 * 60 * 60 * 1_000);
retentionTimer.unref();

const close = async (signal: string) => {
  app.log.info({ signal }, "Encerrando aplicação");
  clearInterval(followupTimer);
  clearInterval(webhookTimer);
  clearInterval(aiHealthTimer);
  clearInterval(retentionTimer);
  await app.close();
  await pool.end();
  process.exit(0);
};

process.on("SIGTERM", () => void close("SIGTERM"));
process.on("SIGINT", () => void close("SIGINT"));

await app.listen({ host: "0.0.0.0", port: env.PORT });
setTimeout(() => void runMonthlyFollowup(), 30_000).unref();
setTimeout(() => void webhookJobs.runOnce(), 2_000).unref();
setTimeout(() => void agent.testCredit().then((status) => status.state === "operational" ? embeddings.runPending() : null), 5_000).unref();
setTimeout(() => void retention.runOnce(), 60_000).unref();

try {
  const webhook = await evolution.configureWebhook();
  app.log.info({ healthy: webhook.healthy }, "Webhook Evolution verificado na inicialização");
} catch (error) {
  app.log.error(error, "Não foi possível configurar o webhook Evolution na inicialização");
}
