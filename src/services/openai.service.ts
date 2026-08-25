import type { Env } from "../config/env.js";
import { ALLOWED_TAGS, PIPELINE_STAGES } from "../domain/constants.js";
import type { ChatMessage, ContactContext, KnowledgeHit } from "../domain/types.js";

export interface AgentToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentToolExecutor {
  execute(call: AgentToolCall): Promise<unknown>;
}

export interface AgentClient {
  embed(text: string): Promise<number[] | null>;
  respond(input: {
    prompt: string;
    context: ContactContext;
    recentMessages: ChatMessage[];
    userMessage: string;
    knowledge: KnowledgeHit[];
    tools: AgentToolExecutor;
  }): Promise<string>;
}

type ResponseOutputItem = Record<string, unknown> & { type?: string; name?: string; arguments?: string; call_id?: string };
type OpenAIResponse = { id?: string; output?: ResponseOutputItem[]; output_text?: string; error?: unknown };

export class OpenAIResponsesClient implements AgentClient {
  constructor(private readonly env: Env, private readonly request: typeof fetch = fetch) {}

  async embed(text: string): Promise<number[] | null> {
    if (!this.env.OPENAI_API_KEY) return null;
    const response = await this.post("/embeddings", { model: this.env.AI_EMBEDDING_MODEL, input: text });
    const data = response as { data?: Array<{ embedding?: number[] }> };
    return data.data?.[0]?.embedding ?? null;
  }

  async respond(input: {
    prompt: string;
    context: ContactContext;
    recentMessages: ChatMessage[];
    userMessage: string;
    knowledge: KnowledgeHit[];
    tools: AgentToolExecutor;
  }): Promise<string> {
    if (!this.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada");
    const contextText = JSON.stringify({
      contact: input.context,
      recentMessages: input.recentMessages.map((message) => ({
        direction: message.direction,
        content: message.content,
        timestamp: message.timestamp.toISOString(),
      })),
      retrievedKnowledge: input.knowledge,
    });
    const items: ResponseOutputItem[] = [{
      role: "user",
      content: [{ type: "input_text", text: `CONTEXTO ESTRUTURADO\n${contextText}\n\nMENSAGEM ATUAL\n${input.userMessage}` }],
    }];

    for (let round = 0; round < 6; round += 1) {
      const response = (await this.post("/responses", {
        model: this.env.AI_MODEL,
        instructions: input.prompt,
        input: items,
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
        parallel_tool_calls: false,
        store: false,
        include: ["reasoning.encrypted_content"],
        max_output_tokens: 600,
      })) as OpenAIResponse;
      const output = response.output ?? [];
      const calls = output.filter((item) => item.type === "function_call");
      items.push(...output);
      if (!calls.length) {
        const text = response.output_text ?? extractOutputText(output);
        if (!text) throw new Error(`Resposta OpenAI sem texto: ${JSON.stringify(response.error ?? response)}`);
        return text.trim();
      }
      for (const call of calls) {
        if (!call.call_id) throw new Error("Tool call sem call_id");
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(call.arguments ?? "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        const result = await input.tools.execute({ name: call.name ?? "", arguments: args });
        items.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result) });
      }
    }
    throw new Error("Limite de rodadas de tools excedido");
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const response = await this.request(`${this.env.OPENAI_BASE_URL.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.env.OPENAI_API_KEY}` },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`OpenAI API respondeu ${response.status}: ${JSON.stringify(result)}`);
    return result;
  }
}

function extractOutputText(output: ResponseOutputItem[]): string {
  return output
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part): part is Record<string, unknown> => Boolean(part && typeof part === "object"))
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
}

const TOOL_DEFINITIONS = [
  tool("consultar_base", "Recupera trechos oficiais relevantes para a pergunta atual.", {
    query: { type: "string" },
  }, ["query"]),
  tool("taguear", "Aplica uma tag cadastrada ao contato.", {
    tag: { type: "string", enum: [...ALLOWED_TAGS] },
  }, ["tag"]),
  tool("mover_card", "Move o lead para uma etapa válida do pipeline.", {
    etapa: { type: "string", enum: [...PIPELINE_STAGES] }, reason: { type: "string" },
  }, ["etapa", "reason"]),
  tool("atualizar_contato", "Registra somente dados informados pelo contato.", {
    name: { type: ["string", "null"] }, email: { type: ["string", "null"] }, city: { type: ["string", "null"] },
    state: { type: ["string", "null"] }, cpf: { type: ["string", "null"] }, companyName: { type: ["string", "null"] },
    profession: { type: ["string", "null"] }, source: { type: ["string", "null"] }, area: { type: ["string", "null"] },
    interest: { type: ["string", "null"] }, service: { type: ["string", "null"] }, course: { type: ["string", "null"] },
    objective: { type: ["string", "null"] },
  }, ["name", "email", "city", "state", "cpf", "companyName", "profession", "source", "area", "interest", "service", "course", "objective"]),
  tool("handoff_humano", "Pausa a IA e encaminha a conversa para a equipe.", {
    motivo: { type: "string" }, resumo: { type: "string" },
  }, ["motivo", "resumo"]),
  tool("registrar_observacao", "Registra uma observação útil no lead.", {
    observacao: { type: "string" },
  }, ["observacao"]),
];

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): unknown {
  return { type: "function", name, description, parameters: { type: "object", properties, required, additionalProperties: false }, strict: true };
}
