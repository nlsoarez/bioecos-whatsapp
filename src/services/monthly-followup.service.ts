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
        const content = `${greeting} Aqui é a Débora da Bioecos. Você ainda tem interesse em ${candidate.course}? Se quiser continuar, responda SIM. Se não quiser mais mensagens, responda SAIR.`;
        let sent;
        try {
          sent = await this.sender.sendText(candidate.phone, content);
        } catch (error) {
          failed += 1;
          await this.repository.markMonthlyFollowupFailed(candidate, error instanceof Error ? error.message : String(error));
          continue;
        }
        try {
          await this.repository.markMonthlyFollowupSent(candidate);
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
