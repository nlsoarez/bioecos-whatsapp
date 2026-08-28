import type pg from "pg";
import { randomUUID } from "node:crypto";
import { ALLOWED_TAGS, PIPELINE_STAGES, type AllowedTag, type PipelineStage } from "../domain/constants.js";
import type {
  ChatMessage, ContactContext, ConversationWorkflowState, CoordinatorNotificationRecord, InboundMessage,
  IngestResult, KnowledgeHit, LeadAssessment, LeadTemperature, MonthlyFollowupCandidate,
  MonthlyFollowupSettings, QualificationStep,
  OutboundWebhookMessage,
} from "../domain/types.js";
import type { BioecosRepository, ContactUpdate } from "./bioecos.repository.js";
import { PiiCipher } from "../security/pii-cipher.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export class PostgresRepository implements BioecosRepository {
  private readonly pii: PiiCipher;

  constructor(private readonly pool: pg.Pool, piiEncryptionKey: string) {
    this.pii = new PiiCipher(piiEncryptionKey);
  }

  async migrateLegacyPii(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('bioecos-pii-migration-v2'))");

      const contacts = await client.query<Record<string, string | null>>(
        "SELECT id, phone, name, email, city, state, cpf, company_name, profession FROM contacts FOR UPDATE",
      );
      for (const row of contacts.rows) {
        await client.query(
          `UPDATE contacts SET phone = $2, phone_hash = $3, name = $4, email = $5, city = $6, state = $7,
           cpf = $8, company_name = $9, profession = $10 WHERE id = $1`,
          [row.id, this.pii.encrypt(row.phone!), this.pii.phoneHash(this.pii.decrypt(row.phone!)),
            this.pii.encryptNullable(row.name), this.pii.encryptNullable(row.email), this.pii.encryptNullable(row.city),
            this.pii.encryptNullable(row.state), this.pii.encryptNullable(row.cpf), this.pii.encryptNullable(row.company_name),
            this.pii.encryptNullable(row.profession)],
        );
      }

      const leads = await client.query<Record<string, unknown>>(
        `SELECT id, area, interest, service, course, objective, notes, assigned_to, followup_last_error, outcome,
         main_questions, objections FROM leads FOR UPDATE`,
      );
      for (const row of leads.rows) {
        const encryptArray = (value: unknown) => Array.isArray(value)
          ? value.map((item) => typeof item === "string" ? this.pii.encrypt(item) : item)
          : [];
        await client.query(
          `UPDATE leads SET area = $2, interest = $3, service = $4, course = $5, objective = $6, notes = $7,
           assigned_to = $8, followup_last_error = $9, outcome = $10, main_questions = $11, objections = $12
           WHERE id = $1`,
          [row.id, this.pii.encryptNullable(row.area as string | null), this.pii.encryptNullable(row.interest as string | null),
            this.pii.encryptNullable(row.service as string | null), this.pii.encryptNullable(row.course as string | null),
            this.pii.encryptNullable(row.objective as string | null), this.pii.encryptNullable(row.notes as string | null),
            this.pii.encryptNullable(row.assigned_to as string | null), this.pii.encryptNullable(row.followup_last_error as string | null),
            this.pii.encryptNullable(row.outcome as string | null), JSON.stringify(encryptArray(row.main_questions)),
            JSON.stringify(encryptArray(row.objections))],
        );
      }

      for (const descriptor of [
        { table: "conversations", fields: ["summary", "handoff_reason"] },
        { table: "messages", fields: ["content"] },
        { table: "coordinator_notifications", fields: ["message", "last_error"] },
        { table: "followup_events", fields: ["content", "error"] },
        { table: "lead_temperature_history", fields: ["reason"] },
      ] as const) {
        const rows = await client.query<Record<string, string | null>>(
          `SELECT id, ${descriptor.fields.join(", ")} FROM ${descriptor.table} FOR UPDATE`,
        );
        for (const row of rows.rows) {
          const assignments = descriptor.fields.map((field, index) => `${field} = $${index + 2}`).join(", ");
          await client.query(
            `UPDATE ${descriptor.table} SET ${assignments} WHERE id = $1`,
            [row.id, ...descriptor.fields.map((field) => this.pii.encryptNullable(row[field]))],
          );
        }
      }

      const jobs = await client.query<{ id: string; payload: Record<string, unknown> }>("SELECT id, payload FROM webhook_jobs FOR UPDATE");
      for (const job of jobs.rows) {
        const message = job.payload.message as Record<string, unknown> | undefined;
        if (!message) continue;
        for (const field of ["phone", "pushName", "content"] as const) {
          if (typeof message[field] === "string") message[field] = this.pii.encrypt(message[field]);
        }
        await client.query("UPDATE webhook_jobs SET payload = $2 WHERE id = $1", [job.id, JSON.stringify(job.payload)]);
      }

      await client.query(
        `UPDATE audit_logs SET details = '{"redacted":true}'::jsonb
         WHERE action IN ('note.added', 'handoff.created', 'lead.assessed', 'pipeline.moved',
           'followup.cancelled', 'conversation.workflow_changed') AND details <> '{"redacted":true}'::jsonb`,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async health(): Promise<boolean> {
    await this.pool.query("SELECT 1");
    return true;
  }

  async ingestInbound(message: InboundMessage): Promise<IngestResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const project = await client.query<{ id: string }>("SELECT id FROM projects WHERE slug = 'bioecos'");
      if (!project.rows[0]) throw new Error("Projeto Bioecos não importado. Execute db:seed.");
      const projectId = project.rows[0].id;

      const phoneHash = this.pii.phoneHash(message.phone);
      const existingContact = await client.query<{ id: string }>(
        `SELECT id FROM contacts WHERE project_id = $1 AND (phone_hash = $2 OR phone = $3)
         LIMIT 1 FOR UPDATE`,
        [projectId, phoneHash, message.phone],
      );
      const contactResult = existingContact.rows[0]
        ? await client.query<{ id: string }>(
          `UPDATE contacts SET phone = $2, phone_hash = $3,
           name = coalesce(name, $4), updated_at = now() WHERE id = $1 RETURNING id`,
          [existingContact.rows[0].id, this.pii.encrypt(message.phone), phoneHash, this.pii.encryptNullable(message.pushName)],
        )
        : await client.query<{ id: string }>(
          `INSERT INTO contacts(project_id, phone, phone_hash, name, source)
           VALUES ($1, $2, $3, $4, 'whatsapp')
           ON CONFLICT(project_id, phone_hash) WHERE phone_hash IS NOT NULL DO UPDATE SET
             name = coalesce(contacts.name, excluded.name), updated_at = now()
           RETURNING id`,
          [projectId, this.pii.encrypt(message.phone), phoneHash, this.pii.encryptNullable(message.pushName)],
        );
      const contactId = contactResult.rows[0]!.id;

      const newStage = await client.query<{ id: string }>(
        "SELECT id FROM pipeline_stages WHERE project_id = $1 AND name = 'Novo contato'",
        [projectId],
      );
      const leadResult = await client.query<{ id: string }>(
        `INSERT INTO leads(contact_id, pipeline_stage_id) VALUES ($1, $2)
         ON CONFLICT(contact_id) DO UPDATE SET updated_at = now() RETURNING id`,
        [contactId, newStage.rows[0]!.id],
      );
      const leadId = leadResult.rows[0]!.id;

      const conversationResult = await client.query<{ id: string }>(
        `INSERT INTO conversations(contact_id) VALUES ($1)
         ON CONFLICT(contact_id) WHERE status = 'open'
         DO UPDATE SET last_interaction_at = now() RETURNING id`,
        [contactId],
      );
      const conversationId = conversationResult.rows[0]!.id;

      const inserted = await client.query(
        `INSERT INTO messages(conversation_id, external_message_id, direction, content, timestamp, metadata)
         VALUES ($1, $2, 'inbound', $3, $4, $5) ON CONFLICT(external_message_id) DO NOTHING RETURNING id`,
        [conversationId, message.externalMessageId, this.pii.encrypt(message.content), message.timestamp, JSON.stringify({ source: "evolution" })],
      );
      const duplicate = inserted.rowCount === 0;
      if (!duplicate) {
        await this.audit(client, projectId, contactId, conversationId, "system", "message.inbound", {
          externalMessageId: message.externalMessageId,
        });
      }
      const context = await this.loadContext(client, contactId, conversationId, leadId);
      await client.query("COMMIT");
      return { duplicate, context };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getRecentMessages(conversationId: string, limit: number): Promise<ChatMessage[]> {
    const result = await this.pool.query<{
      direction: "inbound" | "outbound";
      content: string;
      timestamp: Date;
    }>(
      `SELECT direction, content, timestamp FROM messages WHERE conversation_id = $1
       ORDER BY timestamp DESC LIMIT $2`,
      [conversationId, limit],
    );
    return result.rows.reverse().map((row) => ({ ...row, content: this.pii.decrypt(row.content) }));
  }

  async getContext(conversationId: string): Promise<ContactContext> {
    const ids = await this.pool.query<{ contact_id: string; lead_id: string }>(
      `SELECT c.contact_id, l.id AS lead_id FROM conversations c
       JOIN leads l ON l.contact_id = c.contact_id WHERE c.id = $1`,
      [conversationId],
    );
    if (!ids.rows[0]) throw new Error("Conversa não encontrada");
    return this.loadContext(this.pool, ids.rows[0].contact_id, conversationId, ids.rows[0].lead_id);
  }

  async searchKnowledge(query: string, embedding: number[] | null, limit: number): Promise<KnowledgeHit[]> {
    if (embedding) {
      const vector = `[${embedding.join(",")}]`;
      const result = await this.pool.query<{ id: string; title: string; content: string; score: number }>(
        `SELECT kc.id, kc.title, kc.content,
          greatest(coalesce(1 - (kc.embedding <=> $2::vector), 0),
            ts_rank_cd(kc.search_vector, websearch_to_tsquery('portuguese', $1))) AS score
         FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id
         WHERE kd.active = true AND (kc.embedding IS NOT NULL OR kc.search_vector @@ websearch_to_tsquery('portuguese', $1))
         ORDER BY score DESC LIMIT $3`,
        [query, vector, limit],
      );
      return result.rows;
    }
    const result = await this.pool.query<{ id: string; title: string; content: string; score: number }>(
      `SELECT kc.id, kc.title, kc.content,
        ts_rank_cd(kc.search_vector, websearch_to_tsquery('portuguese', $1)) AS score
       FROM knowledge_chunks kc JOIN knowledge_documents kd ON kd.id = kc.document_id
       WHERE kd.active = true AND kc.search_vector @@ websearch_to_tsquery('portuguese', $1)
       ORDER BY score DESC LIMIT $2`,
      [query, limit],
    );
    return result.rows;
  }

  async addTag(context: ContactContext, tag: AllowedTag): Promise<void> {
    if (!(ALLOWED_TAGS as readonly string[]).includes(tag)) throw new Error(`Tag inválida: ${tag}`);
    await this.pool.query(
      `INSERT INTO contact_tags(contact_id, tag_id)
       SELECT $1, t.id FROM tags t JOIN contacts c ON c.project_id = t.project_id
       WHERE c.id = $1 AND t.name = $2 ON CONFLICT DO NOTHING`,
      [context.contactId, tag],
    );
    await this.auditForContext(context, "agent", "tag.added", { tag });
  }

  async moveCard(context: ContactContext, stage: PipelineStage, reason: string): Promise<void> {
    if (!(PIPELINE_STAGES as readonly string[]).includes(stage)) throw new Error(`Etapa inválida: ${stage}`);
    if (stage === "Convertido" && !/matr[ií]cula|assinatura|contrata[cç][aã]o confirmada/i.test(reason)) {
      throw new Error("Conversão exige confirmação explícita");
    }
    await this.pool.query(
      `UPDATE leads l SET pipeline_stage_id = ps.id,
        followup_enabled = CASE WHEN $2 IN ('Convertido', 'Encerrado') THEN false ELSE followup_enabled END,
        followup_next_at = CASE WHEN $2 IN ('Convertido', 'Encerrado') THEN null ELSE followup_next_at END,
        updated_at = now()
       FROM pipeline_stages ps JOIN contacts c ON c.project_id = ps.project_id
       WHERE l.id = $1 AND c.id = l.contact_id AND ps.name = $2`,
      [context.leadId, stage],
    );
    await this.auditForContext(context, "agent", "pipeline.moved", { from: context.pipelineStage, to: stage, reason: "recorded" });
  }

  async updateContact(context: ContactContext, values: ContactUpdate): Promise<void> {
    const sensitiveFields = new Set([
      "name", "email", "city", "state", "cpf", "companyName", "profession",
      "area", "interest", "service", "course", "objective",
    ]);
    values = Object.fromEntries(Object.entries(values).map(([key, value]) => [
      key,
      typeof value === "string" && sensitiveFields.has(key) ? this.pii.encrypt(value) : value,
    ])) as ContactUpdate;
    const contactFields: Record<string, string> = {
      name: "name", email: "email", city: "city", state: "state", cpf: "cpf",
      companyName: "company_name", profession: "profession", source: "source",
    };
    const leadFields: Record<string, string> = {
      area: "area", interest: "interest", service: "service", course: "course", objective: "objective",
    };
    await this.dynamicUpdate("contacts", "id", context.contactId, values, contactFields);
    await this.dynamicUpdate("leads", "id", context.leadId, values, leadFields);
    await this.auditForContext(context, "agent", "contact.updated", { fields: Object.keys(values) });
  }

  async setQualificationStep(context: ContactContext, step: QualificationStep | null): Promise<void> {
    await this.pool.query("UPDATE leads SET qualification_step = $2, updated_at = now() WHERE id = $1", [context.leadId, step]);
    await this.auditForContext(context, "automation", "lead.qualification_step", { step });
  }

  async markLeadTemperature(context: ContactContext, temperature: LeadTemperature, enableMonthlyFollowup: boolean): Promise<void> {
    await this.pool.query(
      `UPDATE leads SET temperature = CASE
          WHEN temperature = 'hot' THEN 'hot'
          WHEN temperature = 'warm' AND $2 = 'cold' THEN 'warm'
          ELSE $2
        END,
        followup_enabled = CASE WHEN $3 AND NOT followup_opt_out THEN true ELSE followup_enabled END,
        followup_next_at = CASE WHEN $3 AND NOT followup_opt_out THEN coalesce(followup_next_at, now() + interval '30 days') ELSE followup_next_at END,
        updated_at = now() WHERE id = $1`,
      [context.leadId, temperature, enableMonthlyFollowup],
    );
    await this.auditForContext(context, "automation", "lead.temperature_changed", { temperature, monthlyFollowupEligible: enableMonthlyFollowup });
  }

  async recordLeadAssessment(context: ContactContext, assessment: LeadAssessment): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ temperature: LeadTemperature }>(
        "SELECT temperature FROM leads WHERE id = $1 FOR UPDATE",
        [context.leadId],
      );
      const previous = current.rows[0]?.temperature ?? "cold";
      const rank = { cold: 0, warm: 1, hot: 2 } as const;
      const temperature = assessment.notInterested
        ? previous
        : rank[assessment.temperature] >= rank[previous] ? assessment.temperature : previous;
      await client.query(
        `UPDATE leads SET temperature = $2,
          main_questions = (SELECT coalesce(jsonb_agg(DISTINCT value), '[]'::jsonb)
            FROM jsonb_array_elements_text(main_questions || $3::jsonb) AS q(value)),
          objections = (SELECT coalesce(jsonb_agg(DISTINCT value), '[]'::jsonb)
            FROM jsonb_array_elements_text(objections || $4::jsonb) AS o(value)),
          course = coalesce($5, course), interest = coalesce($6, interest),
          enrollment_status = CASE WHEN $7 THEN 'not_interested' ELSE enrollment_status END,
          updated_at = now() WHERE id = $1`,
        [context.leadId, temperature,
          JSON.stringify(assessment.mainQuestions.map((value) => this.pii.encrypt(value))),
          JSON.stringify(assessment.objections.map((value) => this.pii.encrypt(value))),
          this.pii.encryptNullable(assessment.course), this.pii.encryptNullable(assessment.interest), assessment.notInterested],
      );
      if (temperature !== previous) {
        await client.query(
          "INSERT INTO lead_temperature_history(lead_id, from_temperature, to_temperature, reason) VALUES ($1, $2, $3, $4)",
          [context.leadId, previous, temperature, this.pii.encrypt(assessment.reason)],
        );
      }
      await client.query("COMMIT");
      await this.auditForContext(context, "automation", "lead.assessed", {
        temperature: assessment.temperature,
        questionCount: assessment.mainQuestions.length,
        objectionCount: assessment.objections.length,
        hasCourse: Boolean(assessment.course),
        shouldHandoff: assessment.shouldHandoff,
        notInterested: assessment.notInterested,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async scheduleFollowups(context: ContactContext): Promise<void> {
    await this.pool.query(
      `UPDATE leads SET followup_enabled = true, followup_attempts = 0,
       followup_next_at = now() + interval '30 days', followup_sequence_id = gen_random_uuid(),
       followup_last_error = null, followup_failure_attempts = 0, followup_locked_at = null,
       followup_lock_token = null, updated_at = now()
       WHERE id = $1 AND temperature = 'hot' AND followup_opt_out = false AND enrollment_status = 'pending'`,
      [context.leadId],
    );
    await this.auditForContext(context, "automation", "followup.scheduled", { days: [30, 60, 90], eligibility: "hot" });
  }

  async cancelFollowups(context: ContactContext, reason: string): Promise<void> {
    await this.pool.query(
      "UPDATE leads SET followup_enabled = false, followup_next_at = null, updated_at = now() WHERE id = $1",
      [context.leadId],
    );
    await this.auditForContext(context, "automation", "followup.cancelled", { reason: "recorded" });
  }

  async optOutMonthlyFollowup(context: ContactContext): Promise<void> {
    await this.pool.query(
      `UPDATE leads SET followup_enabled = false, followup_opt_out = true, followup_next_at = null,
       qualification_step = null, updated_at = now() WHERE id = $1`,
      [context.leadId],
    );
    await this.auditForContext(context, "contact", "followup.opt_out", {});
  }

  async getMonthlyFollowupSettings(): Promise<MonthlyFollowupSettings> {
    const result = await this.pool.query<{ enabled: boolean; interval_days: number; max_attempts: number; schedule_days: number[] }>(
      `SELECT s.monthly_followup_enabled AS enabled, s.followup_interval_days AS interval_days,
        s.followup_max_attempts AS max_attempts, s.followup_schedule_days AS schedule_days
       FROM automation_settings s JOIN projects p ON p.id = s.project_id WHERE p.slug = 'bioecos'`,
    );
    const row = result.rows[0];
    return row ? { enabled: row.enabled, intervalDays: row.interval_days, maxAttempts: row.max_attempts, scheduleDays: row.schedule_days }
      : { enabled: false, intervalDays: 30, maxAttempts: 3, scheduleDays: [30, 60, 90] };
  }

  async setMonthlyFollowupEnabled(enabled: boolean): Promise<MonthlyFollowupSettings> {
    const result = await this.pool.query<{ enabled: boolean; interval_days: number; max_attempts: number; schedule_days: number[] }>(
      `INSERT INTO automation_settings(project_id, monthly_followup_enabled)
       SELECT id, $1 FROM projects WHERE slug = 'bioecos'
       ON CONFLICT(project_id) DO UPDATE SET monthly_followup_enabled = excluded.monthly_followup_enabled, updated_at = now()
       RETURNING monthly_followup_enabled AS enabled, followup_interval_days AS interval_days,
         followup_max_attempts AS max_attempts, followup_schedule_days AS schedule_days`,
      [enabled],
    );
    await this.pool.query(
      `INSERT INTO audit_logs(project_id, actor, action, details)
       SELECT id, 'dashboard', 'followup.setting_changed', jsonb_build_object('enabled', $1::boolean)
       FROM projects WHERE slug = 'bioecos'`,
      [enabled],
    );
    const row = result.rows[0]!;
    return { enabled: row.enabled, intervalDays: row.interval_days, maxAttempts: row.max_attempts, scheduleDays: row.schedule_days };
  }

  async getDueMonthlyFollowups(limit: number): Promise<MonthlyFollowupCandidate[]> {
    const lockToken = randomUUID();
    const result = await this.pool.query<{
      lead_id: string; contact_id: string; conversation_id: string; phone: string;
      name: string | null; course: string; attempts: number; sequence_id: string; lock_token: string;
    }>(
      `UPDATE leads claimed SET followup_locked_at = now(), followup_lock_token = $2
       FROM (
       SELECT l.id AS lead_id, c.id AS contact_id, cv.id AS conversation_id, c.phone, c.name,
        l.course, l.followup_attempts AS attempts, l.followup_sequence_id AS sequence_id
       FROM leads l JOIN contacts c ON c.id = l.contact_id
       JOIN projects p ON p.id = c.project_id AND p.slug = 'bioecos'
       JOIN automation_settings s ON s.project_id = p.id
       JOIN pipeline_stages ps ON ps.id = l.pipeline_stage_id
       JOIN conversations cv ON cv.contact_id = c.id AND cv.status = 'open'
       WHERE s.monthly_followup_enabled = true
         AND l.followup_enabled = true AND l.followup_opt_out = false
         AND l.course IS NOT NULL AND length(trim(l.course)) > 0
         AND l.followup_next_at <= now() AND l.followup_attempts < s.followup_max_attempts
         AND l.followup_failure_attempts < 3
         AND (l.followup_locked_at IS NULL OR l.followup_locked_at < now() - interval '10 minutes')
         AND l.enrollment_status = 'pending'
         AND ps.name NOT IN ('Convertido', 'Encerrado', 'Matrícula concluída', 'Sem interesse', 'Conversa finalizada')
         AND cv.automation_paused = false AND cv.workflow_state = 'ai_attending' AND cv.current_owner = 'ai'
         AND cv.last_interaction_at < l.followup_next_at
       ORDER BY l.followup_next_at ASC FOR UPDATE OF l SKIP LOCKED LIMIT $1
       ) due WHERE claimed.id = due.lead_id
       RETURNING due.lead_id, due.contact_id, due.conversation_id, due.phone, due.name,
         due.course, due.attempts, due.sequence_id, claimed.followup_lock_token AS lock_token`,
      [Math.max(1, Math.min(limit, 100)), lockToken],
    );
    return result.rows.map((row) => ({
      leadId: row.lead_id, contactId: row.contact_id, conversationId: row.conversation_id,
      phone: this.pii.decrypt(row.phone), name: this.pii.decryptNullable(row.name), course: this.pii.decrypt(row.course), attempts: row.attempts,
      step: Math.min(3, row.attempts + 1) as 1 | 2 | 3, sequenceId: row.sequence_id,
      lockToken: row.lock_token,
    }));
  }

  async markMonthlyFollowupSent(candidate: MonthlyFollowupCandidate, content: string): Promise<void> {
    await this.pool.query(
      `UPDATE leads SET followup_attempts = followup_attempts + 1, followup_last_at = now(),
        followup_next_at = CASE WHEN followup_attempts + 1 >= 3 THEN null ELSE now() + interval '30 days' END,
        followup_enabled = followup_attempts + 1 < 3, followup_last_error = null,
        followup_failure_attempts = 0, followup_locked_at = null, followup_lock_token = null, updated_at = now()
       WHERE id = $1 AND ($2::uuid IS NULL OR followup_lock_token = $2::uuid)`,
      [candidate.leadId, candidate.lockToken ?? null],
    );
    await this.pool.query(
      `INSERT INTO followup_events(lead_id, conversation_id, sequence_id, step, status, content)
       VALUES ($1, $2, $3, $4, 'sent', $5)`,
      [candidate.leadId, candidate.conversationId, candidate.sequenceId, candidate.step, this.pii.encrypt(content)],
    );
    const context = await this.getContext(candidate.conversationId);
    await this.auditForContext(context, "automation", "followup.sent", { attempt: candidate.attempts + 1, hasCourse: true });
  }

  async markMonthlyFollowupFailed(candidate: MonthlyFollowupCandidate, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE leads SET followup_failure_attempts = followup_failure_attempts + 1,
       followup_enabled = followup_failure_attempts + 1 < 3,
       followup_last_error = $2,
       followup_next_at = CASE WHEN followup_failure_attempts + 1 >= 3 THEN null ELSE now() + interval '1 day' END,
       followup_locked_at = null, followup_lock_token = null, updated_at = now()
       WHERE id = $1 AND ($3::uuid IS NULL OR followup_lock_token = $3::uuid)`,
      [candidate.leadId, this.pii.encrypt(error.slice(0, 500)), candidate.lockToken ?? null],
    );
    await this.pool.query(
      `INSERT INTO followup_events(lead_id, conversation_id, sequence_id, step, status, error)
       VALUES ($1, $2, $3, $4, 'failed', $5)`,
      [candidate.leadId, candidate.conversationId, candidate.sequenceId, candidate.step, this.pii.encrypt(error.slice(0, 500))],
    );
    const context = await this.getContext(candidate.conversationId);
    await this.auditForContext(context, "automation", "followup.failed", { error: "recorded" });
  }

  async addNote(context: ContactContext, note: string): Promise<void> {
    const current = await this.pool.query<{ notes: string | null }>("SELECT notes FROM leads WHERE id = $1", [context.leadId]);
    const previous = this.pii.decryptNullable(current.rows[0]?.notes) ?? "";
    await this.pool.query("UPDATE leads SET notes = $2, updated_at = now() WHERE id = $1", [
      context.leadId,
      this.pii.encrypt([previous, note].filter(Boolean).join("\n")),
    ]);
    await this.auditForContext(context, "agent", "note.added", { fields: ["notes"] });
  }

  async handoff(context: ContactContext, reason: string, summary: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ notes: string | null }>("SELECT notes FROM leads WHERE id = $1 FOR UPDATE", [context.leadId]);
      const handoffNote = [this.pii.decryptNullable(existing.rows[0]?.notes) ?? "", `Handoff: ${reason}`].filter(Boolean).join("\n");
      await client.query(
        `UPDATE conversations SET automation_paused = true, summary = $2, workflow_state = 'awaiting_coordinator',
         current_owner = 'coordinator', handoff_reason = $3, coordinator_notification_status = 'pending'
         WHERE id = $1`,
        [context.conversationId, this.pii.encrypt(summary), this.pii.encrypt(reason)],
      );
      await client.query(
        `UPDATE leads l SET pipeline_stage_id = ps.id, notes = $2,
         followup_enabled = false, followup_next_at = null, updated_at = now()
         FROM pipeline_stages ps JOIN contacts c ON c.project_id = ps.project_id
         WHERE l.id = $1 AND c.id = l.contact_id AND ps.name = 'Aguardando coordenador'`,
        [context.leadId, this.pii.encrypt(handoffNote)],
      );
      await client.query(
        `INSERT INTO contact_tags(contact_id, tag_id)
         SELECT $1, t.id FROM tags t JOIN contacts c ON c.project_id = t.project_id
         WHERE c.id = $1 AND t.name = 'falar-com-especialista' ON CONFLICT DO NOTHING`,
        [context.contactId],
      );
      const project = await client.query<{ project_id: string }>("SELECT project_id FROM contacts WHERE id = $1", [context.contactId]);
      await this.audit(client, project.rows[0]!.project_id, context.contactId, context.conversationId, "agent", "handoff.created", { reason: "recorded", summary: "recorded" });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createCoordinatorNotification(context: ContactContext, message: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO coordinator_notifications(contact_id, conversation_id, message)
       VALUES ($1, $2, $3) RETURNING id`,
      [context.contactId, context.conversationId, this.pii.encrypt(message)],
    );
    return result.rows[0]!.id;
  }

  async getCoordinatorNotification(id: string): Promise<CoordinatorNotificationRecord | null> {
    const result = await this.pool.query<{
      id: string; contact_id: string; conversation_id: string; message: string;
      status: "pending" | "sent" | "failed"; attempts: number; last_error: string | null;
    }>("SELECT id, contact_id, conversation_id, message, status, attempts, last_error FROM coordinator_notifications WHERE id = $1", [id]);
    const row = result.rows[0];
    return row ? { id: row.id, contactId: row.contact_id, conversationId: row.conversation_id,
      message: this.pii.decrypt(row.message), status: row.status, attempts: row.attempts,
      lastError: this.pii.decryptNullable(row.last_error) } : null;
  }

  async markCoordinatorNotification(id: string, status: "sent" | "failed", error?: string): Promise<void> {
    await this.pool.query(
      `UPDATE coordinator_notifications SET status = $2, attempts = attempts + 1, last_error = $3,
       sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END, updated_at = now() WHERE id = $1`,
      [id, status, error ? this.pii.encrypt(error.slice(0, 500)) : null],
    );
    await this.pool.query(
      `UPDATE conversations SET coordinator_notification_status = $2
       WHERE id = (SELECT conversation_id FROM coordinator_notifications WHERE id = $1)`,
      [id, status],
    );
  }

  async getFailedCoordinatorNotifications(limit: number): Promise<CoordinatorNotificationRecord[]> {
    const result = await this.pool.query<{
      id: string; contact_id: string; conversation_id: string; message: string;
      status: "failed"; attempts: number; last_error: string | null;
    }>(
      `SELECT id, contact_id, conversation_id, message, status, attempts, last_error
       FROM coordinator_notifications WHERE status = 'failed' ORDER BY updated_at DESC LIMIT $1`,
      [Math.max(1, Math.min(limit, 100))],
    );
    return result.rows.map((row) => ({ id: row.id, contactId: row.contact_id, conversationId: row.conversation_id,
      message: this.pii.decrypt(row.message), status: row.status, attempts: row.attempts,
      lastError: this.pii.decryptNullable(row.last_error) }));
  }

  async setConversationWorkflow(conversationId: string, state: ConversationWorkflowState, owner: string, reason: string): Promise<void> {
    const context = await this.getContext(conversationId);
    const paused = state !== "ai_attending";
    const stage: PipelineStage = ({
      ai_attending: "IA atendendo", awaiting_coordinator: "Aguardando coordenador",
      coordinator_attending: "Coordenador atendendo", conversation_finished: "Conversa finalizada",
      enrollment_completed: "Matrícula concluída", not_interested: "Sem interesse",
    } as const)[state];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "UPDATE conversations SET workflow_state = $2, current_owner = $3, automation_paused = $4 WHERE id = $1",
        [conversationId, state, owner, paused],
      );
      await client.query(
        `UPDATE leads l SET pipeline_stage_id = ps.id,
         followup_enabled = CASE WHEN $3 THEN false ELSE followup_enabled END,
         followup_next_at = CASE WHEN $3 THEN null ELSE followup_next_at END,
         enrollment_status = CASE WHEN $4 = 'enrollment_completed' THEN 'completed'
           WHEN $4 = 'not_interested' THEN 'not_interested' ELSE enrollment_status END,
         outcome = CASE WHEN $4 IN ('enrollment_completed', 'not_interested', 'conversation_finished') THEN $5 ELSE outcome END,
         updated_at = now()
         FROM pipeline_stages ps JOIN contacts c ON c.project_id = ps.project_id
         WHERE l.id = $1 AND c.id = l.contact_id AND ps.name = $2`,
        [context.leadId, stage, paused, state, this.pii.encrypt(reason)],
      );
      await client.query("COMMIT");
      await this.auditForContext(context, owner, "conversation.workflow_changed", { state, owner, reason: "recorded" });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getLeads(filter: string): Promise<unknown[]> {
    const allowed: Record<string, string> = {
      cold: "l.temperature = 'cold'", warm: "l.temperature = 'warm'", hot: "l.temperature = 'hot'",
      awaiting_coordinator: "cv.workflow_state = 'awaiting_coordinator'",
      coordinator_attending: "cv.workflow_state = 'coordinator_attending'", followup: "l.followup_enabled = true",
      enrollment_completed: "cv.workflow_state = 'enrollment_completed'", not_interested: "cv.workflow_state = 'not_interested'",
      closed: "cv.workflow_state = 'conversation_finished'",
    };
    const condition = allowed[filter] ?? "true";
    const result = await this.pool.query(
      `SELECT c.id AS contact_id, cv.id AS conversation_id, c.name, c.phone, l.course,
       l.temperature, cv.workflow_state, cv.last_interaction_at, l.followup_next_at,
       cv.current_owner, c.source, cv.coordinator_notification_status
       FROM leads l JOIN contacts c ON c.id = l.contact_id
       JOIN projects p ON p.id = c.project_id AND p.slug = 'bioecos'
       JOIN conversations cv ON cv.contact_id = c.id AND cv.status = 'open'
       WHERE ${condition} ORDER BY
       CASE WHEN cv.workflow_state = 'awaiting_coordinator' THEN 0 WHEN l.temperature = 'hot' THEN 1 ELSE 2 END,
       cv.last_interaction_at DESC LIMIT 500`,
    );
    return result.rows.map((row) => this.decryptFields(row, ["name", "phone", "course"]));
  }

  async saveOutbound(conversationId: string, externalMessageId: string, content: string, metadata: unknown): Promise<void> {
    void metadata;
    await this.pool.query(
      `INSERT INTO messages(conversation_id, external_message_id, direction, content, timestamp, metadata)
       VALUES ($1, $2, 'outbound', $3, now(), $4) ON CONFLICT(external_message_id) DO NOTHING`,
      [conversationId, externalMessageId || `outbound:${randomUUID()}`, this.pii.encrypt(content), JSON.stringify({ source: "automation" })],
    );
  }

  async setAutomationPaused(conversationId: string, paused: boolean, actor: string): Promise<void> {
    await this.pool.query("UPDATE conversations SET automation_paused = $2 WHERE id = $1", [conversationId, paused]);
    const context = await this.getContext(conversationId);
    await this.auditForContext(context, actor, paused ? "automation.paused" : "automation.resumed", {});
  }

  async getDashboard(): Promise<unknown> {
    const stages = await this.pool.query(
      `SELECT ps.name, count(l.id)::int AS total FROM pipeline_stages ps
       LEFT JOIN leads l ON l.pipeline_stage_id = ps.id
       JOIN projects p ON p.id = ps.project_id AND p.slug = 'bioecos'
       GROUP BY ps.id ORDER BY ps.position`,
    );
    const conversations = await this.pool.query(
      `SELECT cv.id, c.name, c.phone, cv.automation_paused, cv.workflow_state, cv.current_owner,
        cv.coordinator_notification_status, l.temperature, cv.last_interaction_at
       FROM conversations cv JOIN contacts c ON c.id = cv.contact_id
       JOIN leads l ON l.contact_id = c.id
       WHERE cv.status = 'open' ORDER BY cv.last_interaction_at DESC LIMIT 20`,
    );
    const followup = await this.pool.query(
      `SELECT
        count(*) FILTER (WHERE l.temperature = 'hot')::int AS hot_leads,
        count(*) FILTER (WHERE l.temperature = 'hot' AND l.followup_enabled AND NOT l.followup_opt_out)::int AS eligible_leads,
        count(*) FILTER (WHERE l.followup_opt_out)::int AS opt_outs,
        count(*) FILTER (WHERE l.followup_last_at >= now() - interval '30 days')::int AS sent_last_30_days
       FROM leads l JOIN contacts c ON c.id = l.contact_id JOIN projects p ON p.id = c.project_id
       WHERE p.slug = 'bioecos'`,
    );
    const failedNotifications = await this.pool.query(
      "SELECT count(*)::int AS total FROM coordinator_notifications WHERE status = 'failed'",
    );
    return { stages: stages.rows, recentConversations: conversations.rows.map((row) => this.decryptFields(row, ["name", "phone"])), followup: followup.rows[0],
      failedCoordinatorNotifications: failedNotifications.rows[0]?.total ?? 0 };
  }

  async getContactView(contactId: string): Promise<unknown | null> {
    const contact = await this.pool.query(
      `SELECT c.id, c.project_id, c.phone, c.name, c.email, c.city, c.state, c.company_name, c.profession,
        c.source, c.created_at, c.updated_at, (c.cpf IS NOT NULL) AS has_cpf,
        l.area, l.interest, l.service, l.course, l.objective, l.notes, l.assigned_to,
        l.qualification_step, l.temperature, l.followup_enabled, l.followup_opt_out,
        l.followup_next_at, l.followup_last_at, l.followup_attempts, l.followup_last_error,
        l.main_questions, l.objections, l.enrollment_status, l.outcome,
        ps.name AS pipeline_stage, cv.id AS conversation_id, cv.workflow_state, cv.current_owner,
        cv.handoff_reason, cv.coordinator_notification_status, cv.summary,
        (SELECT coalesce(array_agg(t.name), '{}') FROM contact_tags ct
          JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id) AS tags
       FROM contacts c JOIN leads l ON l.contact_id = c.id
       JOIN pipeline_stages ps ON ps.id = l.pipeline_stage_id
       LEFT JOIN LATERAL (SELECT * FROM conversations x WHERE x.contact_id = c.id ORDER BY x.created_at DESC LIMIT 1) cv ON true
       WHERE c.id = $1`,
      [contactId],
    );
    if (!contact.rows[0]) return null;
    const history = await this.pool.query(
      `SELECT m.direction, m.type, m.content, m.timestamp FROM messages m
       JOIN conversations cv ON cv.id = m.conversation_id WHERE cv.contact_id = $1 ORDER BY m.timestamp DESC LIMIT 100`,
      [contactId],
    );
    const temperatures = await this.pool.query(
      "SELECT from_temperature, to_temperature, reason, created_at FROM lead_temperature_history WHERE lead_id = (SELECT id FROM leads WHERE contact_id = $1) ORDER BY created_at DESC",
      [contactId],
    );
    const followups = await this.pool.query(
      "SELECT step, status, content, error, created_at FROM followup_events WHERE lead_id = (SELECT id FROM leads WHERE contact_id = $1) ORDER BY created_at DESC",
      [contactId],
    );
    const decryptedContact = this.decryptFields(contact.rows[0], [
      "phone", "name", "email", "city", "state", "company_name", "profession", "area", "interest",
      "service", "course", "objective", "notes", "assigned_to", "followup_last_error", "outcome",
      "handoff_reason", "summary",
    ]);
    return {
      ...decryptedContact,
      main_questions: Array.isArray(contact.rows[0].main_questions)
        ? contact.rows[0].main_questions.map((value: unknown) => typeof value === "string" ? this.pii.decrypt(value) : value)
        : [],
      objections: Array.isArray(contact.rows[0].objections)
        ? contact.rows[0].objections.map((value: unknown) => typeof value === "string" ? this.pii.decrypt(value) : value)
        : [],
      history: history.rows.map((row) => this.decryptFields(row, ["content"])),
      temperatureHistory: temperatures.rows.map((row) => this.decryptFields(row, ["reason"])),
      followupHistory: followups.rows.map((row) => this.decryptFields(row, ["content", "error"])),
    };
  }

  async getConversationContactId(conversationId: string): Promise<string | null> {
    const result = await this.pool.query<{ contact_id: string }>("SELECT contact_id FROM conversations WHERE id = $1", [conversationId]);
    return result.rows[0]?.contact_id ?? null;
  }

  async recordHumanOutbound(message: OutboundWebhookMessage): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query<{ conversation_id: string; contact_id: string; project_id: string }>(
        `SELECT cv.id AS conversation_id, c.id AS contact_id, c.project_id
         FROM contacts c JOIN conversations cv ON cv.contact_id = c.id AND cv.status = 'open'
         JOIN projects p ON p.id = c.project_id AND p.slug = 'bioecos'
         WHERE c.phone_hash = $1 OR c.phone = $2 LIMIT 1`,
        [this.pii.phoneHash(message.phone), message.phone],
      );
      const row = target.rows[0];
      if (!row) { await client.query("ROLLBACK"); return false; }
      const inserted = await client.query(
        `INSERT INTO messages(conversation_id, external_message_id, direction, content, timestamp, metadata)
         VALUES ($1, $2, 'outbound', $3, $4, '{"source":"coordinator_whatsapp"}'::jsonb)
         ON CONFLICT(external_message_id) DO NOTHING RETURNING id`,
        [row.conversation_id, message.externalMessageId, this.pii.encrypt(message.content), message.timestamp],
      );
      if (inserted.rowCount === 0) { await client.query("COMMIT"); return false; }
      await client.query(
        `UPDATE conversations SET automation_paused = true, workflow_state = 'coordinator_attending',
         current_owner = 'coordinator', last_interaction_at = greatest(last_interaction_at, $2)
         WHERE id = $1`,
        [row.conversation_id, message.timestamp],
      );
      await this.audit(client, row.project_id, row.contact_id, row.conversation_id, "coordinator", "message.outbound_manual", {});
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async exportContactData(contactId: string): Promise<unknown | null> {
    return this.getContactView(contactId);
  }

  async deleteContactData(contactId: string, actor: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query<{ project_id: string; conversation_id: string | null }>(
        `SELECT c.project_id, cv.id AS conversation_id FROM contacts c
         LEFT JOIN LATERAL (SELECT id FROM conversations WHERE contact_id = c.id ORDER BY started_at DESC LIMIT 1) cv ON true
         WHERE c.id = $1 FOR UPDATE OF c`,
        [contactId],
      );
      const row = target.rows[0];
      if (!row) { await client.query("ROLLBACK"); return false; }
      await this.audit(client, row.project_id, contactId, row.conversation_id, actor, "contact.deleted_lgpd", {});
      await client.query("DELETE FROM contacts WHERE id = $1", [contactId]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadContext(queryable: Queryable, contactId: string, conversationId: string, leadId: string): Promise<ContactContext> {
    const result = await queryable.query<{
      phone: string; name: string | null; email: string | null; city: string | null; company_name: string | null;
      area: string | null; interest: string | null; service: string | null; course: string | null; objective: string | null;
      pipeline_stage: PipelineStage; automation_paused: boolean; tags: AllowedTag[];
      qualification_step: QualificationStep | null; temperature: LeadTemperature;
      followup_enabled: boolean; followup_opt_out: boolean; followup_next_at: Date | null; followup_attempts: number;
      workflow_state: ContactContext["workflowState"]; current_owner: string; handoff_reason: string | null;
      coordinator_notification_status: ContactContext["coordinatorNotificationStatus"];
      main_questions: string[]; objections: string[]; enrollment_status: ContactContext["enrollmentStatus"];
    }>(
      `SELECT c.phone, c.name, c.email, c.city, c.company_name, l.area, l.interest, l.service, l.course, l.objective,
        l.qualification_step, l.temperature, l.followup_enabled, l.followup_opt_out, l.followup_next_at,
        l.followup_attempts, l.main_questions, l.objections, l.enrollment_status,
        ps.name AS pipeline_stage, cv.automation_paused, cv.workflow_state, cv.current_owner,
        cv.handoff_reason, cv.coordinator_notification_status,
        coalesce(array_agg(t.name) FILTER (WHERE t.name IS NOT NULL), '{}') AS tags
       FROM contacts c JOIN leads l ON l.contact_id = c.id AND l.id = $3 JOIN pipeline_stages ps ON ps.id = l.pipeline_stage_id
       JOIN conversations cv ON cv.contact_id = c.id AND cv.id = $2 LEFT JOIN contact_tags ct ON ct.contact_id = c.id
       LEFT JOIN tags t ON t.id = ct.tag_id WHERE c.id = $1
       GROUP BY c.id, l.id, ps.name, cv.id`,
      [contactId, conversationId, leadId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Contexto não encontrado");
    return {
      contactId, conversationId, leadId, phone: this.pii.decrypt(row.phone), name: this.pii.decryptNullable(row.name),
      email: this.pii.decryptNullable(row.email), city: this.pii.decryptNullable(row.city),
      companyName: this.pii.decryptNullable(row.company_name), area: this.pii.decryptNullable(row.area),
      interest: this.pii.decryptNullable(row.interest), service: this.pii.decryptNullable(row.service),
      course: this.pii.decryptNullable(row.course), objective: this.pii.decryptNullable(row.objective),
      pipelineStage: row.pipeline_stage, tags: row.tags, automationPaused: row.automation_paused,
      qualificationStep: row.qualification_step, temperature: row.temperature,
      followupEnabled: row.followup_enabled, followupOptOut: row.followup_opt_out,
      workflowState: row.workflow_state, currentOwner: row.current_owner, handoffReason: this.pii.decryptNullable(row.handoff_reason),
      coordinatorNotificationStatus: row.coordinator_notification_status,
      mainQuestions: row.main_questions.map((value) => this.pii.decrypt(value)),
      objections: row.objections.map((value) => this.pii.decrypt(value)), enrollmentStatus: row.enrollment_status,
      followupNextAt: row.followup_next_at, followupAttempts: row.followup_attempts,
    };
  }

  private async dynamicUpdate(table: "contacts" | "leads", idColumn: "id", id: string, values: ContactUpdate, fields: Record<string, string>): Promise<void> {
    const entries = Object.entries(values).filter(([key, value]) => value !== undefined && fields[key]);
    if (!entries.length) return;
    const assignments = entries.map(([key], index) => `${fields[key]} = $${index + 2}`);
    const parameters = [id, ...entries.map(([, value]) => value)];
    await this.pool.query(`UPDATE ${table} SET ${assignments.join(", ")}, updated_at = now() WHERE ${idColumn} = $1`, parameters);
  }

  private decryptFields<T extends Record<string, unknown>>(row: T, fields: string[]): T {
    const copy = { ...row };
    for (const field of fields) {
      const value = copy[field];
      if (typeof value === "string") copy[field as keyof T] = this.pii.decrypt(value) as T[keyof T];
    }
    return copy;
  }

  private async auditForContext(context: ContactContext, actor: string, action: string, details: unknown): Promise<void> {
    const project = await this.pool.query<{ project_id: string }>("SELECT project_id FROM contacts WHERE id = $1", [context.contactId]);
    await this.audit(this.pool, project.rows[0]!.project_id, context.contactId, context.conversationId, actor, action, details);
  }

  private async audit(queryable: Queryable, projectId: string, contactId: string, conversationId: string | null, actor: string, action: string, details: unknown): Promise<void> {
    await queryable.query(
      "INSERT INTO audit_logs(project_id, contact_id, conversation_id, actor, action, details) VALUES ($1, $2, $3, $4, $5, $6)",
      [projectId, contactId, conversationId, actor, action, JSON.stringify(details)],
    );
  }
}
