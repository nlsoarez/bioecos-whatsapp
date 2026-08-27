import type { ChatMessage, ContactContext, LeadAssessment } from "../domain/types.js";

const COURSE_PATTERNS: Array<[RegExp, string]> = [
  [/aromaterapia/i, "Aromaterapia"],
  [/fitoterapia/i, "Fitoterapia"],
  [/plantas? medicinais/i, "Plantas Medicinais"],
  [/florais?(?: de bach)?/i, "Florais de Bach"],
  [/cosm[eé]tica|bem[- ]estar|sa[uú]de/i, "Cosmética, bem-estar e saúde"],
  [/paisagismo|jardinagem/i, "Imersão em Paisagismo e Jardinagem"],
  [/pr[aá]ticas integrativas/i, "Atualização em Práticas Integrativas"],
  [/terapeutas? hol[ií]sticos?|forma[cç][aã]o de terapeut/i, "Formação de Terapeutas Holísticos"],
  [/consultoria ambiental/i, "Consultoria Ambiental"],
  [/licenciamento ambiental|\bctf\b|\brapp\b/i, "Licenciamento Ambiental"],
  [/gest[aã]o ambiental|\bpgrs\b|\bpgrss\b|res[ií]duos/i, "Gestão Ambiental"],
];

const ENROLLMENT_INTENT_PATTERN = /\b(quero (?:me )?(?:matricular|inscrever)|como (?:fa[cç]o|fazer) (?:a )?(?:matr[ií]cula|inscri[cç][aã]o)|quando (?:posso|consigo) come[cç]ar|tem vaga|ainda h[aá] vaga|garantir (?:a )?vaga|pode (?:me )?inscrever)\b/i;
const PAYMENT_OR_COMMERCIAL_PATTERN = /\b(quero fechar|quero (?:um )?or[cç]amento|quero (?:uma )?proposta|como (?:fa[cç]o|fazer) para pagar|onde (?:eu )?pago|quero pagar|pix|boleto|cart[aã]o|link de pagamento|parcelar|parcelamento|negociar|negocia[cç][aã]o|condi[cç][aã]o de pagamento|desconto)\b/i;
const HUMAN_PATTERN = /\b(falar com (?:um |uma |a |o )?(?:humano|pessoa|atendente|coordenador|consultor|especialista)|atendimento humano)\b/i;
const NOT_INTERESTED_PATTERN = /\b(n[aã]o tenho interesse|n[aã]o quero|desisti|pode encerrar|pare de mandar|n[aã]o me chame|remova meu contato)\b/i;
const FOLLOWUP_MESSAGE_PATTERN = /retomando nossa conversa|seu interesse continua|alguma quest[aã]o est[aá] impedindo/i;

export function assessLead(currentMessage: string, recentMessages: ChatMessage[], context: ContactContext): LeadAssessment {
  const inbound = recentMessages.filter((item) => item.direction === "inbound").map((item) => item.content);
  const inboundTurns = [...inbound, currentMessage].slice(-12);
  const transcript = inboundTurns.join("\n");
  const course = [...inboundTurns].reverse().map(detectCourse).find((value): value is string => Boolean(value)) ?? context.course;
  const mainQuestions = unique([...inbound, currentMessage]
    .filter((text) => /\?|\b(como|quando|quanto|qual|quais|onde|tem|voc[eê]s|posso|precisa|funciona|dura)\b/i.test(text))
    .map((text) => text.trim())
    .filter(Boolean)
    .slice(-8));
  const objections = unique([
    /caro|pre[cç]o|valor|quanto custa|investimento/i.test(transcript) ? "preço/investimento" : "",
    /sem tempo|pouco tempo|falta de tempo|hor[aá]rio|rotina/i.test(transcript) ? "tempo/disponibilidade" : "",
    /formato|modalidade|online|presencial|ead|dist[aâ]ncia/i.test(transcript) ? "formato/modalidade" : "",
    /n[aã]o sei se|tenho d[uú]vida se|ser[aá] que|medo/i.test(transcript) ? "segurança na decisão" : "",
  ].filter(Boolean));
  const notInterested = NOT_INTERESTED_PATTERN.test(currentMessage);
  const humanRequested = HUMAN_PATTERN.test(currentMessage);
  const lastOutbound = [...recentMessages].reverse().find((item) => item.direction === "outbound")?.content ?? "";
  const followupConfirmation = context.followupEnabled && FOLLOWUP_MESSAGE_PATTERN.test(lastOutbound)
    && /^\s*(sim|quero continuar|tenho interesse)\s*[!.]?\s*$/i.test(currentMessage);
  const enrollmentIntent = ENROLLMENT_INTENT_PATTERN.test(transcript) || followupConfirmation;
  const paymentOrCommercialIntent = PAYMENT_OR_COMMERCIAL_PATTERN.test(currentMessage);
  const shouldHandoff = !notInterested && (humanRequested || paymentOrCommercialIntent);
  const temperature = shouldHandoff || enrollmentIntent ? "hot"
    : course || mainQuestions.length || objections.length ? "warm"
      : "cold";
  const handoffReason = humanRequested ? "Solicitação direta de atendimento humano ou coordenador"
    : paymentOrCommercialIntent ? "Pagamento, negociação financeira, orçamento ou proposta" : null;

  return {
    temperature,
    reason: notInterested ? "Contato declarou não ter interesse"
      : handoffReason ?? (temperature === "warm" ? "Interesse ou dúvida específica identificada no contexto" : "Contato ainda em descoberta"),
    mainQuestions,
    objections,
    course,
    interest: course ?? context.interest,
    shouldHandoff,
    handoffReason,
    notInterested,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function detectCourse(message: string): string | null {
  return COURSE_PATTERNS.find(([pattern]) => pattern.test(message))?.[1] ?? null;
}
