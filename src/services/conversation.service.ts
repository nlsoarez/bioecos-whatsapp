import { randomUUID } from "node:crypto";
import { DEBORA_SYSTEM_PROMPT } from "../config/bioecos.js";
import { HUMAN_REQUEST_PATTERN, VARIABLE_INFORMATION_PATTERN } from "../domain/constants.js";
import type { InboundMessage, KnowledgeHit } from "../domain/types.js";
import type { BioecosRepository } from "../repositories/bioecos.repository.js";
import type { MessageSender } from "./evolution.service.js";
import type { AgentClient } from "./openai.service.js";
import { matchHybridRule } from "./hybrid-rules.service.js";
import { ToolService } from "./tool.service.js";

const HANDOFF_MESSAGE = "Certo. Vou deixar sua conversa com a equipe responsável, que continuará o atendimento por aqui.";

export class ConversationService {
  constructor(
    private readonly repository: BioecosRepository,
    private readonly agent: AgentClient,
    private readonly sender: MessageSender,
  ) {}

  async handle(message: InboundMessage): Promise<{ status: "duplicate" | "paused" | "responded"; response?: string }> {
    const ingestion = await this.repository.ingestInbound(message);
    if (ingestion.duplicate) return { status: "duplicate" };
    if (ingestion.context.automationPaused) return { status: "paused" };

    if (HUMAN_REQUEST_PATTERN.test(message.content)) {
      await this.repository.handoff(ingestion.context, "Solicitação direta de atendimento humano", message.content);
      await this.sendAndSave(ingestion.context.conversationId, message.phone, HANDOFF_MESSAGE);
      return { status: "responded", response: HANDOFF_MESSAGE };
    }

    const shouldConsult = VARIABLE_INFORMATION_PATTERN.test(message.content) || /\?$/.test(message.content.trim());
    let knowledge: KnowledgeHit[] = shouldConsult
      ? await this.repository.searchKnowledge(message.content, null, 4)
      : [];
    const rule = matchHybridRule(message.content, ingestion.context);
    if (rule) {
      if (rule.tag) await this.repository.addTag(ingestion.context, rule.tag);
      if (rule.stage) await this.repository.moveCard(ingestion.context, rule.stage, rule.stageReason ?? "Regra híbrida aplicada");
      if (rule.handoffReason) await this.repository.handoff(ingestion.context, rule.handoffReason, message.content);
      await this.sendAndSave(ingestion.context.conversationId, message.phone, rule.response);
      return { status: "responded", response: rule.response };
    }

    const recentMessages = await this.repository.getRecentMessages(ingestion.context.conversationId, 12);
    if (shouldConsult) {
      if (!knowledge.length) {
        const embedding = await this.agent.embed(message.content).catch(() => null);
        if (embedding) knowledge = await this.repository.searchKnowledge(message.content, embedding, 4);
      }
      if (!knowledge.length && !/^(oi|ol[aá]|bom dia|boa tarde|boa noite|quem [ée] voc[eê])/i.test(message.content)) {
        await this.repository.handoff(ingestion.context, "Informação não encontrada na base", message.content);
        await this.sendAndSave(ingestion.context.conversationId, message.phone, HANDOFF_MESSAGE);
        return { status: "responded", response: HANDOFF_MESSAGE };
      }
    }

    const tools = new ToolService(this.repository, this.agent, ingestion.context);
    let response: string;
    try {
      response = await this.agent.respond({
        prompt: DEBORA_SYSTEM_PROMPT,
        context: ingestion.context,
        recentMessages,
        userMessage: message.content,
        knowledge,
        tools,
      });
    } catch {
      await this.repository.handoff(ingestion.context, "Fallback de IA indisponível", message.content);
      response = HANDOFF_MESSAGE;
    }
    await this.sendAndSave(ingestion.context.conversationId, message.phone, response);
    return { status: "responded", response };
  }

  private async sendAndSave(conversationId: string, phone: string, content: string): Promise<void> {
    const sent = await this.sender.sendText(phone, content);
    await this.repository.saveOutbound(conversationId, sent.externalMessageId || `outbound:${randomUUID()}`, content, sent.raw);
  }
}
