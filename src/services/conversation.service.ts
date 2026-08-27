import { randomUUID } from "node:crypto";
import { DEBORA_SYSTEM_PROMPT } from "../config/bioecos.js";
import type { ChatMessage, ContactContext, InboundMessage, KnowledgeHit, LeadAssessment } from "../domain/types.js";
import type { BioecosRepository } from "../repositories/bioecos.repository.js";
import type { MessageSender } from "./evolution.service.js";
import type { AgentClient } from "./openai.service.js";
import { assessLead } from "./lead-assessment.service.js";
import { FOLLOWUP_OPT_OUT_PATTERN } from "./qualification.service.js";
import { NoopCoordinatorNotifier, type CoordinatorNotifier } from "./coordinator-notification.service.js";
import { ToolService } from "./tool.service.js";

const HANDOFF_MESSAGE = "Entendi. Registrei o que você precisa e a coordenação da equipe responsável continuará o atendimento por aqui.";
const NOT_INTERESTED_MESSAGE = "Certo. Registrei que você não tem interesse e encerrei os acompanhamentos automáticos.";
const TEMPORARY_ERROR_MESSAGE = "Estou com uma instabilidade temporária e não consegui concluir essa resposta agora. Por favor, tente novamente em alguns instantes.";
const GREETING_PATTERN = /^\s*(oi+|ol[aá]|bom dia|boa tarde|boa noite|quem [ée] voc[eê]|tudo bem)[!?.\s]*$/i;
const COURSE_OVERVIEW_PATTERN = /(?:quais?|lista|op[cç][oõ]es?|todos?).{0,30}(?:cursos?|forma[cç][oõ]es?)|(?:cursos?|forma[cç][oõ]es?).{0,30}(?:tem|t[eê]m|oferece|dispon[ií]ve)/i;

export class ConversationService {
  constructor(
    private readonly repository: BioecosRepository,
    private readonly agent: AgentClient,
    private readonly sender: MessageSender,
    private readonly notifier: CoordinatorNotifier = new NoopCoordinatorNotifier(),
  ) {}

  async handle(message: InboundMessage): Promise<{ status: "duplicate" | "paused" | "responded"; response?: string }> {
    const ingestion = await this.repository.ingestInbound(message);
    if (ingestion.duplicate) return { status: "duplicate" };

    if (FOLLOWUP_OPT_OUT_PATTERN.test(message.content)) {
      await this.repository.optOutMonthlyFollowup(ingestion.context);
      const response = "Certo. O acompanhamento automático foi cancelado e você não receberá novos lembretes.";
      await this.sendAndSave(ingestion.context.conversationId, message.phone, response);
      return { status: "responded", response };
    }

    if (ingestion.context.automationPaused || ingestion.context.currentOwner !== "ai") return { status: "paused" };

    const recentMessages = await this.repository.getRecentMessages(ingestion.context.conversationId, 24);
    const wasFollowupReply = ingestion.context.followupEnabled;
    await this.repository.cancelFollowups(ingestion.context, "O contato respondeu; sequência anterior cancelada");
    const assessment = assessLead(message.content, recentMessages, ingestion.context);
    await this.repository.recordLeadAssessment(ingestion.context, assessment);

    if (assessment.notInterested) {
      await this.repository.setConversationWorkflow(
        ingestion.context.conversationId, "not_interested", "ai", "Contato declarou não ter interesse",
      );
      await this.sendAndSave(ingestion.context.conversationId, message.phone, NOT_INTERESTED_MESSAGE);
      return { status: "responded", response: NOT_INTERESTED_MESSAGE };
    }

    if (assessment.temperature === "warm" && ["Novo contato", "IA atendendo"].includes(ingestion.context.pipelineStage)) {
      await this.repository.moveCard(ingestion.context, "Interesse identificado", assessment.reason);
    } else if (assessment.temperature === "cold" && ingestion.context.pipelineStage === "Novo contato") {
      await this.repository.moveCard(ingestion.context, "IA atendendo", "Atendimento iniciado pela IA");
    }

    if (assessment.shouldHandoff) {
      return this.handoffAndRespond(ingestion.context, assessment, recentMessages, message, assessment.handoffReason!);
    }

    const courseOverviewRequested = COURSE_OVERVIEW_PATTERN.test(message.content);
    let knowledge: KnowledgeHit[] = GREETING_PATTERN.test(message.content)
      ? []
      : await this.repository.searchKnowledge(courseOverviewRequested ? "curso" : message.content, null, courseOverviewRequested ? 12 : 6);
    if (!knowledge.length && !GREETING_PATTERN.test(message.content)) {
      const embedding = await this.agent.embed(message.content).catch(() => null);
      if (embedding) knowledge = await this.repository.searchKnowledge(message.content, embedding, 6);
    }

    const tools = new ToolService(this.repository, this.agent, ingestion.context);
    let response: string;
    try {
      response = await this.agent.respond({
        prompt: DEBORA_SYSTEM_PROMPT,
        context: { ...ingestion.context, temperature: assessment.temperature, course: assessment.course ?? ingestion.context.course,
          interest: assessment.interest ?? ingestion.context.interest, mainQuestions: assessment.mainQuestions,
          objections: assessment.objections },
        recentMessages,
        userMessage: message.content,
        knowledge,
        tools,
      });
    } catch {
      await this.sendAndSave(ingestion.context.conversationId, message.phone, TEMPORARY_ERROR_MESSAGE);
      return { status: "responded", response: TEMPORARY_ERROR_MESSAGE };
    }

    await this.sendAndSave(ingestion.context.conversationId, message.phone, response);
    if (!wasFollowupReply && assessment.temperature === "warm" && assessment.course) {
      await this.repository.scheduleFollowups(ingestion.context);
    }
    return { status: "responded", response };
  }

  private async handoffAndRespond(
    context: ContactContext,
    assessment: LeadAssessment,
    recentMessages: ChatMessage[],
    message: InboundMessage,
    reason: string,
  ): Promise<{ status: "responded"; response: string }> {
    const summary = buildSummary(context, assessment, recentMessages, message.content);
    if (/or[cç]amento|proposta/i.test(message.content)) await this.repository.addTag(context, "orcamento");
    if (/matr[ií]cula|inscri[cç][aã]o|me inscrever|quero continuar|^\s*sim\s*$/i.test(message.content)) await this.repository.addTag(context, "inscricao");
    await this.repository.handoff(context, reason, summary);
    await this.notifier.notify(context, { assessment, summary, lastMessage: message.content }).catch(() => null);
    await this.sendAndSave(context.conversationId, message.phone, HANDOFF_MESSAGE);
    return { status: "responded", response: HANDOFF_MESSAGE };
  }

  private async sendAndSave(conversationId: string, phone: string, content: string): Promise<void> {
    const sent = await this.sender.sendText(phone, content);
    await this.repository.saveOutbound(conversationId, sent.externalMessageId || `outbound:${randomUUID()}`, content, sent.raw);
  }
}

function buildSummary(context: ContactContext, assessment: LeadAssessment, messages: ChatMessage[], current: string): string {
  const relevant = messages.filter((item) => item.direction === "inbound").map((item) => item.content).slice(-5);
  const conversation = [...relevant, current].filter((value, index, values) => values.indexOf(value) === index).join(" | ");
  return [
    `Lead ${assessment.temperature.toUpperCase()}`,
    `interesse: ${assessment.course ?? context.course ?? context.interest ?? "em identificação"}`,
    assessment.objections.length ? `objeções: ${assessment.objections.join(", ")}` : "sem objeção registrada",
    `contexto recente: ${conversation.slice(0, 900)}`,
  ].join("; ");
}
