import type pg from "pg";

export class DataRetentionService {
  constructor(private readonly pool: pg.Pool, private readonly retentionDays: number) {}

  async runOnce(): Promise<{ messages: number; jobs: number; audits: number }> {
    const interval = `${this.retentionDays} days`;
    const [messages, jobs, audits] = await Promise.all([
      this.pool.query("DELETE FROM messages WHERE created_at < now() - $1::interval", [interval]),
      this.pool.query("DELETE FROM webhook_jobs WHERE created_at < now() - $1::interval", [interval]),
      this.pool.query("DELETE FROM audit_logs WHERE created_at < now() - $1::interval", [interval]),
    ]);
    return { messages: messages.rowCount ?? 0, jobs: jobs.rowCount ?? 0, audits: audits.rowCount ?? 0 };
  }
}
