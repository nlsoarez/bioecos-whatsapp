import type { Env } from "../config/env.js";
import { ALLOWED_TAGS } from "../domain/constants.js";
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

export type OpenAIHealthState = "not_configured" | "not_tested" | "operational" | "insufficient_quota" | "invalid_key" | "rate_limited" | "unavailable";

export interface OpenAIHealthStatus {
  state: OpenAIHealthState;
  checkedAt: string | null;
  message: string;
}

export class OpenAIResponsesClient implements AgentClient {
  private healthStatus: OpenAIHealthStatus = {
    state: "not_tested",
    checkedAt: null,
    message: "Crédito ainda não testado",
  };

  constructor(
    private readonly env: Env,
    private readonly request: typeof fetch = fetch,
    private readonly apiKeyProvider: () => Promise<string | null> = async () => env.OPENAI_API_KEY || null,
  ) {}

  async embed(text: string): Promise<number[] | null> {
    const apiKey = await this.apiKeyProvider();
    if (!apiKey) return null;
    const response = await this.post("/embeddings", { model: this.env.AI_EMBEDDING_MODEL, input: text }, apiKey);
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
    const apiKey = await this.apiKeyProvider();
    if (!apiKey) throw new Error("OPENAI_API_KEY não configurada");
    const history = withoutDuplicatedCurrentMessage(input.recentMessages, input.userMessage);
    const lastAssistantMessage = [...history].reverse().find((message) => message.direction === "outbound")?.content ?? null;
    const contextText = JSON.stringify({
      contact: input.context,
      conversationState: {
        selectedCourse: input.context.course,
        objective: input.context.objective,
        lastAssistantMessage,
      },
      recentMessages: history.map((message) => ({
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
        temperature: 0.2,
      }, apiKey)) as OpenAIResponse;
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

  async validateApiKey(apiKey: string): Promise<void> {
    const response = await this.request(`${this.env.OPENAI_BASE_URL.replace(/\/$/, "")}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(response.status === 401 ? "Chave OpenAI inválida" : `Não foi possível validar a chave OpenAI (${response.status})`);
    this.healthStatus = { state: "not_tested", checkedAt: null, message: "Chave válida; crédito ainda não testado" };
  }

  getHealthStatus(): OpenAIHealthStatus {
    return { ...this.healthStatus };
  }

  async testCredit(): Promise<OpenAIHealthStatus> {
    const apiKey = await this.apiKeyProvider();
    if (!apiKey) {
      this.healthStatus = health("not_configured", "Chave OpenAI não configurada");
      return this.getHealthStatus();
    }
    const response = await this.request(`${this.env.OPENAI_BASE_URL.replace(/\/$/, "")}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: this.env.AI_MODEL,
        input: "Responda apenas OK.",
        max_output_tokens: 32,
        store: false,
      }),
    }).catch(() => null);
    if (!response) {
      this.healthStatus = health("unavailable", "OpenAI indisponível ou sem conexão");
      return this.getHealthStatus();
    }
    const result = await response.json().catch(() => ({}));
    this.healthStatus = response.ok
      ? health("operational", "Crédito disponível e chave operacional")
      : classifyOpenAIError(response.status, result);
    return this.getHealthStatus();
  }

  private async post(path: string, body: unknown, apiKey: string): Promise<unknown> {
    const response = await this.request(`${this.env.OPENAI_BASE_URL.replace(/\/$/, "")}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      this.healthStatus = classifyOpenAIError(response.status, result);
      throw new Error(this.healthStatus.message);
    }
    this.healthStatus = health("operational", "Crédito disponível e chave operacional");
    return result;
  }
}

function health(state: OpenAIHealthState, message: string): OpenAIHealthStatus {
  return { state, message, checkedAt: new Date().toISOString() };
}

function classifyOpenAIError(status: number, result: unknown): OpenAIHealthStatus {
  const error = result && typeof result === "object" && "error" in result
    ? (result as { error?: unknown }).error
    : result;
  const details = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const code = String(details.code ?? details.type ?? "").toLowerCase();
  if (status === 401) return health("invalid_key", "Chave OpenAI inválida ou revogada");
  if (status === 429 && (code.includes("insufficient_quota") || code.includes("billing"))) {
    return health("insufficient_quota", "Sem crédito ou limite de gastos atingido");
  }
  if (status === 429) return health("rate_limited", "Limite temporário de requisições atingido");
  if (status === 400) {
    const message = safeOpenAIErrorMessage(details.message);
    return health("unavailable", message ? `Solicitação OpenAI recusada: ${message}` : "Solicitação OpenAI recusada (400)");
  }
  return health("unavailable", `OpenAI indisponível (${status})`);
}

function safeOpenAIErrorMessage(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/sk-[A-Za-z0-9_-]+/g, "[chave protegida]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function extractOutputText(output: ResponseOutputItem[]): string {
  return output
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .filter((part): part is Record<string, unknown> => Boolean(part && typeof part === "object"))
    .filter((part) => part.type === "output_text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("\n");
}

function withoutDuplicatedCurrentMessage(messages: ChatMessage[], currentMessage: string): ChatMessage[] {
  const history = [...messages];
  const last = history.at(-1);
  if (last?.direction === "inbound" && last.content.trim() === currentMessage.trim()) history.pop();
  return history;
}

const TOOL_DEFINITIONS = [
  tool("consultar_base", "Recupera trechos oficiais relevantes para a pergunta atual.", {
    query: { type: "string" },
  }, ["query"]),
  tool("taguear", "Aplica uma tag cadastrada ao contato.", {
    tag: { type: "string", enum: [...ALLOWED_TAGS] },
  }, ["tag"]),
  tool("mover_card", "Move o lead para uma etapa válida do pipeline.", {
    etapa: { type: "string", enum: ["IA atendendo", "Interesse identificado", "Dados em coleta"] }, reason: { type: "string" },
  }, ["etapa", "reason"]),
  tool("atualizar_contato", "Registra somente dados informados pelo contato.", {
    name: { type: ["string", "null"] }, email: { type: ["string", "null"] }, city: { type: ["string", "null"] },
    state: { type: ["string", "null"] }, cpf: { type: ["string", "null"] }, companyName: { type: ["string", "null"] },
    profession: { type: ["string", "null"] }, source: { type: ["string", "null"] }, area: { type: ["string", "null"] },
    interest: { type: ["string", "null"] }, service: { type: ["string", "null"] }, course: { type: ["string", "null"] },
    objective: { type: ["string", "null"] },
  }, ["name", "email", "city", "state", "cpf", "companyName", "profession", "source", "area", "interest", "service", "course", "objective"]),
  tool("registrar_observacao", "Registra uma observação útil no lead.", {
    observacao: { type: "string" },
  }, ["observacao"]),
];

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): unknown {
  return { type: "function", name, description, parameters: { type: "object", properties, required, additionalProperties: false }, strict: true };
}
