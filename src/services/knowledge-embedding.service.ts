import type pg from "pg";
import type { AgentClient } from "./openai.service.js";

export interface KnowledgeEmbeddingStatus {
  total: number;
  embedded: number;
  pending: number;
  running: boolean;
  lastError: string | null;
  updatedAt: string | null;
}

export class KnowledgeEmbeddingService {
  private running = false;
  private lastError: string | null = null;
  private updatedAt: string | null = null;

  constructor(private readonly pool: pg.Pool, private readonly agent: AgentClient) {}

  async status(): Promise<KnowledgeEmbeddingStatus> {
    const result = await this.pool.query<{ total: number; embedded: number; pending: number }>(
      `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE kc.embedding IS NOT NULL)::int AS embedded,
        count(*) FILTER (WHERE kc.embedding IS NULL)::int AS pending
       FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id WHERE kd.active = true`,
    );
    const row = result.rows[0] ?? { total: 0, embedded: 0, pending: 0 };
    return { ...row, running: this.running, lastError: this.lastError, updatedAt: this.updatedAt };
  }

  async runPending(limit = 500): Promise<KnowledgeEmbeddingStatus> {
    if (this.running) return this.status();
    this.running = true;
    this.lastError = null;
    try {
      const chunks = await this.pool.query<{ id: string; title: string; content: string }>(
        `SELECT kc.id, kc.title, kc.content FROM knowledge_chunks kc
         JOIN knowledge_documents kd ON kd.id = kc.document_id
         WHERE kd.active = true AND kc.embedding IS NULL
         ORDER BY kc.document_id, kc.chunk_index LIMIT $1`,
        [Math.max(1, Math.min(limit, 2_000))],
      );
      for (const chunk of chunks.rows) {
        const embedding = await this.agent.embed(`${chunk.title}\n\n${chunk.content}`);
        if (!embedding || embedding.length !== 1536) throw new Error(`Embedding inválido para o chunk ${chunk.id}`);
        await this.pool.query("UPDATE knowledge_chunks SET embedding = $2::vector WHERE id = $1", [chunk.id, `[${embedding.join(",")}]`]);
      }
      this.updatedAt = new Date().toISOString();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    } finally {
      this.running = false;
    }
    return this.status();
  }
}
