import type { AllowedTag, PipelineStage } from "../domain/constants.js";
import type {
  ChatMessage, ContactContext, ConversationWorkflowState, CoordinatorNotificationRecord, InboundMessage,
  IngestResult, KnowledgeHit, LeadAssessment, LeadTemperature, MonthlyFollowupCandidate,
  MonthlyFollowupSettings, QualificationStep,
} from "../domain/types.js";

export type ContactUpdate = Partial<{
  name: string;
  email: string;
  city: string;
  state: string;
  cpf: string;
  companyName: string;
  profession: string;
  source: string;
  area: string;
  interest: string;
  service: string;
  course: string;
  objective: string;
}>;

export interface BioecosRepository {
  health(): Promise<boolean>;
  ingestInbound(message: InboundMessage): Promise<IngestResult>;
  getRecentMessages(conversationId: string, limit: number): Promise<ChatMessage[]>;
  getContext(conversationId: string): Promise<ContactContext>;
  searchKnowledge(query: string, embedding: number[] | null, limit: number): Promise<KnowledgeHit[]>;
  addTag(context: ContactContext, tag: AllowedTag): Promise<void>;
  moveCard(context: ContactContext, stage: PipelineStage, reason: string): Promise<void>;
  updateContact(context: ContactContext, values: ContactUpdate): Promise<void>;
  setQualificationStep(context: ContactContext, step: QualificationStep | null): Promise<void>;
  markLeadTemperature(context: ContactContext, temperature: LeadTemperature, enableMonthlyFollowup: boolean): Promise<void>;
  recordLeadAssessment(context: ContactContext, assessment: LeadAssessment): Promise<void>;
  scheduleFollowups(context: ContactContext): Promise<void>;
  cancelFollowups(context: ContactContext, reason: string): Promise<void>;
  optOutMonthlyFollowup(context: ContactContext): Promise<void>;
  getMonthlyFollowupSettings(): Promise<MonthlyFollowupSettings>;
  setMonthlyFollowupEnabled(enabled: boolean): Promise<MonthlyFollowupSettings>;
  getDueMonthlyFollowups(limit: number): Promise<MonthlyFollowupCandidate[]>;
  markMonthlyFollowupSent(candidate: MonthlyFollowupCandidate, content: string): Promise<void>;
  markMonthlyFollowupFailed(candidate: MonthlyFollowupCandidate, error: string): Promise<void>;
  addNote(context: ContactContext, note: string): Promise<void>;
  handoff(context: ContactContext, reason: string, summary: string): Promise<void>;
  createCoordinatorNotification(context: ContactContext, message: string): Promise<string>;
  getCoordinatorNotification(id: string): Promise<CoordinatorNotificationRecord | null>;
  markCoordinatorNotification(id: string, status: "sent" | "failed", error?: string): Promise<void>;
  getFailedCoordinatorNotifications(limit: number): Promise<CoordinatorNotificationRecord[]>;
  setConversationWorkflow(conversationId: string, state: ConversationWorkflowState, owner: string, reason: string): Promise<void>;
  getLeads(filter: string): Promise<unknown[]>;
  saveOutbound(conversationId: string, externalMessageId: string, content: string, metadata: unknown): Promise<void>;
  setAutomationPaused(conversationId: string, paused: boolean, actor: string): Promise<void>;
  getDashboard(): Promise<unknown>;
  getContactView(contactId: string): Promise<unknown | null>;
}
