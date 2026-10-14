import type pg from 'pg';
import { PiiCipher } from '../security/pii-cipher.js';
import type { BioecosRepository } from '../repositories/bioecos.repository.js';
import { EvolutionHttpError, type EvolutionService } from './evolution.service.js';

function conflict(message: string): Error { return Object.assign(new Error(message), {statusCode: 409}); }

export class HumanMessagesService {
  private readonly pii: PiiCipher;
  private running = false;
  constructor(private readonly pool: pg.Pool, private readonly repository: BioecosRepository,
    private readonly evolution: Pick<EvolutionService, 'sendText'>, key: string) { this.pii = new PiiCipher(key); }

  async enqueue(conversationId: string, text: string, requestKey: string, version: number, actor: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const conversation = (await client.query('SELECT * FROM conversations WHERE id = $1 FOR UPDATE', [conversationId])).rows[0];
      if (!conversation) throw Object.assign(new Error('Conversa não encontrada'), {statusCode: 404});
      const duplicate = (await client.query('SELECT * FROM human_outbound_jobs WHERE conversation_id = $1 AND request_key = $2', [conversationId, requestKey])).rows[0];
      if (duplicate) {
        if (this.pii.decrypt(duplicate.content) !== text || duplicate.actor !== actor) throw conflict('Chave já utilizada para outra mensagem');
        await client.query('COMMIT'); return this.publicJob(duplicate);
      }
      if (conversation.status !== 'open' || conversation.current_owner !== 'coordinator' || conversation.workflow_state !== 'coordinator_attending'
        || !conversation.automation_paused || conversation.ownership_version !== version) throw conflict('Assuma o atendimento e atualize a conversa antes de enviar');
      const context = await this.repository.getContext(conversationId);
      if (await this.repository.isPhoneIgnored(context.phone)) throw conflict('Envio bloqueado para número protegido');
      const job = (await client.query(`INSERT INTO human_outbound_jobs(conversation_id,request_key,ownership_version,actor,content)
        VALUES ($1,$2,$3,$4,$5) RETURNING *`, [conversationId,requestKey,version,actor,this.pii.encrypt(text)])).rows[0];
      await this.audit(client, conversationId, actor, 'human_message.queued', job.id);
      await client.query('COMMIT'); return this.publicJob(job);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async page(conversationId: string, cursor?: string) {
    const context = await this.repository.getContext(conversationId);
    const rows = (await this.pool.query(`SELECT id,direction,type,content,timestamp,metadata FROM messages
      WHERE conversation_id = $1 AND ($2::uuid IS NULL OR (timestamp,id) <
        (SELECT timestamp,id FROM messages WHERE id = $2 AND conversation_id = $1))
      ORDER BY timestamp DESC,id DESC LIMIT 51`, [conversationId,cursor ?? null])).rows;
    const more = rows.length > 50;
    const messages = rows.slice(0,50).map(row => ({...row, content:this.pii.decrypt(row.content),
      author: row.direction === 'inbound' ? 'Cliente' : row.metadata?.actor ??
        (row.metadata?.source === 'automation' ? 'Débora' : row.metadata?.source === 'coordinator_whatsapp' ? 'Atendimento humano' : 'Autor não identificado')}));
    const outgoing = (await this.pool.query('SELECT * FROM human_outbound_jobs WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 50', [conversationId])).rows.map(row=>this.publicJob(row));
    return {messages,nextCursor:more ? messages.at(-1)?.id : null,outgoing,
      conversation:{id:conversationId,owner:context.currentOwner,state:context.workflowState,version:context.ownershipVersion ?? 0}};
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
    // A crashed in-flight request may already have reached WhatsApp: never resend it blindly.
    await this.pool.query(`UPDATE human_outbound_jobs SET status='unknown',last_error='Processamento interrompido; envio não confirmado',updated_at=now()
      WHERE status='processing' AND updated_at < now() - interval '2 minutes'`);
    const due = (await this.pool.query(`UPDATE human_outbound_jobs SET status='processing',attempts=attempts+1,updated_at=now()
      WHERE id IN (SELECT id FROM human_outbound_jobs WHERE status='queued' AND available_at<=now()
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 10) RETURNING id`)).rows;
    for (const row of due) await this.deliver(row.id);
    } finally { this.running = false; }
  }

