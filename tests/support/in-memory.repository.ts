import type { AllowedTag, PipelineStage } from "../../src/domain/constants.js";
import type { ChatMessage, ContactContext, InboundMessage, IngestResult, KnowledgeHit } from "../../src/domain/types.js";
import type { BioecosRepository, ContactUpdate } from "../../src/repositories/bioecos.repository.js";

export class InMemoryRepository implements BioecosRepository {
  context: ContactContext = {
    contactId: "contact-1", conversationId: "conversation-1", leadId: "lead-1", phone: "5521971970274",
    name: null, email: null, city: null, companyName: null, area: null, interest: null, service: null,
    course: null, objective: null, pipelineStage: "Novo contato", tags: [], automationPaused: false,
  };
  seen = new Set<string>();
  recent: ChatMessage[] = [];
  outbound: string[] = [];
  notes: string[] = [];
  handoffs: Array<{ reason: string; summary: string }> = [];
  knowledge: KnowledgeHit[] = [];
  searchCalls: string[] = [];

  async health() { return true; }
  async ingestInbound(message: InboundMessage): Promise<IngestResult> {
    const duplicate = this.seen.has(message.externalMessageId);
    this.seen.add(message.externalMessageId);
    if (!duplicate) this.recent.push({ direction: "inbound", content: message.content, timestamp: message.timestamp });
    return { duplicate, context: { ...this.context, tags: [...this.context.tags] } };
  }
  async getRecentMessages(_conversationId: string, limit: number) { return this.recent.slice(-limit); }
  async getContext() { return { ...this.context, tags: [...this.context.tags] }; }
  async searchKnowledge(query: string) { this.searchCalls.push(query); return this.knowledge; }
  async addTag(_context: ContactContext, tag: AllowedTag) {
    if (!this.context.tags.includes(tag)) this.context.tags.push(tag);
  }
  async moveCard(_context: ContactContext, stage: PipelineStage) { this.context.pipelineStage = stage; }
  async updateContact(_context: ContactContext, values: ContactUpdate) {
    Object.assign(this.context, values);
  }
  async addNote(_context: ContactContext, note: string) { this.notes.push(note); }
  async handoff(_context: ContactContext, reason: string, summary: string) {
    this.handoffs.push({ reason, summary });
    this.context.automationPaused = true;
    this.context.pipelineStage = "Aguardando especialista";
    if (!this.context.tags.includes("falar-com-especialista")) this.context.tags.push("falar-com-especialista");
  }
  async saveOutbound(_conversationId: string, _externalMessageId: string, content: string) { this.outbound.push(content); }
  async setAutomationPaused(_conversationId: string, paused: boolean) { this.context.automationPaused = paused; }
  async getDashboard() { return {}; }
  async getContactView() { return this.context; }
}

