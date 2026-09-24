import { describe, expect, it } from "vitest";
import type { InboundMessage } from "../src/domain/types.js";
import { ConversationService } from "../src/services/conversation.service.js";
import { InMemoryRepository } from "./support/in-memory.repository.js";

describe("barreira de números ignorados", () => {
  it("encerra antes de criar contato, chamar IA ou enviar resposta", async () => {
    const repository = new InMemoryRepository();
    await repository.createIgnoredPhoneNumber({ phoneNumber: "+55 21 97197-0274", name: null, note: null, active: true }, "test");
    let aiCalls = 0;
    let sends = 0;
    const agent = {
      embed: async () => { aiCalls += 1; return null; },
      respond: async () => { aiCalls += 1; return "não deve responder"; },
    };
    const sender = {
      sendText: async () => { sends += 1; return { externalMessageId: "unexpected", raw: {} }; },
    };
    const service = new ConversationService(repository, agent, sender);
    const message: InboundMessage = {
      externalMessageId: "ignored-direct", phone: "21971970274", pushName: "Pessoa protegida",
      content: "Quero informações", timestamp: new Date(), raw: {},
    };
    await expect(service.handle(message)).resolves.toEqual({ status: "ignored" });
    expect(repository.seen.size).toBe(0);
    expect(repository.recent).toHaveLength(0);
    expect(aiCalls).toBe(0);
    expect(sends).toBe(0);
  });
});
