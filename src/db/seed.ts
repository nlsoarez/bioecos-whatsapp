import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BIOECOS_PROJECT, DEBORA_SYSTEM_PROMPT, PIPELINE_STAGES, TAG_METADATA } from "../config/bioecos.js";
import { loadEnv } from "../config/env.js";
import { createPool } from "./client.js";

const env = loadEnv();
const pool = createPool(env);
const knowledge = await readFile(resolve("config/bioecos-knowledge.md"), "utf8");
const contentHash = createHash("sha256").update(knowledge).digest("hex");

function splitSections(markdown: string): Array<{ title: string; content: string }> {
  return markdown
    .split(/\n(?=## )/)
    .map((section) => {
      const [heading = "", ...body] = section.split("\n");
      return { title: heading.replace(/^#+\s*/, "").trim(), content: body.join("\n").trim() };
    })
    .filter((section) => section.content.length > 0);
}

const client = await pool.connect();
try {
  await client.query("BEGIN");
  const projectResult = await client.query<{ id: string }>(
    `INSERT INTO projects(slug, name, organization) VALUES ($1, $2, $3)
     ON CONFLICT(slug) DO UPDATE SET name = excluded.name, organization = excluded.organization, updated_at = now()
     RETURNING id`,
    [BIOECOS_PROJECT.slug, BIOECOS_PROJECT.name, BIOECOS_PROJECT.organization],
  );
  const projectId = projectResult.rows[0]!.id;

  await client.query(
    `INSERT INTO agents(project_id, slug, name, system_prompt, provider, model)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT(project_id, slug) DO UPDATE SET name = excluded.name, system_prompt = excluded.system_prompt,
       provider = excluded.provider, model = excluded.model, updated_at = now()`,
    [projectId, BIOECOS_PROJECT.agentSlug, BIOECOS_PROJECT.agentName, DEBORA_SYSTEM_PROMPT, env.AI_PROVIDER, env.AI_MODEL],
  );

  for (const [position, name] of PIPELINE_STAGES.entries()) {
    await client.query(
      `INSERT INTO pipeline_stages(project_id, name, position) VALUES ($1, $2, $3)
       ON CONFLICT(project_id, name) DO UPDATE SET position = excluded.position`,
      [projectId, name, position],
    );
  }

  for (const [name, meta] of Object.entries(TAG_METADATA)) {
    await client.query(
      `INSERT INTO tags(project_id, name, color, description) VALUES ($1, $2, $3, $4)
       ON CONFLICT(project_id, name) DO UPDATE SET color = excluded.color, description = excluded.description`,
      [projectId, name, meta.color, meta.description],
    );
  }

  const previousDocument = await client.query<{ id: string; content_hash: string }>(
    "SELECT id, content_hash FROM knowledge_documents WHERE project_id = $1 AND slug = 'bioecos-base'",
    [projectId],
  );
  const documentResult = await client.query<{ id: string }>(
    `INSERT INTO knowledge_documents(project_id, slug, title, source, content_hash)
     VALUES ($1, 'bioecos-base', 'Base de Conhecimento — Bioecos', 'config/bioecos-knowledge.md', $2)
     ON CONFLICT(project_id, slug) DO UPDATE SET title = excluded.title, source = excluded.source,
       content_hash = excluded.content_hash, active = true, updated_at = now() RETURNING id`,
    [projectId, contentHash],
  );
  const documentId = documentResult.rows[0]!.id;
  if (previousDocument.rows[0]?.content_hash !== contentHash) {
    await client.query("DELETE FROM knowledge_chunks WHERE document_id = $1", [documentId]);
    for (const [index, section] of splitSections(knowledge).entries()) {
      await client.query(
        `INSERT INTO knowledge_chunks(document_id, chunk_index, title, content, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [documentId, index, section.title, section.content, JSON.stringify({ source: "official" })],
      );
    }
  }

  await client.query(
    `INSERT INTO template_imports(project_id, template_key, content_hash)
     VALUES ($1, 'bioecos-v1', $2) ON CONFLICT DO NOTHING`,
    [projectId, contentHash],
  );
  await client.query("COMMIT");
  console.info("Bioecos seed imported idempotently");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
