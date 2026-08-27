import { describe, expect, it } from "vitest";
import type { MessageSender } from "../src/services/evolution.service.js";
import { CoordinatorNotificationService } from "../src/services/coordinator-notification.service.js";
import { InMemoryRepository } from "./support/in-memory.repository.js";

class Sender implements MessageSender {
  constructor(private readonly fail = false) {}
  sent: string[] = [];
  async sendText(_phone: string, text: string) {
    if (this.fail) throw new Error("WhatsApp indisponível");
    this.sent.push(text);
    return { externalMessageId: "notification-1", raw: {} };
  }
}

const assessment = {
  temperature: "hot" as const, reason: "fechamento", mainQuestions: ["Como pagar?"], objections: [],
  course: "Aromaterapia", interest: "Aromaterapia", shouldHandoff: true, handoffReason: "fechamento", notInterested: false,
};

describe("notificação ao coordenador", () => {
  it("envia resumo e link direto e registra sucesso", async () => {
    const repository = new InMemoryRepository();
    const sender = new Sender();
    const service = new CoordinatorNotificationService(repository, sender, async () => "5521999999999", "https://painel.exemplo");
    const result = await service.notify(repository.context, { assessment, summary: "Lead quer fechar", lastMessage: "Como pagar?" });
    expect(result.status).toBe("sent");
    expect(sender.sent[0]).toContain("Aromaterapia");
    expect(sender.sent[0]).toContain("#conversation-conversation-1");
    expect(repository.notifications[0]?.status).toBe("sent");
  });

  it("registra falha recuperável quando o número não está configurado", async () => {
    const repository = new InMemoryRepository();
    const service = new CoordinatorNotificationService(repository, new Sender(), async () => null, "https://painel.exemplo");
    const result = await service.notify(repository.context, { assessment, summary: "Lead quer fechar", lastMessage: "Como pagar?" });
    expect(result.status).toBe("failed");
    expect(repository.notifications[0]?.lastError).toContain("não configurado");
  });
});
