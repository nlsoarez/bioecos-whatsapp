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
}

export type QualificationStep = "name" | "email" | "city" | "objective";
export type LeadTemperature = "cold" | "warm" | "hot";

export interface MonthlyFollowupCandidate {
  leadId: string;
  contactId: string;
  conversationId: string;
  phone: string;
  name: string | null;
  course: string;
  attempts: number;
}

export interface MonthlyFollowupSettings {
  enabled: boolean;
  intervalDays: number;
  maxAttempts: number;
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

export interface IngestResult {
  duplicate: boolean;
  context: ContactContext;
}

export interface ToolContext {
  contactId: string;
  conversationId: string;
  leadId: string;
}
