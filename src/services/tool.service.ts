import { z } from "zod";
import { ALLOWED_TAGS, PIPELINE_STAGES } from "../domain/constants.js";
import type { ContactContext } from "../domain/types.js";
import type { BioecosRepository, ContactUpdate } from "../repositories/bioecos.repository.js";
import type { AgentClient, AgentToolCall, AgentToolExecutor } from "./openai.service.js";

export class ToolService implements AgentToolExecutor {
  constructor(
    private readonly repository: BioecosRepository,
    private readonly agent: AgentClient,
    private context: ContactContext,
  ) {}

  async execute(call: AgentToolCall): Promise<unknown> {
    try {
      const result = await this.executeValidated(call);
      this.context = await this.repository.getContext(this.context.conversationId);
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async executeValidated(call: AgentToolCall): Promise<unknown> {
    switch (call.name) {
      case "consultar_base": {
        const { query } = z.object({ query: z.string().min(2).max(500) }).parse(call.arguments);
        const embedding = await this.agent.embed(query).catch(() => null);
        return this.repository.searchKnowledge(query, embedding, 4);
      }
      case "taguear": {
        const { tag } = z.object({ tag: z.enum(ALLOWED_TAGS) }).parse(call.arguments);
        await this.repository.addTag(this.context, tag);
        return { tag };
      }
      case "mover_card": {
        const values = z.object({ etapa: z.enum(PIPELINE_STAGES), reason: z.string().min(3).max(500) }).parse(call.arguments);
        await this.repository.moveCard(this.context, values.etapa, values.reason);
        return values;
      }
      case "atualizar_contato": {
        const nullable = z.string().trim().min(1).max(300).nullable();
        const values = z.object({
          name: nullable, email: nullable, city: nullable, state: nullable, cpf: nullable,
          companyName: nullable, profession: nullable, source: nullable, area: nullable,
          interest: nullable, service: nullable, course: nullable, objective: nullable,
        }).parse(call.arguments);
        const clean = Object.fromEntries(Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null)) as ContactUpdate;
        await this.repository.updateContact(this.context, clean);
        return { fields: Object.keys(clean) };
      }
      case "registrar_observacao": {
        const { observacao } = z.object({ observacao: z.string().min(2).max(2_000) }).parse(call.arguments);
        await this.repository.addNote(this.context, observacao);
        return { saved: true };
      }
      case "handoff_humano": {
        const values = z.object({ motivo: z.string().min(2).max(500), resumo: z.string().min(2).max(2_000) }).parse(call.arguments);
        await this.repository.handoff(this.context, values.motivo, values.resumo);
        return { paused: true };
      }
      default:
        throw new Error(`Tool desconhecida: ${call.name}`);
    }
  }
}

