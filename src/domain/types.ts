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

