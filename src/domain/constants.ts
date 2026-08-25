export const PIPELINE_STAGES = [
  "Novo contato",
  "Interesse identificado",
  "Dados em coleta",
  "Aguardando especialista",
  "Inscrição ou proposta",
  "Convertido",
  "Encerrado",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const ALLOWED_TAGS = [
  "bioecos-integral",
  "bioecos-sustentavel",
  "curso-livre",
  "imersao-paisagismo",
  "praticas-integrativas",
  "formacao-terapeuta",
  "assinatura-integral",
  "consultoria-ambiental",
  "licenciamento-ambiental",
  "gestao-ambiental",
  "orcamento",
  "inscricao",
  "falar-com-especialista",
] as const;

export type AllowedTag = (typeof ALLOWED_TAGS)[number];

export const VARIABLE_INFORMATION_PATTERN =
  /curso|forma[cç][aã]o|imers[aã]o|aromaterapia|fitoterapia|florais|cosm[eé]tica|plantas medicinais|pre[cç]o|valor|quanto custa|investimento|pr[oó]xima turma|calend[aá]rio|vaga|disponibilidade|desconto|promo[cç][aã]o|prazo|certificado|documentos?|hospedagem|alimenta[cç][aã]o|ctf|rapp|pgrs|pgrss|licen[cç]a/i;

export const HUMAN_REQUEST_PATTERN =
  /falar com (?:um |uma )?(?:humano|pessoa|atendente|consultor|especialista)|quero (?:um |uma )?(?:consultor|especialista|atendente)|reclama[cç][aã]o|cancelamento|urgente|urg[eê]ncia/i;

export const BUDGET_PATTERN = /or[cç]amento|proposta comercial/i;
