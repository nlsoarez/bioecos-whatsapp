import { describe, expect, it } from "vitest";
import type { AgentClient, AgentToolExecutor } from "../src/services/openai.service.js";
import type { ChatMessage, ContactContext, InboundMessage, KnowledgeHit } from "../src/domain/types.js";
import type { MessageSender } from "../src/services/evolution.service.js";
import { ConversationService } from "../src/services/conversation.service.js";
import { InMemoryRepository } from "./support/in-memory.repository.js";

class FakeAgent implements AgentClient {
  calls = 0;
  async embed() { return null; }
  async respond(input: {
    prompt: string; context: ContactContext; recentMessages: ChatMessage[]; userMessage: string;
    knowledge: KnowledgeHit[]; tools: AgentToolExecutor;
  }) {
    this.calls += 1;
    const text = input.userMessage.toLowerCase();
    if (text.includes("aromaterapia")) return "O curso de Aromaterapia é online, com aulas gravadas e acesso vitalício pela Hotmart.";
    if (text.includes("próxima turma")) return "A próxima turma precisa ser confirmada pela equipe.";
    if (text.includes("quanto custa")) return "O valor atual precisa ser confirmado pela equipe.";
    if (text.includes("ctf")) return "A Bioecos realiza cadastro, atualização e regularização de CTF junto ao IBAMA.";
    if (text.includes("rapp")) return "Sim. A Bioecos elabora e envia o RAPP.";
    if (text.includes("renovar")) return "A Bioecos acompanha a renovação de licenças. Qual é a atividade da empresa?";
    if (text.includes("orçamento")) return "Para começar, qual é o nome da empresa?";
    return "Vou responder diretamente sobre o assunto informado.";
  }
}

class FakeSender implements MessageSender {
  sent: string[] = [];
  async sendText(_phone: string, text: string) {
    this.sent.push(text);
    return { externalMessageId: `sent-${this.sent.length}`, raw: {} };
  }
}

function inbound(content: string, id = `msg-${Math.random()}`): InboundMessage {
  return { externalMessageId: id, phone: "5521971970274", pushName: "Cliente", content, timestamp: new Date(), raw: {} };
}

function setup(knowledge = true) {
  const repository = new InMemoryRepository();
  if (knowledge) repository.knowledge = [{ id: "k1", title: "Base oficial", content: "Informação oficial", score: 1 }];
  const agent = new FakeAgent();
  const sender = new FakeSender();
  return { repository, agent, sender, service: new ConversationService(repository, agent, sender) };
}

describe("homologação Bioecos", () => {
  it("1. identifica pergunta direta sobre Aromaterapia e consulta a base", async () => {
    const s = setup();
    const result = await s.service.handle(inbound("Quero saber sobre o curso de aromaterapia."));
    expect(result.response).toContain("Aromaterapia");
    expect(s.repository.searchCalls).toHaveLength(1);
  });

  it("2. não inventa a próxima turma de paisagismo", async () => {
    const s = setup();
    const result = await s.service.handle(inbound("Quando é a próxima turma de paisagismo?"));
    expect(result.response).toContain("confirmada");
  });

  it("3. não apresenta preço da formação como vigente", async () => {
    const s = setup();
    const result = await s.service.handle(inbound("Quanto custa a formação de terapeuta?"));
    expect(result.response).toContain("confirmado");
  });

  it("4. trata CTF como avaliação técnica, não diagnóstico definitivo", async () => {
    const s = setup();
    const result = await s.service.handle(inbound("Minha empresa precisa de CTF?"));
    expect(result.response).toContain("CTF");
    expect(s.repository.searchCalls).toHaveLength(1);
  });

  it("5. responde sobre RAPP a partir da base", async () => {
    const s = setup();
    const result = await s.service.handle(inbound("Vocês fazem RAPP?"));
    expect(result.response).toContain("RAPP");
  });

  it("6. qualifica renovação de licença sem prometer prazo", async () => {
    const s = setup();
    const result = await s.service.handle(inbound("Preciso renovar minha licença."));
    expect(result.response).toContain("atividade");
  });

  it("7. pedido de orçamento aplica tag e inicia coleta", async () => {
    const s = setup();
    const result = await s.service.handle(inbound("Quero orçamento."));
    expect(s.repository.context.tags).toContain("orcamento");
    expect(s.repository.context.pipelineStage).toBe("Dados em coleta");
    expect(result.response).toContain("nome da empresa");
  });

  it("8. pedido de consultor realiza handoff e pausa IA", async () => {
    const s = setup();
    await s.service.handle(inbound("Quero falar com um consultor."));
    expect(s.repository.context.automationPaused).toBe(true);
    expect(s.repository.context.tags).toContain("falar-com-especialista");
    expect(s.agent.calls).toBe(0);
  });

  it("9. pergunta sem base não é inventada e gera handoff", async () => {
    const s = setup(false);
    const result = await s.service.handle(inbound("Vocês oferecem curso de mergulho?"));
    expect(result.response).toContain("equipe responsável");
    expect(s.repository.context.automationPaused).toBe(true);
    expect(s.agent.calls).toBe(0);
  });

  it("10. webhook duplicado produz uma única resposta", async () => {
    const s = setup();
    const message = inbound("Quero saber sobre aromaterapia.", "duplicate-id");
    await s.service.handle(message);
    const second = await s.service.handle(message);
    expect(second.status).toBe("duplicate");
    expect(s.sender.sent).toHaveLength(1);
  });

  it("11. atendente assumindo a conversa impede resposta da IA", async () => {
    const s = setup();
    s.repository.context.automationPaused = true;
    const result = await s.service.handle(inbound("Olá"));
    expect(result.status).toBe("paused");
    expect(s.sender.sent).toHaveLength(0);
  });

  it("12. assunto informado diretamente não força menu", async () => {
    const s = setup();
    const result = await s.service.handle(inbound("Preciso renovar minha licença."));
    expect(result.response).not.toContain("Digite o número");
    expect(result.response).toContain("renovação");
  });
});

