import type { ContactContext, QualificationStep } from "../domain/types.js";
import type { ContactUpdate } from "../repositories/bioecos.repository.js";

export const FOLLOWUP_OPT_OUT_PATTERN = /^\s*(sair|pare|parar|cancelar mensagens|n[aã]o quero mais(?: mensagens)?|remover meu contato)\s*[!.]?\s*$/i;

export interface QualificationDecision {
  response: string;
  updates?: ContactUpdate;
  nextStep: QualificationStep | null;
}

export function nextQualificationStep(context: ContactContext, updates: ContactUpdate = {}): QualificationStep | null {
  if (!(updates.name ?? context.name)?.trim()) return "name";
  if (!(updates.email ?? context.email)?.trim()) return "email";
  if (!(updates.city ?? context.city)?.trim()) return "city";
  if (!(updates.objective ?? context.objective)?.trim()) return "objective";
  return null;
}

export function qualificationPrompt(step: QualificationStep | null): string {
  switch (step) {
    case "name": return "Para registrar seu interesse, qual é o seu nome?";
    case "email": return "Qual é o seu melhor e-mail? Se preferir não informar, responda PULAR.";
    case "city": return "Em qual cidade e estado você mora?";
    case "objective": return "Por fim, qual é o seu principal objetivo com esse curso?";
    default: return "Dados registrados. A equipe poderá continuar o atendimento por este WhatsApp.";
  }
}

export function handleQualificationReply(message: string, context: ContactContext): QualificationDecision | null {
  const step = context.qualificationStep;
  if (!step) return null;
  const value = message.trim();

  if (step === "name") {
    if (value.length < 2 || value.length > 100 || /\?|@|https?:\/\//i.test(value)) return null;
    return advance("email", { name: value });
  }

  if (step === "email") {
    if (/^(pular|prefiro n[aã]o informar|n[aã]o tenho)$/i.test(value)) return advance("city");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return { response: "Esse e-mail parece incompleto. Envie no formato nome@exemplo.com ou responda PULAR.", nextStep: "email" };
    }
    return advance("city", { email: value.toLowerCase() });
  }

  if (step === "city") {
    if (value.length < 2 || value.length > 120 || /\?|@|https?:\/\//i.test(value)) return null;
    const match = value.match(/^(.+?)(?:\s*[-/,]\s*|\s+)([A-Za-z]{2})$/);
    return advance("objective", match ? { city: match[1]!.trim(), state: match[2]!.toUpperCase() } : { city: value });
  }

  if (value.length < 3 || value.length > 500) return null;
  return advance(null, { objective: value });
}

function advance(nextStep: QualificationStep | null, updates: ContactUpdate = {}): QualificationDecision {
  const prefix = nextStep ? "Obrigado. " : "Pronto. ";
  return {
    response: `${prefix}${qualificationPrompt(nextStep)}`,
    ...(Object.keys(updates).length ? { updates } : {}),
    nextStep,
  };
}
