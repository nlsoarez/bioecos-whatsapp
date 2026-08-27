import type { ContactContext, LeadAssessment } from "../domain/types.js";
import type { BioecosRepository } from "../repositories/bioecos.repository.js";
import type { MessageSender } from "./evolution.service.js";

export interface HandoffDetails {
  assessment: LeadAssessment;
  summary: string;
  lastMessage: string;
}

export interface CoordinatorNotifier {
  notify(context: ContactContext, details: HandoffDetails): Promise<{ id: string; status: "sent" | "failed" }>;
  retry(id: string): Promise<{ id: string; status: "sent" | "failed" }>;
}

export class CoordinatorNotificationService implements CoordinatorNotifier {
  constructor(
    private readonly repository: BioecosRepository,
    private readonly sender: MessageSender,
    private readonly phoneProvider: () => Promise<string | null>,
    private readonly dashboardPublicUrl: string,
  ) {}

  async notify(context: ContactContext, details: HandoffDetails): Promise<{ id: string; status: "sent" | "failed" }> {
    const message = this.format(context, details);
    const id = await this.repository.createCoordinatorNotification(context, message);
    return this.send(id, message);
  }

  async retry(id: string): Promise<{ id: string; status: "sent" | "failed" }> {
    const notification = await this.repository.getCoordinatorNotification(id);
    if (!notification) throw new Error("Notificação não encontrada");
    return this.send(id, notification.message);
  }

  private async send(id: string, message: string): Promise<{ id: string; status: "sent" | "failed" }> {
    try {
      const phone = await this.phoneProvider();
      if (!phone) throw new Error("Telefone do coordenador não configurado");
      await this.sender.sendText(phone, message);
      await this.repository.markCoordinatorNotification(id, "sent");
      return { id, status: "sent" };
    } catch (error) {
      await this.repository.markCoordinatorNotification(id, "failed", error instanceof Error ? error.message : String(error));
      return { id, status: "failed" };
    }
  }

  private format(context: ContactContext, details: HandoffDetails): string {
    const linkBase = this.dashboardPublicUrl.replace(/\/$/, "");
    const directLink = linkBase ? `${linkBase}/#conversation-${context.conversationId}` : "Portal Bioecos";
    const questions = details.assessment.mainQuestions.length ? details.assessment.mainQuestions.join(" | ") : "Nenhuma registrada";
    return [
      "🔥 Lead aguardando coordenador",
      `Nome: ${context.name ?? "Não informado"}`,
      `WhatsApp: ${context.phone}`,
      `Curso/serviço: ${details.assessment.course ?? context.course ?? context.interest ?? "Em identificação"}`,
      `Resumo: ${details.summary}`,
      `Dúvidas principais: ${questions}`,
      `Última mensagem: ${details.lastMessage}`,
      `Abrir atendimento: ${directLink}`,
    ].join("\n");
  }
}

export class NoopCoordinatorNotifier implements CoordinatorNotifier {
  async notify(): Promise<{ id: string; status: "failed" }> { return { id: "noop", status: "failed" }; }
  async retry(id: string): Promise<{ id: string; status: "failed" }> { return { id, status: "failed" }; }
}
