import type { AllowedTag, PipelineStage } from "../domain/constants.js";
import type { ContactContext, LeadTemperature, QualificationStep } from "../domain/types.js";
import type { ContactUpdate } from "../repositories/bioecos.repository.js";
import { nextQualificationStep, qualificationPrompt } from "./qualification.service.js";

export interface HybridRuleDecision {
  response: string;
  tag?: AllowedTag;
  stage?: PipelineStage;
  stageReason?: string;
  handoffReason?: string;
  updates?: ContactUpdate;
  qualificationStep?: QualificationStep | null;
  temperature?: LeadTemperature;
  enableMonthlyFollowup?: boolean;
}

const HUMAN_CONTINUATION = "Certo. Vou deixar sua conversa com a equipe responsável, que continuará o atendimento por aqui.";

export function matchHybridRule(message: string, context: ContactContext): HybridRuleDecision | null {
  const text = normalize(message);
  const detectedCourse = detectCourse(text);
  const purchaseIntent = /quero (?:fazer|comprar|contratar|me inscrever)|inscri[cç][aã]o|matr[ií]cula|como (?:fa[cç]o para )?(?:entrar|participar)|fechar/.test(text);

  if (/^(oi|ola|bom dia|boa tarde|boa noite|menu|inicio)[!.?\s]*$/.test(text)) {
    return {
      response: "Olá! Sou Débora, assistente virtual da Bioecos. Posso ajudar com cursos e formações, paisagismo, práticas integrativas, consultoria, licenciamento ou gestão ambiental. Sobre qual assunto você quer falar?",
    };
  }

  if (/quem (e|esta falando|responde)|seu nome|voce e (humana|robo|ia)/.test(text)) {
    return { response: "Sou Débora, assistente virtual da Bioecos — Centro Integrado de Desenvolvimento Sustentável." };
  }

  if (/site|pagina oficial|endereco do site|link/.test(text)) {
    return { response: "O site oficial da Bioecos é https://www.bioecoscursos.com.br/." };
  }

  if (/preco|valor|quanto custa|investimento|proxima turma|calendario|vaga|disponibilidade|desconto|promocao|pix|boleto|pagamento/.test(text)) {
    return {
      response: `O valor precisa ser confirmado pela equipe, e a turma, vaga ou condição atual também precisa ser confirmada. ${HUMAN_CONTINUATION}`,
      handoffReason: "Preço, turma, vaga ou condição comercial exige confirmação humana",
      ...(detectedCourse ? { updates: { area: "Cursos", interest: detectedCourse, course: detectedCourse } } : {}),
      temperature: "hot",
      enableMonthlyFollowup: Boolean(detectedCourse),
    };
  }

  if (/orcamento|proposta comercial/.test(text)) {
    return {
      response: context.companyName
        ? "Para preparar o atendimento, qual é a cidade e qual serviço ou necessidade da empresa?"
        : "Para começar o orçamento, qual é o nome da empresa ou condomínio?",
      tag: "orcamento",
      stage: "Dados em coleta",
      stageReason: "Contato solicitou orçamento; qualificação iniciada",
    };
  }

  if (/\bctf\b/.test(text)) {
    return {
      response: "A Bioecos realiza cadastro, atualização e regularização de CTF. A necessidade depende da atividade da empresa e exige avaliação técnica. Qual é a atividade exercida?",
      tag: "licenciamento-ambiental",
      stage: "Interesse identificado",
      stageReason: "Interesse em regularização ambiental identificado",
    };
  }

  if (/\brapp\b/.test(text)) {
    return {
      response: "Sim. A Bioecos elabora e envia o RAPP. Para avaliar o caso, precisamos conhecer a empresa, a atividade e a situação atual do cadastro.",
      tag: "licenciamento-ambiental",
      stage: "Interesse identificado",
      stageReason: "Interesse em RAPP identificado",
    };
  }

  if (/\bpgrss?\b|gestao de residuos|residuos/.test(text)) {
    return {
      response: "A Bioecos orienta a gestão de resíduos e elabora PGRS e PGRSS. O escopo depende da atividade, do porte e dos resíduos gerados. Qual é o tipo de empresa ou instituição?",
      tag: "gestao-ambiental",
      stage: "Interesse identificado",
      stageReason: "Interesse em gestão de resíduos identificado",
    };
  }

  if (/renovar|renovacao/.test(text) && /licenca|licenciamento/.test(text)) {
    return {
      response: "A Bioecos acompanha a renovação de licenças e a organização das condicionantes. Qual é a atividade da empresa e qual licença precisa ser renovada?",
      tag: "licenciamento-ambiental",
      stage: "Interesse identificado",
      stageReason: "Interesse em renovação de licença identificado",
    };
  }

  if (/licenciamento|licenca ambiental|regularizacao ambiental/.test(text)) {
    return {
      response: "A Bioecos atua com licenciamento, renovação, regularização e organização documental. Prazo e documentos variam conforme atividade, porte e órgão ambiental. Qual é a atividade e a cidade da empresa?",
      tag: "licenciamento-ambiental",
      stage: "Interesse identificado",
      stageReason: "Interesse em licenciamento ambiental identificado",
    };
  }

  if (/consultoria ambiental|sustentabilidade empresarial|condominio/.test(text)) {
    return {
      response: "A consultoria ambiental atende empresas, condomínios e instituições, com diagnóstico, conformidade, resíduos, licenças e sustentabilidade. Qual é a organização, a cidade e a principal necessidade?",
      tag: "consultoria-ambiental",
      stage: "Interesse identificado",
      stageReason: "Interesse em consultoria ambiental identificado",
    };
  }

  if (/gestao ambiental|condicionantes|acompanhamento ambiental/.test(text)) {
    return {
      response: "A gestão ambiental pode incluir diagnóstico, controle de obrigações, licenças, condicionantes, resíduos e acompanhamento técnico. Qual é o tipo e o porte da organização?",
      tag: "gestao-ambiental",
      stage: "Interesse identificado",
      stageReason: "Interesse em gestão ambiental identificado",
    };
  }

  if (/aromaterapia|fitoterapia|florais|plantas medicinais|cosmetica natural|curso livre/.test(text)) {
    const decision: HybridRuleDecision = {
      response: "Os cursos livres incluem Plantas Medicinais, Fitoterapia, Aromaterapia, Florais de Bach e Cosmética Natural. São on-line, com aulas gravadas, acesso vitalício pela Hotmart e certificado após a conclusão das atividades. Não exigem experiência prévia. Qual curso interessa mais?",
      tag: "curso-livre",
      stage: "Interesse identificado",
      stageReason: "Interesse em curso livre identificado",
    };
    return detectedCourse ? qualifyCourse({
      ...decision,
      response: `Sim. ${detectedCourse} é um curso livre on-line, com aulas gravadas, acesso vitalício pela Hotmart e certificado após a conclusão das atividades. Não exige experiência prévia.`,
    }, detectedCourse, context, purchaseIntent) : decision;
  }

  if (/paisagismo|jardinagem/.test(text)) {
    return qualifyCourse({
      response: "A Imersão em Paisagismo e Jardinagem é presencial, de sexta a domingo, na Chácara Vale do Sol, em Maricá/Ponta Negra. Inclui teoria, prática, alimentação, material, certificado e opções com ou sem hospedagem. Não exige experiência prévia.",
      tag: "imersao-paisagismo",
      stage: "Interesse identificado",
      stageReason: "Interesse na Imersão em Paisagismo identificado",
    }, "Imersão em Paisagismo e Jardinagem", context, purchaseIntent);
  }

  if (/praticas integrativas|auriculoterapia|neurociencia/.test(text)) {
    return qualifyCourse({
      response: "A Atualização em Práticas Integrativas é uma imersão presencial de sexta a domingo, com 21 horas e certificado. Inclui atividades práticas e temas como plantas medicinais, fitoterapia, aromaterapia, florais, auriculoterapia e neurociência.",
      tag: "praticas-integrativas",
      stage: "Interesse identificado",
      stageReason: "Interesse em Práticas Integrativas identificado",
    }, "Atualização em Práticas Integrativas", context, purchaseIntent);
  }

  if (/terapeuta holistico|terapeutas holisticos|formacao de terapeuta/.test(text)) {
    return qualifyCourse({
      response: "A Formação de Terapeutas Holísticos tem mais de 160 aulas gravadas, acesso vitalício, consultas terapêuticas, aulas ao vivo e acompanhamento por seis meses. Não exige formação prévia; o certificado não equivale a registro profissional automático.",
      tag: "formacao-terapeuta",
      stage: "Interesse identificado",
      stageReason: "Interesse na Formação de Terapeutas identificado",
    }, "Formação de Terapeutas Holísticos", context, purchaseIntent);
  }

  if (/assinatura|bioecos integral/.test(text)) {
    return qualifyCourse({
      response: "A Assinatura Bioecos Integral é um programa mensal com cursos livres, e-books, palestras, materiais complementares e atualizações. O valor vigente precisa ser confirmado pela equipe antes da contratação.",
      tag: "assinatura-integral",
      stage: "Interesse identificado",
      stageReason: "Interesse na Assinatura Bioecos Integral identificado",
    }, "Assinatura Bioecos Integral", context, purchaseIntent);
  }

  if (/certificado/.test(text)) {
    return { response: "Os cursos e imersões documentados emitem certificado após o cumprimento das atividades. A carga horária e as condições específicas dependem do programa. Qual curso você está avaliando?" };
  }

  if (/hospedagem|alimentacao|cafe da manha|almoco|lanche/.test(text)) {
    return { response: "Nas imersões presenciais há opções com e sem hospedagem. Os pacotes documentados incluem café da manhã, almoço e lanche, mas a condição da próxima turma precisa ser confirmada pela equipe." };
  }

  return null;
}

