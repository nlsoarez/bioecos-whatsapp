import type { ContactContext, CoordinatorNotificationRecord, LeadAssessment } from "../domain/types.js";
import type { BioecosRepository } from "../repositories/bioecos.repository.js";
import type { MessageSender } from "./evolution.service.js";

const RETRY_DELAYS_MINUTES = [1, 5, 15, 60] as const;

export interface HandoffDetails {
  assessment: LeadAssessment;
  summary: string;
  lastMessage: string;
  reason: string;
  sourceMessageId: string;
  requestedAt: Date;
}

export interface CoordinatorNotificationResult {
  id: string;
  status: "pending" | "accepted" | "failed";
  providerMessageId: string | null;
}

export interface CoordinatorNotifier {
  notify(context: ContactContext, details: HandoffDetails): Promise<CoordinatorNotificationResult>;
  retry(id: string): Promise<CoordinatorNotificationResult>;
  runDue(limit?: number): Promise<{ inspected: number; accepted: number; pending: number; failed: number }>;
}

export class CoordinatorNotificationService implements CoordinatorNotifier {
  private running = false;

  constructor(
    private readonly repository: BioecosRepository,
    private readonly sender: MessageSender,
    private readonly phoneProvider: () => Promise<string | null>,
    private readonly dashboardPublicUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async notify(context: ContactContext, details: HandoffDetails): Promise<CoordinatorNotificationResult> {
    const message = this.format(context, details);
    const id = await this.repository.handoffWithCoordinatorNotification(context, details.reason, details.summary, {
      message, sourceMessageId: details.sourceMessageId, requestedAt: details.requestedAt,
    });
    return this.attempt(id);
  }

  async retry(id: string): Promise<CoordinatorNotificationResult> {
    const existing = await this.repository.getCoordinatorNotification(id);
    if (!existing) throw new Error("Notificação não encontrada");
    if (existing.status === "accepted") return this.result(existing);
    if (existing.status === "failed") await this.repository.requeueCoordinatorNotification(id);
    return this.attempt(id);
  }

  async runDue(limit = 20): Promise<{ inspected: number; accepted: number; pending: number; failed: number }> {
    if (this.running) return { inspected: 0, accepted: 0, pending: 0, failed: 0 };
    this.running = true;
    try {
      const claimed = await this.repository.claimDueCoordinatorNotifications(limit);
      const totals = { inspected: claimed.length, accepted: 0, pending: 0, failed: 0 };
      for (const notification of claimed) {
        const result = await this.sendClaimed(notification);
        totals[result.status] += 1;
      }
      return totals;
    } finally {
      this.running = false;
    }
  }

  private async attempt(id: string): Promise<CoordinatorNotificationResult> {
    const claimed = await this.repository.claimCoordinatorNotification(id);
    if (claimed) return this.sendClaimed(claimed);
    const existing = await this.repository.getCoordinatorNotification(id);
    if (!existing) throw new Error("Notificação não encontrada");
    return this.result(existing);
  }

  private async sendClaimed(notification: CoordinatorNotificationRecord): Promise<CoordinatorNotificationResult> {
    let recipientPhone: string | null = null;
    try {
      recipientPhone = await this.phoneProvider();
      if (!recipientPhone) throw new Error("Telefone do coordenador não configurado");
      const sent = await this.sender.sendText(recipientPhone, notification.message);
      await this.repository.markCoordinatorNotificationAccepted(notification.id, recipientPhone, sent.externalMessageId);
      return { id: notification.id, status: "accepted", providerMessageId: sent.externalMessageId };
    } catch (error) {
      const delay = RETRY_DELAYS_MINUTES[notification.attempts - 1];
      const nextAttemptAt = delay === undefined ? null : new Date(this.now().getTime() + delay * 60_000);
      await this.repository.markCoordinatorNotificationRetry(
        notification.id, error instanceof Error ? error.message : String(error), nextAttemptAt, recipientPhone,
      );
      return { id: notification.id, status: nextAttemptAt ? "pending" : "failed", providerMessageId: null };
    }
  }

  private result(notification: CoordinatorNotificationRecord): CoordinatorNotificationResult {
    return {
      id: notification.id,
      status: notification.status === "accepted" ? "accepted" : notification.status === "failed" ? "failed" : "pending",
      providerMessageId: notification.providerMessageId,
    };
  }

  private format(context: ContactContext, details: HandoffDetails): string {
    const linkBase = this.dashboardPublicUrl.replace(/\/$/, "");
    const directLink = linkBase ? `${linkBase}/#conversation-${context.conversationId}` : "Portal Bioecos";
    const questions = details.assessment.mainQuestions.length ? details.assessment.mainQuestions.join(" | ") : "Nenhuma registrada";
    const requestedAt = new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short", timeStyle: "medium", timeZone: "America/Sao_Paulo",
    }).format(details.requestedAt);
    return [
      "🔥 Atendimento humano solicitado",
      `Nome: ${context.name ?? "Não informado"}`,
      `WhatsApp: ${context.phone}`,
      `Motivo: ${details.reason}`,
      `Solicitado em: ${requestedAt}`,
      `Curso/serviço: ${details.assessment.course ?? context.course ?? context.interest ?? "Em identificação"}`,
      `Resumo: ${details.summary}`,
      `Dúvidas principais: ${questions}`,
      `Última mensagem: ${details.lastMessage}`,
      `Abrir atendimento: ${directLink}`,
    ].join("\n");
  }
}

export class NoopCoordinatorNotifier implements CoordinatorNotifier {
  async notify(): Promise<CoordinatorNotificationResult> { return { id: "noop", status: "failed", providerMessageId: null }; }
  async retry(id: string): Promise<CoordinatorNotificationResult> { return { id, status: "failed", providerMessageId: null }; }
  async runDue() { return { inspected: 0, accepted: 0, pending: 0, failed: 0 }; }
}
