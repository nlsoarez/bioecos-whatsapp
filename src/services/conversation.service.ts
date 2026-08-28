import { randomUUID } from "node:crypto";
import { DEBORA_SYSTEM_PROMPT } from "../config/bioecos.js";
import type { ChatMessage, ContactContext, InboundMessage, KnowledgeHit, LeadAssessment } from "../domain/types.js";
import type { BioecosRepository } from "../repositories/bioecos.repository.js";
import type { MessageSender } from "./evolution.service.js";
import type { AgentClient } from "./openai.service.js";
import { assessLead } from "./lead-assessment.service.js";
import { NoopCoordinatorNotifier, type CoordinatorNotifier } from "./coordinator-notification.service.js";
import { ToolService } from "./tool.service.js";

const HANDOFF_MESSAGE = "Entendi. Registrei o que você precisa e a coordenação da equipe responsável continuará o atendimento por aqui.";
const NOT_INTERESTED_MESSAGE = "Certo. Registrei que você não tem interesse e encerrei os acompanhamentos automáticos.";
const TEMPORARY_ERROR_MESSAGE = "Estou com uma instabilidade temporária e não consegui concluir essa resposta agora. Por favor, tente novamente em alguns instantes.";
const GREETING_PATTERN = /^\s*(oi+|ol[aá]|bom dia|boa tarde|boa noite|quem [ée] voc[eê]|tudo bem)[!?.\s]*$/i;
const FOLLOWUP_OPT_OUT_PATTERN = /^(?:sair|parar|cancelar|n[aã]o quero (?:mais )?(?:mensagens|acompanhamento)|remova meu contato)[.!\s]*$/i;
const COURSE_OVERVIEW_PATTERN = /(?:quais?|lista|op[cç][oõ]es?|todos?).{0,30}(?:cursos?|forma[cç][oõ]es?)|(?:cursos?|forma[cç][oõ]es?).{0,30}(?:tem|t[eê]m|oferece|dispon[ií]ve)/i;
const COURSE_CONTENT_SUMMARIES: Record<string, string> = {
  "Plantas Medicinais": "Nos conteúdos publicados pela Bioecos, Plantas Medicinais inclui identificação das plantas, escolha da parte utilizada, colheita e extração de princípios ativos, com preparo por infusão, decocção e tinturas.",
  Fitoterapia: "Nos conteúdos publicados pela Bioecos, Fitoterapia inclui tinturas, terapêutica da fitoterapia, formas farmacêuticas, uso de tinturas em formulações e produção de Produtos Tradicionais Fitoterápicos.",
  Aromaterapia: "Nos conteúdos publicados pela Bioecos, Aromaterapia inclui trabalho seguro com óleos essenciais e vegetais, combinação entre esses óleos e aplicação em formulações e produtos demonstrados em aula.",
  "Florais de Bach": "Nos conteúdos publicados pela Bioecos, Florais de Bach inclui história, famílias dos florais, bioenergia das plantas e formas de uso apresentadas nos programas da escola.",
  "Cosmética, bem-estar e saúde": "Nos conteúdos publicados pela Bioecos, a parte de cosmética inclui produção de sabonetes, cremes, géis, escalda-pés, repelentes, óleos e cosméticos com plantas e minerais.",
};
const FREE_COURSES = new Set(Object.keys(COURSE_CONTENT_SUMMARIES));

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

    const selectedCourse = assessment.course ?? ingestion.context.course;
    const experienceReply = respondToExperienceLevel(message.content, recentMessages, selectedCourse);
    if (experienceReply) {
      await this.repository.addNote(ingestion.context, `Experiência informada: ${experienceReply.level}`);
      await this.sendAndSave(ingestion.context.conversationId, message.phone, experienceReply.response);
      return { status: "responded", response: experienceReply.response };
    }

    const ambiguousReply = clarifyAmbiguousAffirmation(message.content, recentMessages, selectedCourse);
    if (ambiguousReply) {
      await this.sendAndSave(ingestion.context.conversationId, message.phone, ambiguousReply);
      return { status: "responded", response: ambiguousReply };
    }

    const objective = inferCourseObjective(message.content, selectedCourse, ingestion.context.objective);
    if (objective && selectedCourse) {
      await this.repository.updateContact(ingestion.context, { objective });
      const response = `Entendi: seu objetivo com ${selectedCourse} é ${objective}. Registrei essa informação. Você quer esclarecer alguma dúvida específica sobre o curso ou deseja avançar para a inscrição?`;
      await this.sendAndSave(ingestion.context.conversationId, message.phone, response);
      if (!wasFollowupReply && assessment.temperature === "hot") await this.repository.scheduleFollowups(ingestion.context);
      return { status: "responded", response };
    }

    const courseOverviewRequested = COURSE_OVERVIEW_PATTERN.test(message.content);
    let knowledge: KnowledgeHit[] = GREETING_PATTERN.test(message.content)
      ? []
      : await this.repository.searchKnowledge(courseOverviewRequested ? "curso" : message.content, null, courseOverviewRequested ? 12 : 6);
    if (!knowledge.length && !GREETING_PATTERN.test(message.content)) {
      const embedding = await this.agent.embed(message.content).catch(() => null);
      if (embedding) knowledge = await this.repository.searchKnowledge(message.content, embedding, 6);
    }
    if (!knowledge.length && selectedCourse) {
      knowledge = await this.repository.searchKnowledge(selectedCourse, null, 6);
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
      response = enforceSupportedCourseResponse(response, selectedCourse, knowledge);
    } catch {
      await this.sendAndSave(ingestion.context.conversationId, message.phone, TEMPORARY_ERROR_MESSAGE);
      return { status: "responded", response: TEMPORARY_ERROR_MESSAGE };
    }

    await this.sendAndSave(ingestion.context.conversationId, message.phone, response);
    if (!wasFollowupReply && assessment.temperature === "hot" && assessment.course) {
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

function clarifyAmbiguousAffirmation(message: string, recentMessages: ChatMessage[], course: string | null): string | null {
  if (!/^\s*(sim|isso|sim,? por favor)\s*[!.]?\s*$/i.test(message)) return null;
  const lastOutbound = [...recentMessages].reverse().find((item) => item.direction === "outbound")?.content ?? "";
  if (!/[?？]\s*$/.test(lastOutbound.trim())) return null;
  if (/qual .{0,40}(objetivo|interesse)|o que (?:voc[eê] )?(?:pretende|busca)|para que/i.test(lastOutbound)) {
    return `Você escolheu ${course ?? "esse curso"}. Para eu orientar corretamente, preciso que me diga seu objetivo — por exemplo: trabalhar na área, complementar sua profissão ou aprender para uso pessoal.`;
  }
  if (/qual (?:curso|forma[cç][aã]o)|qual .{0,20}interessa/i.test(lastOutbound)) {
    return "Para continuar, escreva o nome do curso que você escolheu.";
  }
  return "Para eu continuar sem interpretar errado, responda com um pouco mais de detalhe sobre o que você deseja.";
}

function inferCourseObjective(message: string, course: string | null, existingObjective: string | null): string | null {
  if (!course || existingObjective || /[?？]/.test(message)) return null;
  const value = message.trim().replace(/[.!]+$/, "");
  if (value.length < 3 || value.length > 240) return null;
  if (/\b(trabalhar|atuar|profiss[aã]o|profissional|carreira|renda)\b/i.test(value)) return "trabalhar na área";
  if (/\b(complementar|aperfei[cç]oar|atualizar|especializar)\b/i.test(value)) return value;
  if (/\b(uso pessoal|para mim|fam[ií]lia|cuidar da fam[ií]lia|conhecimento|aprender)\b/i.test(value)) return value;
  return null;
}

function respondToExperienceLevel(
  message: string,
  recentMessages: ChatMessage[],
  course: string | null,
): { level: string; response: string } | null {
  if (!course) return null;
  const lastOutbound = [...recentMessages].reverse().find((item) => item.direction === "outbound")?.content ?? "";
  if (!/experi[eê]ncia|come[cç]ando agora|come[cç]ando do zero|j[aá] atua/i.test(lastOutbound)) return null;
  let level: string | null = null;
  if (/come[cç]ando agora|come[cç]ando do zero|do zero|sem experi[eê]ncia|iniciante/i.test(message)) level = "iniciante/sem experiência";
  if (/j[aá] (?:tenho|trabalho|atuo)|tenho experi[eê]ncia|sou profissional/i.test(message)) level = "já possui experiência";
  if (!level) return null;
  return { level, response: safeCourseBoundaryResponse(course, level === "iniciante/sem experiência") };
}

function enforceSupportedCourseResponse(response: string, course: string | null, knowledge: KnowledgeHit[]): string {
  if (!course || !FREE_COURSES.has(course)) return response;
  const officialText = knowledge.map((hit) => hit.content).join("\n");
  const offersMissingDetails = /(?:posso|gostaria|quer(?:ia)? que eu|vou).{0,100}(?:conte[uú]do|estrutura|m[oó]dulos?|grade|ementa)/i.test(response);
  const inventsCourseContent = /conceitos? fundamentais?|uso correto das plantas|pr[aá]ticas seguras|conte[uú]do program[aá]tico|grade curricular/i.test(response);
  const hasOfficialCourseContent = /(princ[ií]pios ativos|infus[aã]o|decoc[cç][aã]o|tinturas?|formas farmac[eê]uticas|produtos tradicionais fitoter[aá]picos|[oó]leos essenciais|[oó]leos vegetais|fam[ií]lias dos florais|bioenergia|sabonetes|cremes|g[eé]is)/i.test(officialText);
  const declaresCompleteSyllabus = /grade completa|m[oó]dulo a m[oó]dulo|ementa completa/i.test(response);
  return offersMissingDetails || inventsCourseContent || (declaresCompleteSyllabus && !hasOfficialCourseContent)
    ? safeCourseBoundaryResponse(course)
    : response;
}

function safeCourseBoundaryResponse(course: string, acknowledgeBeginner = false): string {
  const prefix = acknowledgeBeginner ? `Entendi: você está começando agora em ${course}. ` : "";
  const summary = COURSE_CONTENT_SUMMARIES[course] ?? `A base oficial confirma a oferta de ${course}.`;
  return `${prefix}${summary} Esses temas aparecem em programas da Bioecos; o site não publica uma grade completa, módulo a módulo, do EAD individual. Você quer esclarecer o formato disponível ou avançar para a inscrição?`;
}
