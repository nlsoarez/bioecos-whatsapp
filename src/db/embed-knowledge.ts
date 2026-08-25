import { loadEnv } from "../config/env.js";
import { OpenAIResponsesClient } from "../services/openai.service.js";
import { createPool } from "./client.js";

const env = loadEnv();
if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY é obrigatória para gerar embeddings");
const pool = createPool(env);
const openai = new OpenAIResponsesClient(env);

try {
  const chunks = await pool.query<{ id: string; title: string; content: string }>(
    `SELECT kc.id, kc.title, kc.content FROM knowledge_chunks kc
     JOIN knowledge_documents kd ON kd.id = kc.document_id
     WHERE kd.active = true AND kc.embedding IS NULL ORDER BY kc.document_id, kc.chunk_index`,
  );
  for (const [index, chunk] of chunks.rows.entries()) {
    const embedding = await openai.embed(`${chunk.title}\n\n${chunk.content}`);
    if (!embedding || embedding.length !== 1536) throw new Error(`Embedding inválido para o chunk ${chunk.id}`);
    await pool.query("UPDATE knowledge_chunks SET embedding = $2::vector WHERE id = $1", [chunk.id, `[${embedding.join(",")}]`]);
    console.info(`Embedded ${index + 1}/${chunks.rowCount}`);
  }
} finally {
  await pool.end();
}

