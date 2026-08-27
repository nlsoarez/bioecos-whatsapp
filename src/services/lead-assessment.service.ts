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

const HOT_PATTERN = /\b(quero (?:me )?(?:matricular|inscrever)|quero fechar|quero (?:um )?or[cç]amento|quero (?:uma )?proposta|como (?:fa[cç]o|fazer) (?:a )?(?:matr[ií]cula|inscri[cç][aã]o)|como (?:fa[cç]o|fazer) para pagar|onde (?:eu )?pago|quero pagar|pix|boleto|cart[aã]o|link de pagamento|quando (?:posso|consigo) come[cç]ar|tem vaga|ainda h[aá] vaga|garantir (?:a )?vaga|falar com (?:a |o )?coordenador|pode (?:me )?inscrever)\b/i;
const HUMAN_PATTERN = /\b(falar com (?:um |uma |a |o )?(?:humano|pessoa|atendente|coordenador|consultor|especialista)|atendimento humano)\b/i;
const NOT_INTERESTED_PATTERN = /\b(n[aã]o tenho interesse|n[aã]o quero|desisti|pode encerrar|pare de mandar|n[aã]o me chame|remova meu contato)\b/i;

export function assessLead(currentMessage: string, recentMessages: ChatMessage[], context: ContactContext): LeadAssessment {
  const inbound = recentMessages.filter((item) => item.direction === "inbound").map((item) => item.content);
  const transcript = [...inbound, currentMessage].slice(-12).join("\n");
  const course = COURSE_PATTERNS.find(([pattern]) => pattern.test(transcript))?.[1] ?? context.course;
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
  const followupConfirmation = context.followupEnabled && /^\s*(sim|quero continuar|tenho interesse)\s*[!.]?\s*$/i.test(currentMessage);
  const closingIntent = HOT_PATTERN.test(transcript) || followupConfirmation;
  const shouldHandoff = !notInterested && (humanRequested || closingIntent);
  const temperature = shouldHandoff ? "hot"
    : course || mainQuestions.length || objections.length ? "warm"
      : "cold";
  const handoffReason = humanRequested ? "Solicitação direta de atendimento humano ou coordenador"
    : closingIntent ? "Intenção clara de matrícula, pagamento ou fechamento" : null;

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