  private async deliver(id: string) {
    const client = await this.pool.connect();
    let externalId: string | null = null;
    try {
      await client.query('BEGIN');
      const snapshot = (await client.query('SELECT conversation_id FROM human_outbound_jobs WHERE id=$1',[id])).rows[0];
      if (!snapshot) { await client.query('ROLLBACK'); return; }
      const conversation = (await client.query('SELECT * FROM conversations WHERE id=$1 FOR UPDATE',[snapshot.conversation_id])).rows[0];
      const job = (await client.query('SELECT * FROM human_outbound_jobs WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (job.status !== 'processing') { await client.query('ROLLBACK'); return; }
      const context = await this.repository.getContext(job.conversation_id);
      if (conversation.status !== 'open' || conversation.current_owner !== 'coordinator' || conversation.workflow_state !== 'coordinator_attending'
        || !conversation.automation_paused || conversation.ownership_version !== job.ownership_version || await this.repository.isPhoneIgnored(context.phone)) {
        await client.query("UPDATE human_outbound_jobs SET status='cancelled',last_error='Responsabilidade alterada ou número protegido',updated_at=now() WHERE id=$1",[id]);
        await this.audit(client,job.conversation_id,job.actor,'human_message.cancelled',id);
        await client.query('COMMIT'); return;
      }
      const text = this.pii.decrypt(job.content);
      const sent = await this.evolution.sendText(context.phone,text,0);
      if (!sent.externalMessageId) throw new Error('Identificador de envio ausente');
      externalId = sent.externalMessageId;
      await client.query(`INSERT INTO messages(conversation_id,external_message_id,direction,content,timestamp,metadata)
        VALUES ($1,$2,'outbound',$3,now(),$4) ON CONFLICT(external_message_id) DO NOTHING`,
        [job.conversation_id,externalId,job.content,JSON.stringify({source:'portal_human',actor:job.actor,jobId:id})]);
      await client.query("UPDATE human_outbound_jobs SET status='accepted',provider_message_id=$2,last_error=null,updated_at=now() WHERE id=$1",[id,externalId]);
      await client.query('UPDATE conversations SET last_interaction_at=now() WHERE id=$1',[job.conversation_id]);
      await this.audit(client,job.conversation_id,job.actor,'human_message.accepted',id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      const knownRejection = error instanceof EvolutionHttpError && error.status >= 400 && error.status < 500 && error.status !== 408;
      const safeRetry = knownRejection && error.status === 429;
      await this.pool.query(`UPDATE human_outbound_jobs SET status=CASE WHEN $2 AND attempts<5 THEN 'queued' WHEN $3 THEN 'failed' ELSE 'unknown' END,
        available_at=now()+interval '1 minute',provider_message_id=$4,last_error=$5,updated_at=now() WHERE id=$1`,
        [id,safeRetry,knownRejection,externalId,knownRejection ? 'Provedor rejeitou o envio' : 'Envio não confirmado; não será repetido automaticamente']);
      await this.pool.query(`INSERT INTO audit_logs(project_id,contact_id,conversation_id,actor,action,details)
        SELECT c.project_id,c.id,cv.id,j.actor,'human_message.failure',jsonb_build_object('jobId',j.id)
        FROM human_outbound_jobs j JOIN conversations cv ON cv.id=j.conversation_id JOIN contacts c ON c.id=cv.contact_id WHERE j.id=$1`,[id]);
    } finally { client.release(); }
  }

  private publicJob(row: Record<string, any>) {
    return {id:row.id,conversationId:row.conversation_id,status:row.status,text:this.pii.decrypt(row.content),actor:row.actor,
      providerMessageId:row.provider_message_id,attempts:row.attempts,error:row.last_error,createdAt:row.created_at};
  }
  private async audit(client: pg.PoolClient, conversationId: string, actor: string, action: string, id: string) {
    await client.query(`INSERT INTO audit_logs(project_id,contact_id,conversation_id,actor,action,details)
      SELECT c.project_id,c.id,cv.id,$2,$3,jsonb_build_object('jobId',$4::text)
      FROM conversations cv JOIN contacts c ON c.id=cv.contact_id WHERE cv.id=$1`,[conversationId,actor,action,id]);
  }
}
