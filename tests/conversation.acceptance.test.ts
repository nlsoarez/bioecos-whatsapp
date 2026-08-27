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
  }): Promise<string> {
    this.calls += 1;
    const text = input.userMessage.toLowerCase();
    if (text.includes("aromaterapia")) return "Aromaterapia consta entre os cursos livres da Bioecos. O documento não informa duração ou metodologia.";
    if (text.includes("fitoterapia")) return "Fitoterapia consta entre os cursos livres da Bioecos. Qual é o seu objetivo com o curso?";
    if (text.includes("próxima turma")) return "A próxima turma precisa ser confirmada pela equipe.";
    if (text.includes("quanto custa")) return "O valor atual precisa ser confirmado pela equipe.";
    if (text.includes("quais cursos")) return "A Bioecos oferece cursos livres, imersões, atualização em práticas integrativas e formação de terapeutas holísticos.";
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

  it("7. pedido de orçamento aplica tag e encaminha ao coordenador", async () => {
    const s = setup();
    const result = await s.service.handle(inbound("Quero orçamento."));
    expect(s.repository.context.tags).toContain("orcamento");
    expect(s.repository.context.pipelineStage).toBe("Aguardando coordenador");
    expect(s.repository.context.workflowState).toBe("awaiting_coordinator");
    expect(result.response).toContain("coordenação");
  });

  it("8. pedido de consultor realiza handoff e pausa IA", async () => {
    const s = setup();
    await s.service.handle(inbound("Quero falar com um consultor."));
    expect(s.repository.context.automationPaused).toBe(true);
    expect(s.repository.context.tags).toContain("falar-com-especialista");
    expect(s.agent.calls).toBe(0);
  });

  it("9. pergunta sem base não é inventada nem gera handoff", async () => {
    const s = setup(false);
    const result = await s.service.handle(inbound("Vocês oferecem curso de mergulho?"));
    expect(result.response).toContain("responder diretamente");
    expect(s.repository.context.automationPaused).toBe(false);
    expect(s.agent.calls).toBe(1);
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

  it("13. assunto conhecido usa IA-first com base oficial", async () => {
    const s = setup();
    const result = await s.service.handle(inbound("Vocês têm curso de fitoterapia?"));
    expect(result.response).toContain("Fitoterapia");
    expect(s.agent.calls).toBe(1);
  });

  it("14. mensagem não coberta usa a IA como fallback", async () => {
    const s = setup();
    const result = await s.service.handle(inbound("Quero entender melhor como vocês podem me orientar"));
    expect(result.response).toContain("responder diretamente");
    expect(s.agent.calls).toBe(1);
  });

  it("15. falha da IA informa instabilidade sem acionar a coordenação", async () => {
    const s = setup();
    s.agent.respond = async () => { throw new Error("Sem crédito"); };
    const result = await s.service.handle(inbound("Tenho uma dúvida diferente"));
    expect(result.response).toContain("instabilidade temporária");
    expect(s.repository.context.automationPaused).toBe(false);
    expect(s.sender.sent).toHaveLength(1);
  });

  it("16. mantém conversa natural e agenda acompanhamento para interesse morno", async () => {
    const s = setup();
    await s.service.handle(inbound("Vocês têm curso de aromaterapia?"));
    expect(s.repository.context.course).toBe("Aromaterapia");
    expect(s.repository.context.temperature).toBe("warm");
    expect(s.repository.context.qualificationStep).toBeNull();
    expect(s.repository.context.followupEnabled).toBe(true);
    expect(s.agent.calls).toBe(1);
  });

  it("17. classifica intenção explícita de matrícula como quente e mantém a IA", async () => {
    const s = setup();
    await s.service.handle(inbound("Quero me inscrever no curso de aromaterapia"));
    expect(s.repository.context.temperature).toBe("hot");
    expect(s.repository.context.followupEnabled).toBe(false);
    expect(s.repository.context.workflowState).toBe("ai_attending");
    expect(s.repository.context.automationPaused).toBe(false);
    expect(s.agent.calls).toBe(1);
  });

  it("18. SAIR cancela o acompanhamento mesmo com atendimento pausado", async () => {
    const s = setup();
    s.repository.context.automationPaused = true;
    s.repository.context.followupEnabled = true;
    const result = await s.service.handle(inbound("SAIR"));
    expect(result.response).toContain("cancelado");
    expect(s.repository.context.followupOptOut).toBe(true);
    expect(s.sender.sent).toHaveLength(1);
  });

  it("19. SIM após acompanhamento retoma a conversa com a IA", async () => {
    const s = setup();
    s.repository.context.temperature = "hot";
    s.repository.context.followupEnabled = true;
    const result = await s.service.handle(inbound("SIM"));
    expect(result.response).toContain("responder diretamente");
    expect(s.repository.context.workflowState).toBe("ai_attending");
    expect(s.repository.context.automationPaused).toBe(false);
    expect(s.agent.calls).toBe(1);
  });

  it("20. pergunta genérica sobre cursos recupera a base e não notifica o coordenador", async () => {
    const s = setup(false);
    s.repository.knowledge = [{ id: "k-list", title: "Cursos", content: "Cursos Livres e formações", score: 1 }];
    const result = await s.service.handle(inbound("Quais cursos vcs tem?"));
    expect(result.response).toContain("cursos livres");
    expect(s.repository.searchCalls).toEqual(["curso"]);
    expect(s.repository.context.automationPaused).toBe(false);
    expect(s.repository.notifications).toHaveLength(0);
  });

  it("21. não interpreta SIM como objetivo nem perde o curso selecionado", async () => {
    const s = setup();
    await s.service.handle(inbound("Quero Fitoterapia"));
    const result = await s.service.handle(inbound("sim"));
    expect(result.response).toContain("Você escolheu Fitoterapia");
    expect(result.response).toContain("trabalhar na área");
    expect(s.agent.calls).toBe(1);
    expect(s.repository.context.course).toBe("Fitoterapia");
    expect(s.repository.context.temperature).toBe("warm");
  });

  it("22. registra o objetivo e encerra a investigação repetitiva", async () => {
    const s = setup();
    await s.service.handle(inbound("Quero Fitoterapia"));
    const result = await s.service.handle(inbound("trabalhar com isso"));
    expect(s.repository.context.objective).toBe("trabalhar na área");
    expect(result.response).toContain("seu objetivo com Fitoterapia é trabalhar na área");
    expect(result.response).toContain("dúvida específica");
    expect(result.response).not.toContain("experiência");
    expect(s.agent.calls).toBe(1);
  });

  it("23. não promete conteúdo ou estrutura ao contato iniciante", async () => {
    const s = setup();
    s.repository.context.course = "Fitoterapia";
    s.repository.context.interest = "Fitoterapia";
    s.repository.recent.push({
      direction: "outbound",
      content: "Você já tem experiência na área ou está começando agora?",
      timestamp: new Date(),
    });
    const result = await s.service.handle(inbound("Começando agora"));
    expect(result.response).toContain("não detalham conteúdo, módulos, estrutura, duração ou metodologia");
    expect(result.response).not.toContain("conceitos fundamentais");
    expect(s.repository.notes).toContain("Experiência informada: iniciante/sem experiência");
    expect(s.agent.calls).toBe(0);
  });

  it("24. bloqueia oferta inventada de detalhes ausentes na base", async () => {
    const s = setup();
    s.repository.context.course = "Fitoterapia";
    s.repository.context.interest = "Fitoterapia";
    s.repository.knowledge = [{
      id: "k-course",
      title: "Cursos Livres",
      content: "O documento não informa módulos, duração, metodologia ou formato detalhado. Esses dados não podem ser presumidos.",
      score: 1,
    }];
    s.agent.respond = async () => "Posso explicar o conteúdo e a estrutura, incluindo conceitos fundamentais e práticas seguras. Quer saber?";
    const result = await s.service.handle(inbound("Pode me orientar melhor?"));
    expect(result.response).toContain("não detalham conteúdo, módulos, estrutura, duração ou metodologia");
    expect(result.response).not.toContain("práticas seguras");
    expect(s.repository.context.automationPaused).toBe(false);
  });
});
