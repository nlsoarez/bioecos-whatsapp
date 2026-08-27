import { randomUUID } from "node:crypto";
import type { BioecosRepository } from "../repositories/bioecos.repository.js";
import type { MessageSender } from "./evolution.service.js";

export interface MonthlyFollowupRun {
  enabled: boolean;
  inspected: number;
  sent: number;
  failed: number;
}

export class MonthlyFollowupService {
  private running = false;

  constructor(
    private readonly repository: BioecosRepository,
    private readonly sender: MessageSender,
  ) {}

  async runOnce(limit = 25): Promise<MonthlyFollowupRun> {
    if (this.running) return { enabled: true, inspected: 0, sent: 0, failed: 0 };
    this.running = true;
    try {
      const settings = await this.repository.getMonthlyFollowupSettings();
      if (!settings.enabled) return { enabled: false, inspected: 0, sent: 0, failed: 0 };
      const candidates = await this.repository.getDueMonthlyFollowups(limit);
      let sentCount = 0;
      let failed = 0;

      for (const candidate of candidates) {
        const firstName = candidate.name?.trim().split(/\s+/)[0];
        const greeting = firstName ? `Olá, ${firstName}!` : "Olá!";
        const content = followupMessage(candidate.step, greeting, candidate.course);
        let sent;
        try {
          sent = await this.sender.sendText(candidate.phone, content);
        } catch (error) {
          failed += 1;
          await this.repository.markMonthlyFollowupFailed(candidate, error instanceof Error ? error.message : String(error));
          continue;
        }
        try {
          await this.repository.markMonthlyFollowupSent(candidate, content);
          await this.repository.saveOutbound(
            candidate.conversationId,
            sent.externalMessageId || `followup:${randomUUID()}`,
            content,
            sent.raw,
          );
          sentCount += 1;
        } catch {
          // A mensagem já foi entregue ao WhatsApp. Não reagendamos para evitar duplicidade.
          failed += 1;
        }
      }
      return { enabled: true, inspected: candidates.length, sent: sentCount, failed };
    } finally {
      this.running = false;
    }
  }
}

function followupMessage(step: 1 | 2 | 3, greeting: string, course: string): string {
  if (step === 1) {
    return `${greeting} Aqui é a Débora da Bioecos. Ficou alguma dúvida sobre ${course} que eu possa esclarecer? Se não quiser novos acompanhamentos, responda SAIR.`;
  }
  if (step === 2) {
    return `${greeting} Retomando nossa conversa sobre ${course}: seu interesse continua ou alguma questão está impedindo você de avançar? Para encerrar os acompanhamentos, responda SAIR.`;
  }
  return `${greeting} Este é meu último acompanhamento sobre ${course}. Se ainda fizer sentido para você, responda por aqui e continuamos da última conversa. Se preferir encerrar, responda SAIR.`;
}
