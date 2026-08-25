import { describe, expect, it } from "vitest";
import type { MessageSender } from "../src/services/evolution.service.js";
import { MonthlyFollowupService } from "../src/services/monthly-followup.service.js";
import { InMemoryRepository } from "./support/in-memory.repository.js";

class FakeSender implements MessageSender {
  sent: string[] = [];
  async sendText(_phone: string, text: string) {
    this.sent.push(text);
    return { externalMessageId: `followup-${this.sent.length}`, raw: {} };
  }
}

describe("acompanhamento mensal", () => {
  it("não envia nada enquanto o recurso global está desativado", async () => {
    const repository = new InMemoryRepository();
    repository.monthlyCandidates = [{
      leadId: "lead-1", contactId: "contact-1", conversationId: "conversation-1",
      phone: "5521971970274", name: "Maria", course: "Aromaterapia", attempts: 0,
    }];
    const sender = new FakeSender();
    const result = await new MonthlyFollowupService(repository, sender).runOnce();
    expect(result.enabled).toBe(false);
    expect(sender.sent).toHaveLength(0);
  });

  it("envia mensagem identificada, com opt-out, e registra o disparo", async () => {
    const repository = new InMemoryRepository();
    repository.monthlySettings.enabled = true;
    const candidate = {
      leadId: "lead-1", contactId: "contact-1", conversationId: "conversation-1",
      phone: "5521971970274", name: "Maria da Silva", course: "Aromaterapia", attempts: 0,
    };
    repository.monthlyCandidates = [candidate];
    const sender = new FakeSender();
    const result = await new MonthlyFollowupService(repository, sender).runOnce();
    expect(result).toMatchObject({ enabled: true, sent: 1, failed: 0 });
    expect(sender.sent[0]).toContain("Aromaterapia");
    expect(sender.sent[0]).toContain("SAIR");
    expect(repository.monthlySent).toEqual([candidate]);
  });
});
