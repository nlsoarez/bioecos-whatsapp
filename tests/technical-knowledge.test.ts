import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const knowledgePath = new URL("../config/knowledge/referencias-tecnicas-cursos.md", import.meta.url);

describe("referências técnicas complementares", () => {
  it("cobre fundamentos ligados às linhas dos cursos", async () => {
    const content = await readFile(knowledgePath, "utf8");
    for (const expected of [
      "## Plantas medicinais e fitoterápicos — diferença fundamental",
      "## Formas de preparo de plantas medicinais",
      "## Aromaterapia — conceito e segurança",
      "## Florais de Bach — definição e nível de evidência",
      "## Cosméticos, formulação e rotulagem",
      "## Paisagismo, jardinagem e jardins funcionais",
      "## Compostagem e aproveitamento de resíduos",
    ]) {
      expect(content).toContain(expected);
    }
  });

  it("não transforma referência externa em grade da Bioecos", async () => {
    const content = await readFile(knowledgePath, "utf8");
    expect(content).toContain("não descreve a grade, o certificado, o formato ou os resultados de nenhum curso da Bioecos");
    expect(content).toContain("não necessariamente a grade do curso escolhido");
  });

  it("mantém limites médicos e científicos explícitos", async () => {
    const content = await readFile(knowledgePath, "utf8");
    expect(content).toContain("não deve fornecer receita, dose ou protocolo individual");
    expect(content).toContain("não encontraram benefício dos Florais de Bach superior ao placebo");
    expect(content).toContain("não deve recomendar ingestão, diluição, dose, mistura ou aplicação");
  });

  it("não armazena calendário, preço ou promoção de curso", async () => {
    const content = await readFile(knowledgePath, "utf8");
    expect(content).not.toMatch(/\b\d{1,2}\s+de\s+(?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i);
    expect(content).not.toMatch(/R\$\s*\d/i);
    expect(content).not.toMatch(/valor promocional|mega promoção|próxima turma/i);
  });
});
