import type pg from "pg";
import type { InboundMessage, OutboundWebhookMessage } from "../domain/types.js";
import type { BioecosRepository } from "../repositories/bioecos.repository.js";
import type { ConversationService } from "./conversation.service.js";
import type { EvolutionService } from "./evolution.service.js";
import type { PiiCipher } from "../security/pii-cipher.js";

type JobPayload = { kind: "inbound"; message: InboundMessage } | { kind: "human_outbound"; message: OutboundWebhookMessage };

export class WebhookJobService {
  private running = false;

  constructor(
    private readonly pool: pg.Pool,
    private readonly conversations: ConversationService,
    private readonly repository: BioecosRepository,
    private readonly evolution: EvolutionService,
    private readonly pii?: PiiCipher,
  ) {}

  async enqueue(payload: JobPayload): Promise<boolean> {
    const storedPayload = { ...payload, message: { ...payload.message, raw: { source: "evolution" } } } as JobPayload;
    if (this.pii) {
      storedPayload.message.phone = this.pii.encrypt(storedPayload.message.phone);
      storedPayload.message.content = this.pii.encrypt(storedPayload.message.content);
      if ("pushName" in storedPayload.message && storedPayload.message.pushName) {
        storedPayload.message.pushName = this.pii.encrypt(storedPayload.message.pushName);
      }
    }
    const result = await this.pool.query(
      `INSERT INTO webhook_jobs(external_message_id, payload) VALUES ($1, $2)
       ON CONFLICT(external_message_id) DO NOTHING RETURNING id`,
      [payload.message.externalMessageId, JSON.stringify(storedPayload)],
    );
    return result.rowCount === 1;
  }

  async retryFailed(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE webhook_jobs SET status = 'pending', attempts = 0, available_at = now(), locked_at = null, last_error = null
       WHERE status = 'failed'`,
    );
    return result.rowCount ?? 0;
  }

  async status(): Promise<{ pending: number; processing: number; failed: number }> {
    const result = await this.pool.query<{ pending: number; processing: number; failed: number }>(
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'processing')::int AS processing,
        count(*) FILTER (WHERE status = 'failed')::int AS failed FROM webhook_jobs`,
    );
    return result.rows[0] ?? { pending: 0, processing: 0, failed: 0 };
  }

  async runOnce(limit = 20): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const claimed = await this.pool.query<{ id: string; payload: JobPayload; attempts: number }>(
        `UPDATE webhook_jobs SET status = 'processing', locked_at = now(), attempts = attempts + 1
         WHERE id IN (
           SELECT id FROM webhook_jobs
           WHERE (status = 'pending' AND available_at <= now())
              OR (status = 'processing' AND locked_at < now() - interval '10 minutes')
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
         ) RETURNING id, payload, attempts`,
        [Math.max(1, Math.min(limit, 100))],
      );
      for (const job of claimed.rows) {
        try {
          const payload = normalizePayload(job.payload, this.pii);
          if (payload.kind === "inbound") {
            await this.conversations.handle(payload.message);
          } else if (!this.evolution.isAutomatedOutbound(payload.message.phone, payload.message.content)) {
            await this.repository.recordHumanOutbound(payload.message);
          }
          await this.pool.query("UPDATE webhook_jobs SET status = 'completed', completed_at = now(), locked_at = null WHERE id = $1", [job.id]);
        } catch (error) {
          const finalFailure = job.attempts >= 5;
          await this.pool.query(
            `UPDATE webhook_jobs SET status = $2, available_at = now() + ($3::int * interval '1 minute'),
             locked_at = null, last_error = $4 WHERE id = $1`,
            [job.id, finalFailure ? "failed" : "pending", 2 ** Math.min(job.attempts, 5),
              (error instanceof Error ? error.message : String(error)).slice(0, 500)],
          );
        }
      }
    } finally {
      this.running = false;
    }
  }
}

function normalizePayload(payload: JobPayload, pii?: PiiCipher): JobPayload {
  if (pii) {
    payload.message.phone = pii.decrypt(payload.message.phone);
    payload.message.content = pii.decrypt(payload.message.content);
    if ("pushName" in payload.message && payload.message.pushName) payload.message.pushName = pii.decrypt(payload.message.pushName);
  }
  payload.message.timestamp = new Date(payload.message.timestamp);
  return payload;
}
