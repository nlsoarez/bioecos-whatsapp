import type { AllowedTag, PipelineStage } from "../../src/domain/constants.js";
import type {
  ChatMessage, ContactContext, ConversationWorkflowState, CoordinatorNotificationRecord, InboundMessage,
  IngestResult, KnowledgeHit, LeadAssessment, LeadTemperature, MonthlyFollowupCandidate,
  MonthlyFollowupSettings, QualificationStep,
} from "../../src/domain/types.js";
import type { BioecosRepository, ContactUpdate } from "../../src/repositories/bioecos.repository.js";

export class InMemoryRepository implements BioecosRepository {
  context: ContactContext = {
    contactId: "contact-1", conversationId: "conversation-1", leadId: "lead-1", phone: "5521971970274",
    name: null, email: null, city: null, companyName: null, area: null, interest: null, service: null,
    course: null, objective: null, pipelineStage: "Novo contato", tags: [], automationPaused: false,
    qualificationStep: null, temperature: "cold", followupEnabled: false, followupOptOut: false,
    workflowState: "ai_attending", currentOwner: "ai", handoffReason: null,
    coordinatorNotificationStatus: "not_required", mainQuestions: [], objections: [],
    enrollmentStatus: "pending", followupNextAt: null, followupAttempts: 0,
  };
  seen = new Set<string>();
  recent: ChatMessage[] = [];
  outbound: string[] = [];
  notes: string[] = [];
  handoffs: Array<{ reason: string; summary: string }> = [];
  knowledge: KnowledgeHit[] = [];
  searchCalls: string[] = [];
  monthlySettings: MonthlyFollowupSettings = { enabled: false, intervalDays: 30, maxAttempts: 3, scheduleDays: [30, 60, 90] };
  monthlyCandidates: MonthlyFollowupCandidate[] = [];
  monthlySent: MonthlyFollowupCandidate[] = [];
  monthlyFailures: Array<{ candidate: MonthlyFollowupCandidate; error: string }> = [];
  assessments: LeadAssessment[] = [];
  notifications: CoordinatorNotificationRecord[] = [];

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
  async recordLeadAssessment(_context: ContactContext, assessment: LeadAssessment) {
    this.assessments.push(assessment);
    const rank = { cold: 0, warm: 1, hot: 2 } as const;
    if (rank[assessment.temperature] >= rank[this.context.temperature]) this.context.temperature = assessment.temperature;
    this.context.mainQuestions = [...new Set([...this.context.mainQuestions, ...assessment.mainQuestions])];
    this.context.objections = [...new Set([...this.context.objections, ...assessment.objections])];
    if (assessment.course) this.context.course = assessment.course;
    if (assessment.interest) this.context.interest = assessment.interest;
    if (assessment.notInterested) this.context.enrollmentStatus = "not_interested";
  }
  async scheduleFollowups() {
    if (!this.context.followupOptOut && this.context.enrollmentStatus === "pending") {
      this.context.followupEnabled = true;
      this.context.followupAttempts = 0;
    }
  }
  async cancelFollowups() { this.context.followupEnabled = false; this.context.followupNextAt = null; }
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
  async markMonthlyFollowupSent(candidate: MonthlyFollowupCandidate, _content: string) { this.monthlySent.push(candidate); }
  async markMonthlyFollowupFailed(candidate: MonthlyFollowupCandidate, error: string) { this.monthlyFailures.push({ candidate, error }); }
  async addNote(_context: ContactContext, note: string) { this.notes.push(note); }
  async handoff(_context: ContactContext, reason: string, summary: string) {
    this.handoffs.push({ reason, summary });
    this.context.automationPaused = true;
    this.context.pipelineStage = "Aguardando coordenador";
    this.context.workflowState = "awaiting_coordinator";
    this.context.currentOwner = "coordinator";
    this.context.handoffReason = reason;
    this.context.coordinatorNotificationStatus = "pending";
    this.context.followupEnabled = false;
    if (!this.context.tags.includes("falar-com-especialista")) this.context.tags.push("falar-com-especialista");
  }
  async createCoordinatorNotification(context: ContactContext, message: string) {
    const id = `notification-${this.notifications.length + 1}`;
    this.notifications.push({ id, contactId: context.contactId, conversationId: context.conversationId,
      message, status: "pending", attempts: 0, lastError: null });
    return id;
  }
  async getCoordinatorNotification(id: string) { return this.notifications.find((item) => item.id === id) ?? null; }
  async markCoordinatorNotification(id: string, status: "sent" | "failed", error?: string) {
    const item = this.notifications.find((candidate) => candidate.id === id);
    if (item) { item.status = status; item.attempts += 1; item.lastError = error ?? null; }
    this.context.coordinatorNotificationStatus = status;
  }
  async getFailedCoordinatorNotifications(limit: number) { return this.notifications.filter((item) => item.status === "failed").slice(0, limit); }
  async setConversationWorkflow(_conversationId: string, state: ConversationWorkflowState, owner: string, reason: string) {
    this.context.workflowState = state;
    this.context.currentOwner = owner;
    this.context.automationPaused = state !== "ai_attending";
    this.context.handoffReason = reason;
    const stages = { ai_attending: "IA atendendo", awaiting_coordinator: "Aguardando coordenador",
      coordinator_attending: "Coordenador atendendo", conversation_finished: "Conversa finalizada",
      enrollment_completed: "Matrícula concluída", not_interested: "Sem interesse" } as const;
    this.context.pipelineStage = stages[state];
    if (state === "enrollment_completed") this.context.enrollmentStatus = "completed";
    if (state === "not_interested") this.context.enrollmentStatus = "not_interested";
  }
  async getLeads() { return [this.context]; }
  async saveOutbound(_conversationId: string, _externalMessageId: string, content: string) {
    this.outbound.push(content);
    this.recent.push({ direction: "outbound", content, timestamp: new Date() });
  }
  async setAutomationPaused(_conversationId: string, paused: boolean) { this.context.automationPaused = paused; }
  async getDashboard() { return { stages: [], recentConversations: [], followup: { hot_leads: 0, eligible_leads: 0, opt_outs: 0, sent_last_30_days: 0 } }; }
  async getContactView() { return this.context; }
  async getConversationContactId() { return this.context.contactId; }
  async recordHumanOutbound(message: import("../../src/domain/types.js").OutboundWebhookMessage) {
    this.outbound.push(message.content);
    this.context.automationPaused = true;
    this.context.workflowState = "coordinator_attending";
    this.context.currentOwner = "coordinator";
    return true;
  }
  async exportContactData() { return this.context; }
  async deleteContactData() { return true; }
}
