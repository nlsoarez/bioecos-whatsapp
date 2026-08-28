import type { AllowedTag, PipelineStage } from "./constants.js";

export interface ContactContext {
  contactId: string;
  conversationId: string;
  leadId: string;
  phone: string;
  name: string | null;
  email: string | null;
  city: string | null;
  companyName: string | null;
  area: string | null;
  interest: string | null;
  service: string | null;
  course: string | null;
  objective: string | null;
  pipelineStage: PipelineStage;
  tags: AllowedTag[];
  automationPaused: boolean;
  qualificationStep: QualificationStep | null;
  temperature: LeadTemperature;
  followupEnabled: boolean;
  followupOptOut: boolean;
  workflowState: ConversationWorkflowState;
  currentOwner: string;
  handoffReason: string | null;
  coordinatorNotificationStatus: CoordinatorNotificationStatus;
  mainQuestions: string[];
  objections: string[];
  enrollmentStatus: EnrollmentStatus;
  followupNextAt: Date | null;
  followupAttempts: number;
}

export type QualificationStep = "name" | "email" | "city" | "objective";
export type LeadTemperature = "cold" | "warm" | "hot";
export type ConversationWorkflowState = "ai_attending" | "awaiting_coordinator" | "coordinator_attending" | "conversation_finished" | "enrollment_completed" | "not_interested";
export type CoordinatorNotificationStatus = "not_required" | "pending" | "sent" | "failed";
export type EnrollmentStatus = "pending" | "completed" | "not_interested";

export interface LeadAssessment {
  temperature: LeadTemperature;
  reason: string;
  mainQuestions: string[];
  objections: string[];
  course: string | null;
  interest: string | null;
  shouldHandoff: boolean;
  handoffReason: string | null;
  notInterested: boolean;
}

export interface MonthlyFollowupCandidate {
  leadId: string;
  contactId: string;
  conversationId: string;
  phone: string;
  name: string | null;
  course: string;
  attempts: number;
  step: 1 | 2 | 3;
  sequenceId: string;
  lockToken?: string;
}

export interface MonthlyFollowupSettings {
  enabled: boolean;
  intervalDays: number;
  maxAttempts: number;
  scheduleDays: number[];
}

export interface CoordinatorNotificationRecord {
  id: string;
  contactId: string;
  conversationId: string;
  message: string;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastError: string | null;
}

export interface ChatMessage {
  direction: "inbound" | "outbound";
  content: string;
  timestamp: Date;
}

export interface KnowledgeHit {
  id: string;
  title: string;
  content: string;
  score: number;
}

export interface InboundMessage {
  externalMessageId: string;
  phone: string;
  pushName: string | null;
  content: string;
  timestamp: Date;
  raw: unknown;
}

export interface OutboundWebhookMessage {
  externalMessageId: string;
  phone: string;
  content: string;
  timestamp: Date;
  raw: unknown;
}

export interface IngestResult {
  duplicate: boolean;
  context: ContactContext;
}

export interface ToolContext {
  contactId: string;
  conversationId: string;
  leadId: string;
}
