import type { AllowedTag, PipelineStage } from "../../src/domain/constants.js";
import type {
  ChatMessage, ContactContext, InboundMessage, IngestResult, KnowledgeHit, LeadTemperature,
  MonthlyFollowupCandidate, MonthlyFollowupSettings, QualificationStep,
} from "../../src/domain/types.js";
import type { BioecosRepository, ContactUpdate } from "../../src/repositories/bioecos.repository.js";

export class InMemoryRepository implements BioecosRepository {
  context: ContactContext = {
    contactId: "contact-1", conversationId: "conversation-1", leadId: "lead-1", phone: "5521971970274",
    name: null, email: null, city: null, companyName: null, area: null, interest: null, service: null,
    course: null, objective: null, pipelineStage: "Novo contato", tags: [], automationPaused: false,
    qualificationStep: null, temperature: "cold", followupEnabled: false, followupOptOut: false,
  };
  seen = new Set<string>();
  recent: ChatMessage[] = [];
  outbound: string[] = [];
  notes: string[] = [];
  handoffs: Array<{ reason: string; summary: string }> = [];
  knowledge: KnowledgeHit[] = [];
  searchCalls: string[] = [];
  monthlySettings: MonthlyFollowupSettings = { enabled: false, intervalDays: 30, maxAttempts: 3 };
  monthlyCandidates: MonthlyFollowupCandidate[] = [];
  monthlySent: MonthlyFollowupCandidate[] = [];
  monthlyFailures: Array<{ candidate: MonthlyFollowupCandidate; error: string }> = [];

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
  async setQualificationStep(_context: ContactContext, step: QualificationStep | null) { this.context.qualificationStep = step; }
  async markLeadTemperature(_context: ContactContext, temperature: LeadTemperature, enableMonthlyFollowup: boolean) {
    const rank = { cold: 0, warm: 1, hot: 2 } as const;
    if (rank[temperature] > rank[this.context.temperature]) this.context.temperature = temperature;
    if (enableMonthlyFollowup && !this.context.followupOptOut) {
      this.context.followupEnabled = true;
    }
  }
  async optOutMonthlyFollowup() {
    this.context.followupEnabled = false;
    this.context.followupOptOut = true;
    this.context.qualificationStep = null;
  }
  async getMonthlyFollowupSettings() { return { ...this.monthlySettings }; }
  async setMonthlyFollowupEnabled(enabled: boolean) {
    this.monthlySettings.enabled = enabled;
    return { ...this.monthlySettings };
  }
  async getDueMonthlyFollowups(limit: number) { return this.monthlyCandidates.slice(0, limit); }
  async markMonthlyFollowupSent(candidate: MonthlyFollowupCandidate) { this.monthlySent.push(candidate); }
  async markMonthlyFollowupFailed(candidate: MonthlyFollowupCandidate, error: string) { this.monthlyFailures.push({ candidate, error }); }
  async addNote(_context: ContactContext, note: string) { this.notes.push(note); }
  async handoff(_context: ContactContext, reason: string, summary: string) {
    this.handoffs.push({ reason, summary });
    this.context.automationPaused = true;
    this.context.pipelineStage = "Aguardando especialista";
    if (!this.context.tags.includes("falar-com-especialista")) this.context.tags.push("falar-com-especialista");
  }
  async saveOutbound(_conversationId: string, _externalMessageId: string, content: string) { this.outbound.push(content); }
  async setAutomationPaused(_conversationId: string, paused: boolean) { this.context.automationPaused = paused; }
  async getDashboard() { return { stages: [], recentConversations: [], followup: { hot_leads: 0, eligible_leads: 0, opt_outs: 0, sent_last_30_days: 0 } }; }
  async getContactView() { return this.context; }
}
