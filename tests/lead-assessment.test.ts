import { describe, expect, it } from "vitest";
import { assessLead } from "../src/services/lead-assessment.service.js";
import { InMemoryRepository } from "./support/in-memory.repository.js";

describe("classificação contextual de leads", () => {
  it("classifica fechamento como quente usando o histórico completo", () => {
    const context = new InMemoryRepository().context;
    const result = assessLead("Como faço para pagar?", [
      { direction: "inbound", content: "Quero o curso de Aromaterapia", timestamp: new Date() },
      { direction: "outbound", content: "Posso esclarecer suas dúvidas.", timestamp: new Date() },
    ], context);
    expect(result).toMatchObject({ temperature: "hot", course: "Aromaterapia", shouldHandoff: true });
  });

  it("registra objeções sem fabricar intenção de fechamento", () => {
    const context = new InMemoryRepository().context;
    const result = assessLead("Tenho pouco tempo e queria entender o formato do curso de Fitoterapia", [], context);
    expect(result.temperature).toBe("warm");
    expect(result.shouldHandoff).toBe(false);
    expect(result.objections).toContain("tempo/disponibilidade");
    expect(result.objections).toContain("formato/modalidade");
  });

  it("reconhece desinteresse explícito", () => {
    const context = new InMemoryRepository().context;
    const result = assessLead("Não tenho interesse, pode encerrar", [], context);
    expect(result.notInterested).toBe(true);
    expect(result.shouldHandoff).toBe(false);
  });
});
