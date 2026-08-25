import { describe, expect, it } from "vitest";
import { normalizePhone, parseEvolutionWebhook } from "../src/services/evolution.service.js";

describe("Evolution webhook v2", () => {
  it("normaliza e extrai MESSAGES_UPSERT", () => {
    const result = parseEvolutionWebhook({
      event: "messages.upsert",
      data: {
        key: { id: "ABC123", remoteJid: "5521971970274@s.whatsapp.net", fromMe: false },
        pushName: "Cliente",
        message: { conversation: "Olá" },
        messageTimestamp: 1_700_000_000,
      },
    });
    expect(result?.externalMessageId).toBe("ABC123");
    expect(result?.phone).toBe("5521971970274");
    expect(result?.content).toBe("Olá");
  });

  it("ignora mensagens próprias e grupos", () => {
    expect(parseEvolutionWebhook({ data: { key: { id: "1", remoteJid: "55@g.us", fromMe: false }, message: { conversation: "x" } } })).toBeNull();
    expect(parseEvolutionWebhook({ data: { key: { id: "2", remoteJid: "5521971970274@s.whatsapp.net", fromMe: true }, message: { conversation: "x" } } })).toBeNull();
  });

  it("rejeita telefone inválido", () => {
    expect(() => normalizePhone("123")).toThrow("inválido");
  });
});

