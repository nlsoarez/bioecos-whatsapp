import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const knowledgePath = new URL("../config/knowledge/site-oficial-cursos.md", import.meta.url);

describe("base permanente de cursos", () => {
  it("contém os conteúdos principais publicados no site oficial", async () => {
    const content = await readFile(knowledgePath, "utf8");
    for (const expected of [
      "## Plantas Medicinais",
      "## Fitoterapia",
      "## Aromaterapia",
      "## Florais de Bach",
      "## Imersão em Paisagismo e Jardinagem",
      "## Mentoria Conexão Plena — A Jornada do Terapeuta",
      "## Aula Magna sobre Práticas Integrativas e Complementares",
    ]) {
      expect(content).toContain(expected);
    }
  });

  it("não armazena datas de turma, anos, preços ou promoções", async () => {
    const content = await readFile(knowledgePath, "utf8");
    expect(content).not.toMatch(/\b\d{1,2}\s+de\s+(?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i);
    expect(content).not.toMatch(/\b(?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+\d{4}\b/i);
    expect(content).not.toMatch(/\b(?:19|20)\d{2}\b/);
    expect(content).not.toMatch(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/);
    expect(content).not.toMatch(/R\$\s*\d/i);
    expect(content).not.toMatch(/valor promocional|mega promoção/i);
  });

  it("marca alegações clínicas e credenciamento como limites, não como promessas", async () => {
    const content = await readFile(knowledgePath, "utf8");
    expect(content).toContain("não deve prometer credenciamento nem autorização profissional");
    expect(content).toContain("sem diagnóstico, tratamento ou promessa de resultado clínico");
  });
});
