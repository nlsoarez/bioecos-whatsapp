import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import JSZip from "jszip";
import pdfParse from "pdf-parse/lib/pdf-parse.js";
import type pg from "pg";
import type { KnowledgeEmbeddingService } from "./knowledge-embedding.service.js";

export const KNOWLEDGE_KINDS = ["knowledge", "course", "qa", "institutional", "rule", "procedure", "document"] as const;
export type KnowledgeKind = typeof KNOWLEDGE_KINDS[number];

export interface ManagedKnowledgeInput {
  kind: KnowledgeKind;
  category: string;
  title: string;
  content: string;
  courseName: string | null;
  structuredData: Record<string, string | null>;
  active: boolean;
  confirmConflict?: boolean;
}

export interface ManagedDocumentInput {
  filename: string;
  mimeType: string;
  base64: string;
  title: string;
  category: string;
  courseName: string | null;
  active: boolean;
}

export interface KnowledgeMediaInput {
  entryId: string | null;
  courseName: string | null;
  category: string;
  description: string;
  keywords: string[];
  filename?: string;
  mimeType?: string;
  base64?: string;
  active: boolean;
}

export interface KnowledgeMediaFile {
  id: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  description: string;
  courseName: string | null;
}

export interface KnowledgeManagement {
  list(search?: string, kind?: string): Promise<unknown[]>;
  create(input: ManagedKnowledgeInput, actor: string): Promise<unknown>;
  update(id: string, input: ManagedKnowledgeInput, actor: string): Promise<unknown | null>;
  remove(id: string, actor: string): Promise<boolean>;
  history(id?: string): Promise<unknown[]>;
  uploadDocument(input: ManagedDocumentInput, actor: string): Promise<unknown>;
  listMedia(search?: string): Promise<unknown[]>;
  createMedia(input: KnowledgeMediaInput, actor: string): Promise<unknown>;
  updateMedia(id: string, input: KnowledgeMediaInput, actor: string): Promise<unknown | null>;
  removeMedia(id: string, actor: string): Promise<boolean>;
  getMediaFile(id: string): Promise<KnowledgeMediaFile | null>;
  findRelevantMedia(query: string): Promise<KnowledgeMediaFile | null>;
}

const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_DOCUMENT_TEXT = 120_000;
const MAX_DOCX_UNCOMPRESSED = 20 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MANAGED_SOURCE = "portal-managed";

export class DuplicateKnowledgeError extends Error {
  constructor() { super("Este conteúdo adicional já está cadastrado"); }
}

export class UnsafeKnowledgeError extends Error {
  constructor(message = "O documento contém instruções inseguras e não foi publicado") { super(message); }
}

export class PostgresKnowledgeManagementService implements KnowledgeManagement {
  constructor(private readonly pool: pg.Pool, private readonly embeddings?: KnowledgeEmbeddingService) {}

