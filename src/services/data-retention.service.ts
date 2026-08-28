import type pg from "pg";

export class DataRetentionService {
  constructor(private readonly pool: pg.Pool, private readonly retentionDays: number) {}

  async runOnce(): Promise<{ messages: number; jobs: number; audits: number; contacts: number; sessions: number }> {
    const interval = `${this.retentionDays} days`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const messages = await client.query("DELETE FROM messages WHERE created_at < now() - $1::interval", [interval]);
      const jobs = await client.query("DELETE FROM webhook_jobs WHERE created_at < now() - $1::interval", [interval]);
      const audits = await client.query("DELETE FROM audit_logs WHERE created_at < now() - $1::interval", [interval]);
      await client.query(
        `DELETE FROM coordinator_notifications
         WHERE created_at < now() - $1::interval AND status IN ('sent', 'failed')`,
        [interval],
      );
      const contacts = await client.query(
        `DELETE FROM contacts c
         WHERE c.updated_at < now() - $1::interval
           AND NOT EXISTS (
             SELECT 1 FROM conversations cv
             WHERE cv.contact_id = c.id AND (cv.status = 'open' OR cv.last_interaction_at >= now() - $1::interval)
           )
           AND NOT EXISTS (
             SELECT 1 FROM leads l
             WHERE l.contact_id = c.id AND (l.followup_enabled = true OR l.enrollment_status = 'pending')
           )`,
        [interval],
      );
      const sessions = await client.query("DELETE FROM dashboard_sessions WHERE expires_at < now() - interval '1 day'");
      await client.query("COMMIT");
      return {
        messages: messages.rowCount ?? 0,
        jobs: jobs.rowCount ?? 0,
        audits: audits.rowCount ?? 0,
        contacts: contacts.rowCount ?? 0,
        sessions: sessions.rowCount ?? 0,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
