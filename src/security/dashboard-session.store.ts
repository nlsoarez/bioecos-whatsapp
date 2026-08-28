import type pg from "pg";
import type { SessionPayload } from "./dashboard-auth.js";

export interface DashboardSessionStore {
  register(payload: SessionPayload): Promise<void>;
  isActive(payload: SessionPayload, now?: Date): Promise<boolean>;
  revoke(payload: SessionPayload): Promise<void>;
}

export class MemoryDashboardSessionStore implements DashboardSessionStore {
  private readonly sessions = new Map<string, { username: string; expiresAt: number; revoked: boolean }>();

  async register(payload: SessionPayload): Promise<void> {
    this.sessions.set(payload.nonce, { username: payload.sub, expiresAt: payload.exp, revoked: false });
    this.cleanup(Date.now());
  }

  async isActive(payload: SessionPayload, now = new Date()): Promise<boolean> {
    const session = this.sessions.get(payload.nonce);
    return Boolean(session && !session.revoked && session.username === payload.sub && session.expiresAt > now.getTime());
  }

  async revoke(payload: SessionPayload): Promise<void> {
    const session = this.sessions.get(payload.nonce);
    if (session) session.revoked = true;
  }

  private cleanup(now: number): void {
    for (const [nonce, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(nonce);
    }
  }
}

export class PostgresDashboardSessionStore implements DashboardSessionStore {
  constructor(private readonly pool: pg.Pool) {}

  async register(payload: SessionPayload): Promise<void> {
    await this.pool.query(
      `INSERT INTO dashboard_sessions(nonce, username, expires_at)
       VALUES ($1, $2, $3) ON CONFLICT(nonce) DO NOTHING`,
      [payload.nonce, payload.sub, new Date(payload.exp)],
    );
    await this.pool.query("DELETE FROM dashboard_sessions WHERE expires_at < now() - interval '1 day'");
  }

  async isActive(payload: SessionPayload, now = new Date()): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM dashboard_sessions
       WHERE nonce = $1 AND username = $2 AND revoked_at IS NULL AND expires_at > $3`,
      [payload.nonce, payload.sub, now],
    );
    return Boolean(result.rowCount);
  }

  async revoke(payload: SessionPayload): Promise<void> {
    await this.pool.query(
      "UPDATE dashboard_sessions SET revoked_at = now() WHERE nonce = $1 AND username = $2",
      [payload.nonce, payload.sub],
    );
  }
}
