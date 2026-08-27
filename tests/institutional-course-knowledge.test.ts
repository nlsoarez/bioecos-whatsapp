import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const knowledgePath = new URL("../config/knowledge/documentos-institucionais-cursos.md", import.meta.url);

describe("base ampliada dos documentos institucionais", () => {
  it("cobre as cinco ofertas e seus principais blocos de conteúdo", async () => {
    const content = await readFile(knowledgePath, "utf8");
    for (const expected of [
      "## Cursos Livres a Distância — proposta e formato",
      "## Imersão em Paisagismo e Jardinagem — conteúdo",
      "## Imersão em Práticas Integrativas e Complementares — conteúdo e materiais",
      "## Formação de Terapeutas Holísticos — conteúdo",
      "## Assinatura Bioecos Integral — público e conteúdo incluído",
      "planejamento de jardins",
      "mais de 160 videoaulas",
      "plataforma Hotmart",
    ]) {
      expect(content).toContain(expected);
    }
  });

  it("não persiste calendário, preço, promoção, escassez ou hospedagem como oferta", async () => {
    const content = await readFile(knowledgePath, "utf8");
    expect(content).not.toMatch(/\b\d{1,2}\s+de\s+(?:janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/i);
    expect(content).not.toMatch(/\b(?:19|20)\d{2}\b/);
    expect(content).not.toMatch(/R\$\s*\d/i);
    expect(content).not.toMatch(/valor promocional|mega promoção|poucas vagas/i);
    expect(content).not.toMatch(/pacotes? com e sem hospedagem/i);
  });

  it("converte linguagem clínica em limites de segurança", async () => {
    const content = await readFile(knowledgePath, "utf8");
    expect(content).toContain("não significa aprovação pela Anvisa ou pelo SUS");
    expect(content).toContain("Não deve prometer cura, tratamento de distúrbios");
    expect(content).not.toMatch(/tratamento de um dist[uú]rbio escolhido/i);
    expect(content).not.toMatch(/produtos indicados pela farmacopeia brasileira, SUS e ANVISA/i);
  });
});