function qualifyCourse(
  decision: HybridRuleDecision,
  course: string,
  context: ContactContext,
  purchaseIntent: boolean,
): HybridRuleDecision {
  const updates: ContactUpdate = { area: "Cursos", interest: course, course };
  const step = nextQualificationStep(context, updates);
  return {
    ...decision,
    response: step ? `${decision.response}\n\n${qualificationPrompt(step)}` : decision.response,
    updates,
    qualificationStep: step,
    temperature: purchaseIntent ? "hot" : "warm",
    enableMonthlyFollowup: purchaseIntent,
  };
}

function detectCourse(text: string): string | null {
  if (/aromaterapia/.test(text)) return "Aromaterapia";
  if (/fitoterapia/.test(text)) return "Fitoterapia";
  if (/florais|bach/.test(text)) return "Florais de Bach";
  if (/plantas medicinais/.test(text)) return "Plantas Medicinais";
  if (/cosmetica natural/.test(text)) return "Cosmética Natural";
  if (/paisagismo|jardinagem/.test(text)) return "Imersão em Paisagismo e Jardinagem";
  if (/praticas integrativas|auriculoterapia|neurociencia/.test(text)) return "Atualização em Práticas Integrativas";
  if (/terapeuta holistico|formacao de terapeuta/.test(text)) return "Formação de Terapeutas Holísticos";
  if (/assinatura|bioecos integral/.test(text)) return "Assinatura Bioecos Integral";
  return null;
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}