  async list(search = "", kind = ""): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT m.id, m.kind, m.category, m.title, m.content, m.course_name AS "courseName",
        m.structured_data AS "structuredData", m.status, m.active, m.conflict_details AS "conflictDetails",
        m.source_filename AS "sourceFilename", m.source_mime AS "sourceMime", m.source_size AS "sourceSize",
        m.created_by AS "createdBy", m.updated_by AS "updatedBy", m.created_at AS "createdAt", m.updated_at AS "updatedAt",
        count(km.id) FILTER (WHERE km.deleted_at IS NULL)::int AS "imageCount"
       FROM managed_knowledge_entries m
       JOIN projects p ON p.id = m.project_id AND p.slug = 'bioecos'
       LEFT JOIN knowledge_media km ON km.entry_id = m.id
       WHERE m.deleted_at IS NULL AND ($1 = '' OR m.kind = $1)
         AND ($2 = '' OR to_tsvector('portuguese', m.title || ' ' || m.content || ' ' || coalesce(m.course_name, '') || ' ' || m.category)
           @@ websearch_to_tsquery('portuguese', $2) OR m.title ILIKE '%' || $2 || '%')
       GROUP BY m.id ORDER BY m.updated_at DESC LIMIT 250`,
      [kind, search],
    );
    return result.rows;
  }

  async create(input: ManagedKnowledgeInput, actor: string): Promise<unknown> {
    const normalized = normalizeKnowledgeInput(input);
    const conflictDetails = await this.detectConflict(normalized);
    if (conflictDetails && normalized.active && !input.confirmConflict) normalized.active = false;
    const id = randomUUID();
    const documentId = randomUUID();
    const slug = `portal-${id}`;
    const contentHash = hashKnowledge(normalized);
    const status = conflictDetails && !input.confirmConflict ? "conflict" : normalized.active ? "processing" : "inactive";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await projectId(client);
      await client.query(
        `INSERT INTO knowledge_documents(id, project_id, slug, title, source, content_hash, active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [documentId, project, slug, normalized.title, `${MANAGED_SOURCE}:${normalized.kind}`, contentHash, normalized.active],
      );
      await client.query(
        `INSERT INTO managed_knowledge_entries(id, project_id, document_id, kind, category, title, content, course_name,
          structured_data, status, active, conflict_details, content_hash, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)`,
        [id, project, documentId, normalized.kind, normalized.category, normalized.title, normalized.content,
          normalized.courseName, normalized.structuredData, status, normalized.active, conflictDetails, contentHash, actor],
      );
      await replaceChunks(client, documentId, normalized);
      await writeVersion(client, id, actor);
      await audit(client, project, actor, "knowledge.created", { entryId: id, kind: normalized.kind, status });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) throw new DuplicateKnowledgeError();
      throw error;
    } finally { client.release(); }
    this.triggerEmbeddings(normalized.active && status === "processing");
    return (await this.listById(id))!;
  }

  async update(id: string, input: ManagedKnowledgeInput, actor: string): Promise<unknown | null> {
    const normalized = normalizeKnowledgeInput(input);
    const conflictDetails = await this.detectConflict(normalized);
    if (conflictDetails && normalized.active && !input.confirmConflict) normalized.active = false;
    const contentHash = hashKnowledge(normalized);
    const status = conflictDetails && !input.confirmConflict ? "conflict" : normalized.active ? "processing" : "inactive";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ document_id: string; project_id: string }>(
        `SELECT m.document_id, m.project_id FROM managed_knowledge_entries m JOIN projects p ON p.id=m.project_id
         WHERE m.id=$1 AND p.slug='bioecos' AND m.deleted_at IS NULL FOR UPDATE`, [id],
      );
      if (!current.rows[0]) { await client.query("ROLLBACK"); return null; }
      const { document_id: documentId, project_id: project } = current.rows[0];
      await client.query(
        `UPDATE managed_knowledge_entries SET kind=$2, category=$3, title=$4, content=$5, course_name=$6,
          structured_data=$7, status=$8, active=$9, conflict_details=$10, content_hash=$11, updated_by=$12, updated_at=now()
         WHERE id=$1`,
        [id, normalized.kind, normalized.category, normalized.title, normalized.content, normalized.courseName,
          normalized.structuredData, status, normalized.active, conflictDetails, contentHash, actor],
      );
      await client.query(
        `UPDATE knowledge_documents SET title=$2, source=$3, content_hash=$4, active=$5, updated_at=now() WHERE id=$1`,
        [documentId, normalized.title, `${MANAGED_SOURCE}:${normalized.kind}`, contentHash, normalized.active],
      );
      await client.query("DELETE FROM knowledge_chunks WHERE document_id=$1", [documentId]);
      await replaceChunks(client, documentId, normalized);
      await writeVersion(client, id, actor);
      await audit(client, project, actor, "knowledge.updated", { entryId: id, status });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) throw new DuplicateKnowledgeError();
      throw error;
    } finally { client.release(); }
    this.triggerEmbeddings(normalized.active && status === "processing");
    return this.listById(id);
  }

  async remove(id: string, actor: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ document_id: string; project_id: string }>(
        `UPDATE managed_knowledge_entries m SET active=false, status='inactive', deleted_at=now(), updated_by=$2, updated_at=now()
         FROM projects p WHERE m.id=$1 AND p.id=m.project_id AND p.slug='bioecos' AND m.deleted_at IS NULL
         RETURNING m.document_id, m.project_id`, [id, actor],
      );
      if (!result.rows[0]) { await client.query("ROLLBACK"); return false; }
      await client.query("UPDATE knowledge_documents SET active=false, updated_at=now() WHERE id=$1", [result.rows[0].document_id]);
      await audit(client, result.rows[0].project_id, actor, "knowledge.deleted", { entryId: id });
      await client.query("COMMIT");
      return true;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async history(id = ""): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT v.id, v.entry_id AS "entryId", v.version, v.snapshot, v.actor, v.created_at AS "createdAt"
       FROM managed_knowledge_versions v JOIN managed_knowledge_entries m ON m.id=v.entry_id
       JOIN projects p ON p.id=m.project_id AND p.slug='bioecos'
       WHERE ($1='' OR v.entry_id::text=$1) ORDER BY v.created_at DESC LIMIT 250`, [id],
    );
    return result.rows;
  }

  async uploadDocument(input: ManagedDocumentInput, actor: string): Promise<unknown> {
    const parsed = await extractManagedDocument(input.filename, input.mimeType, input.base64);
    const created = await this.create({ kind: "document", category: input.category, title: input.title,
      content: parsed.text, courseName: input.courseName, structuredData: {}, active: input.active }, actor) as { id?: string };
    if (!created.id) return created;
    const buffer = decodeBase64(input.base64, MAX_DOCUMENT_BYTES);
    try {
      await this.pool.query(
        `UPDATE managed_knowledge_entries m SET source_filename=$2, source_mime=$3, source_size=$4, source_data=$5
         FROM projects p WHERE m.id=$1 AND p.id=m.project_id AND p.slug='bioecos'`,
        [created.id, parsed.filename, parsed.mimeType, buffer.length, buffer],
      );
    } catch (error) {
      await this.remove(created.id, `${actor}:upload-rollback`).catch(() => false);
      throw error;
    }
    return this.listById(created.id);
  }

  async listMedia(search = ""): Promise<unknown[]> {
    const result = await this.pool.query(
      `SELECT km.id, km.entry_id AS "entryId", km.course_name AS "courseName", km.category, km.description,
        km.keywords, km.filename, km.mime_type AS "mimeType", km.byte_size AS "byteSize", km.active,
        km.created_at AS "createdAt", km.updated_at AS "updatedAt"
       FROM knowledge_media km JOIN projects p ON p.id=km.project_id AND p.slug='bioecos'
       WHERE km.deleted_at IS NULL AND ($1='' OR to_tsvector('portuguese', km.description || ' ' || coalesce(km.course_name,'') || ' ' || km.category)
         @@ websearch_to_tsquery('portuguese',$1) OR km.filename ILIKE '%' || $1 || '%'
         OR EXISTS (SELECT 1 FROM unnest(km.keywords) keyword WHERE keyword ILIKE '%' || $1 || '%'))
       ORDER BY km.updated_at DESC LIMIT 250`, [search],
    );
    return result.rows;
  }

  async createMedia(input: KnowledgeMediaInput, actor: string): Promise<unknown> {
    const file = validateManagedImage(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await projectId(client);
      await assertManagedEntry(client, project, input.entryId);
      const result = await client.query<{ id: string }>(
        `INSERT INTO knowledge_media(project_id, entry_id, course_name, category, description, keywords, filename,
          mime_type, byte_size, sha256, data, active, created_by, updated_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING id`,
        [project, input.entryId, nullable(input.courseName), cleanShort(input.category, 80, "Geral"), cleanText(input.description, 1_000),
          cleanKeywords(input.keywords), file.filename, file.mimeType, file.data.length, file.sha256, file.data, input.active, actor],
      );
      await audit(client, project, actor, "knowledge.media_created", { mediaId: result.rows[0]!.id, entryId: input.entryId });
      await client.query("COMMIT");
      return (await this.listMedia()).find((item) => (item as { id: string }).id === result.rows[0]!.id)!;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isUniqueViolation(error)) throw new DuplicateKnowledgeError();
      throw error;
    } finally { client.release(); }
  }

  async updateMedia(id: string, input: KnowledgeMediaInput, actor: string): Promise<unknown | null> {
    const replacement = input.base64 ? validateManagedImage(input) : null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await projectId(client);
      await assertManagedEntry(client, project, input.entryId);
      const result = await client.query(
        `UPDATE knowledge_media SET entry_id=$3, course_name=$4, category=$5, description=$6, keywords=$7, active=$8,
          filename=coalesce($9,filename), mime_type=coalesce($10,mime_type), byte_size=coalesce($11,byte_size),
          sha256=coalesce($12,sha256), data=coalesce($13,data), updated_by=$14, updated_at=now()
         WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL RETURNING id`,
        [id, project, input.entryId, nullable(input.courseName), cleanShort(input.category, 80, "Geral"),
          cleanText(input.description, 1_000), cleanKeywords(input.keywords), input.active, replacement?.filename ?? null,
          replacement?.mimeType ?? null, replacement?.data.length ?? null, replacement?.sha256 ?? null, replacement?.data ?? null, actor],
      );
      if (!result.rowCount) { await client.query("ROLLBACK"); return null; }
      await audit(client, project, actor, "knowledge.media_updated", { mediaId: id, entryId: input.entryId });
      await client.query("COMMIT");
      return (await this.listMedia()).find((item) => (item as { id: string }).id === id) ?? null;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  async removeMedia(id: string, actor: string): Promise<boolean> {
    const result = await this.pool.query<{ project_id: string }>(
      `UPDATE knowledge_media km SET active=false, deleted_at=now(), updated_by=$2, updated_at=now()
       FROM projects p WHERE km.id=$1 AND p.id=km.project_id AND p.slug='bioecos' AND km.deleted_at IS NULL
       RETURNING km.project_id`, [id, actor],
    );
    if (result.rows[0]) await audit(this.pool, result.rows[0].project_id, actor, "knowledge.media_deleted", { mediaId: id });
    return Boolean(result.rowCount);
  }

  async getMediaFile(id: string): Promise<KnowledgeMediaFile | null> {
    const result = await this.pool.query<{ id: string; filename: string; mime_type: string; data: Buffer; description: string; course_name: string | null }>(
      `SELECT km.id, km.filename, km.mime_type, km.data, km.description, km.course_name
       FROM knowledge_media km JOIN projects p ON p.id=km.project_id AND p.slug='bioecos'
       WHERE km.id=$1 AND km.deleted_at IS NULL`, [id],
    );
    const row = result.rows[0];
    return row ? { id: row.id, filename: row.filename, mimeType: row.mime_type, data: row.data,
      description: row.description, courseName: row.course_name } : null;
  }

  async findRelevantMedia(query: string): Promise<KnowledgeMediaFile | null> {
    const value = cleanText(query, 500);
    const result = await this.pool.query<{ id: string; filename: string; mime_type: string; data: Buffer; description: string; course_name: string | null }>(
      `SELECT km.id, km.filename, km.mime_type, km.data, km.description, km.course_name
       FROM knowledge_media km JOIN projects p ON p.id=km.project_id AND p.slug='bioecos'
       WHERE km.active=true AND km.deleted_at IS NULL AND (
         to_tsvector('portuguese', km.description || ' ' || coalesce(km.course_name,'') || ' ' || km.category)
           @@ websearch_to_tsquery('portuguese',$1)
         OR EXISTS (SELECT 1 FROM unnest(km.keywords) keyword WHERE keyword ILIKE '%' || $1 || '%')
         OR ($2 <> '' AND km.course_name ILIKE '%' || $2 || '%'))
       ORDER BY ts_rank_cd(to_tsvector('portuguese', km.description || ' ' || coalesce(km.course_name,'') || ' ' || km.category),
         websearch_to_tsquery('portuguese',$1)) DESC, km.updated_at DESC LIMIT 1`,
      [value || "imagem", extractCourseTerm(value)],
    );
    const row = result.rows[0];
    return row ? { id: row.id, filename: row.filename, mimeType: row.mime_type, data: row.data,
      description: row.description, courseName: row.course_name } : null;
  }

  private async listById(id: string): Promise<unknown | null> {
    const rows = await this.list();
    return rows.find((item) => (item as { id: string }).id === id) ?? null;
  }

  private async detectConflict(input: ManagedKnowledgeInput): Promise<string | null> {
    if (!input.courseName || input.kind !== "course") return null;
    const result = await this.pool.query<{ content: string }>(
      `SELECT kc.title || ' ' || kc.content AS content FROM knowledge_chunks kc
       JOIN knowledge_documents kd ON kd.id=kc.document_id JOIN projects p ON p.id=kd.project_id
       WHERE p.slug='bioecos' AND kd.source LIKE 'config/knowledge/%' AND kd.active=true
         AND (kc.title ILIKE '%' || $1 || '%' OR kc.content ILIKE '%' || $1 || '%')`, [input.courseName],
    );
    if (!result.rowCount) return null;
    const original = result.rows.map((row) => normalizeComparable(row.content)).join(" ");
    const labels: Record<string, RegExp> = {
      workload: /carga horaria/, duration: /duracao/, price: /preco|valor|r\$/, dates: /data|calendario|turma/,
      schedule: /horario/, location: /local|chacara/, prerequisites: /pre requisito|experiencia/, availability: /vaga|disponibilidade/,
      modality: /modalidade|presencial|online|distancia/,
    };
    const conflicts: string[] = [];
    for (const [field, label] of Object.entries(labels)) {
      const value = input.structuredData[field];
      if (value && label.test(original) && !original.includes(normalizeComparable(value))) conflicts.push(field);
    }
    return conflicts.length ? `Possível divergência com a base original nos campos: ${conflicts.join(", ")}. Confirme após revisão.` : null;
  }

  private triggerEmbeddings(run: boolean): void {
    if (run && this.embeddings) void this.embeddings.runPending();
  }
}

function normalizeKnowledgeInput(input: ManagedKnowledgeInput): ManagedKnowledgeInput {
  const normalized = {
    kind: input.kind,
    category: cleanShort(input.category, 80, "Geral"),
    title: cleanShort(input.title, 180),
    content: cleanText(input.content, MAX_DOCUMENT_TEXT),
    courseName: nullable(input.courseName),
    structuredData: Object.fromEntries(Object.entries(input.structuredData ?? {}).map(([key, value]) => [key, nullable(value)])),
    active: Boolean(input.active),
    ...(input.confirmConflict === undefined ? {} : { confirmConflict: Boolean(input.confirmConflict) }),
  } satisfies ManagedKnowledgeInput;
  assertSafeKnowledgeContent(`${normalized.title}\n${normalized.content}`);
  if (normalized.content.length < 10) throw new Error("O conteúdo deve ter ao menos 10 caracteres");
  return normalized;
}

async function replaceChunks(client: pg.PoolClient, documentId: string, input: ManagedKnowledgeInput): Promise<void> {
  const structured = Object.entries(input.structuredData).filter(([, value]) => value).map(([key, value]) => `${key}: ${value}`).join("\n");
  const full = [input.courseName ? `Curso: ${input.courseName}` : "", structured, input.content].filter(Boolean).join("\n\n");
  const chunks = splitContent(full);
  for (const [index, content] of chunks.entries()) {
    await client.query(
      `INSERT INTO knowledge_chunks(document_id, chunk_index, title, content, metadata)
       VALUES($1,$2,$3,$4,$5)`,
      [documentId, index, input.title, content, JSON.stringify({ source: "portal-managed", kind: input.kind,
        category: input.category, courseName: input.courseName, untrustedInstructions: true })],
    );
  }
}

function splitContent(content: string): string[] {
  const paragraphs = content.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if ((current + "\n\n" + paragraph).length > 2_400 && current) { chunks.push(current); current = paragraph; }
    else current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) chunks.push(current);
  return chunks.flatMap((chunk) => chunk.length <= 3_000 ? [chunk] : chunk.match(/[\s\S]{1,3000}/g) ?? []);
}

async function writeVersion(client: pg.PoolClient, id: string, actor: string): Promise<void> {
  await client.query(
    `INSERT INTO managed_knowledge_versions(entry_id, version, snapshot, actor)
     SELECT m.id, coalesce((SELECT max(v.version)+1 FROM managed_knowledge_versions v WHERE v.entry_id=m.id),1),
       jsonb_build_object('kind',m.kind,'category',m.category,'title',m.title,'content',m.content,'courseName',m.course_name,
         'structuredData',m.structured_data,'status',m.status,'active',m.active,'conflictDetails',m.conflict_details), $2
     FROM managed_knowledge_entries m WHERE m.id=$1`, [id, actor],
  );
}

async function projectId(client: pg.PoolClient): Promise<string> {
  const result = await client.query<{ id: string }>("SELECT id FROM projects WHERE slug='bioecos'");
  if (!result.rows[0]) throw new Error("Projeto Bioecos não encontrado");
  return result.rows[0].id;
}

async function assertManagedEntry(client: pg.PoolClient, project: string, entryId: string | null): Promise<void> {
  if (!entryId) return;
  const result = await client.query("SELECT 1 FROM managed_knowledge_entries WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL", [entryId, project]);
  if (!result.rowCount) throw new Error("Conhecimento associado não encontrado");
}

async function audit(client: Pick<pg.Pool, "query"> | pg.PoolClient, project: string, actor: string, action: string, details: unknown): Promise<void> {
  await client.query("INSERT INTO audit_logs(project_id,actor,action,details) VALUES($1,$2,$3,$4)", [project, actor, action, details]);
}

export async function extractManagedDocument(filenameInput: string, mimeInput: string, base64: string): Promise<{ filename: string; mimeType: string; text: string }> {
  const filename = safeFilename(filenameInput);
  const mimeType = mimeInput.toLowerCase().trim();
  const extension = extname(filename).toLowerCase();
  const data = decodeBase64(base64, MAX_DOCUMENT_BYTES);
  let text = "";
  if ([".txt", ".md", ".csv", ".json"].includes(extension) && ["text/plain", "text/markdown", "text/csv", "application/json"].includes(mimeType)) {
    if (data.includes(0)) throw new Error("Arquivo de texto inválido");
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } else if (extension === ".pdf" && mimeType === "application/pdf" && data.subarray(0, 5).toString() === "%PDF-") {
    const parsed = await pdfParse(data);
    if (parsed.numpages > 100) throw new Error("PDF excede o limite de 100 páginas");
    text = parsed.text;
  } else if (extension === ".docx" && mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" && isZip(data)) {
    text = await extractDocx(data);
  } else {
    throw new Error("Documento inválido. Use TXT, MD, CSV, JSON, PDF ou DOCX sem macros");
  }
  text = cleanText(text, MAX_DOCUMENT_TEXT);
  assertSafeKnowledgeContent(text);
  if (text.length < 20) throw new Error("Não foi possível extrair conteúdo suficiente do documento");
  return { filename, mimeType, text };
}

async function extractDocx(data: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(data, { checkCRC32: true });
  const total = Object.values(zip.files).reduce((sum, entry) => {
    const internal = entry as unknown as { _data?: { uncompressedSize?: number } };
    return sum + Number(internal._data?.uncompressedSize ?? 0);
  }, 0);
  if (total > MAX_DOCX_UNCOMPRESSED) throw new Error("DOCX excede o limite descompactado");
  if (zip.file("word/vbaProject.bin")) throw new Error("Documentos com macros não são permitidos");
  const document = zip.file("word/document.xml");
  if (!document) throw new Error("DOCX inválido");
  const xml = await document.async("string");
  return decodeXml(xml.replace(/<w:tab\s*\/>/g, "\t").replace(/<\/w:p>/g, "\n").replace(/<[^>]+>/g, ""));
}

export function validateManagedImage(input: KnowledgeMediaInput): { filename: string; mimeType: string; data: Buffer; sha256: string } {
  if (!input.filename || !input.mimeType || !input.base64) throw new Error("Selecione uma imagem");
  const filename = safeFilename(input.filename);
  const mimeType = input.mimeType.toLowerCase().trim();
  const data = decodeBase64(input.base64, MAX_IMAGE_BYTES);
  const valid = mimeType === "image/png" ? isPng(data) : mimeType === "image/jpeg" ? isJpeg(data) : mimeType === "image/webp" ? isWebp(data) : false;
  if (!valid) throw new Error("Imagem inválida. Use PNG, JPG ou WebP legítimo");
  return { filename, mimeType, data, sha256: createHash("sha256").update(data).digest("hex") };
}

function decodeBase64(value: string, maxBytes: number): Buffer {
  const raw = value.replace(/^data:[^;]+;base64,/, "").replace(/\s/g, "");
  if (!raw || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new Error("Arquivo em Base64 inválido");
  if (raw.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new Error("Arquivo excede o limite permitido");
  const data = Buffer.from(raw, "base64");
  if (!data.length || data.length > maxBytes) throw new Error("Arquivo excede o limite permitido");
  return data;
}

function assertSafeKnowledgeContent(value: string): void {
  const unsafe = /ignore\s+(todas\s+)?(as\s+)?instru[cç][oõ]es\s+anteriores|revele?\s+(o\s+)?(system|prompt)|jailbreak|<script\b|javascript\s*:/i;
  if (unsafe.test(value)) throw new UnsafeKnowledgeError();
}

function hashKnowledge(input: ManagedKnowledgeInput): string {
  return createHash("sha256").update(JSON.stringify({ kind: input.kind, category: input.category, title: input.title,
    content: input.content, courseName: input.courseName, structuredData: input.structuredData })).digest("hex");
}

function cleanShort(value: string, max: number, fallback = ""): string {
  const cleaned = cleanText(value, max);
  if (!cleaned && !fallback) throw new Error("Campo obrigatório não informado");
  return cleaned || fallback;
}

function cleanText(value: string, max: number): string {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").replace(/\r\n/g, "\n").trim().slice(0, max);
}

function cleanKeywords(values: string[]): string[] {
  return [...new Set(values.map((value) => cleanShort(value, 50)).filter(Boolean))].slice(0, 20);
}

function nullable(value: unknown): string | null {
  const cleaned = typeof value === "string" ? cleanText(value, 2_000) : "";
  return cleaned || null;
}

function safeFilename(value: string): string {
  const name = basename(value).replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 180);
  if (!name || name.startsWith(".")) throw new Error("Nome de arquivo inválido");
  return name;
}

function isPng(data: Buffer) {
  return data.length >= 45 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    && data.subarray(12, 16).toString() === "IHDR" && data.includes(Buffer.from("IEND"));
}
function isJpeg(data: Buffer) {
  return data.length >= 4 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    && data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9;
}
function isWebp(data: Buffer) {
  const declaredLength = data.length >= 8 ? data.readUInt32LE(4) + 8 : 0;
  return data.length >= 20 && data.subarray(0,4).toString() === "RIFF" && data.subarray(8,12).toString() === "WEBP"
    && declaredLength <= data.length && /^VP8[ LX]$/.test(data.subarray(12,16).toString());
}
function isZip(data: Buffer) { return data[0] === 0x50 && data[1] === 0x4b && [0x03,0x05,0x07].includes(data[2] ?? -1); }
function decodeXml(value: string) { return value.replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,"&"); }
function normalizeComparable(value: string) { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g," "); }
function extractCourseTerm(value: string) { return value.replace(/\b(imagem|foto|curso|desse|deste|tem|alguma|mostrar|envie|manda)\b/gi, " ").replace(/\s+/g," ").trim().slice(0,100); }
function isUniqueViolation(error: unknown): boolean { return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "23505"); }
