// =====================
// TalentumPrescreening — entidades de domínio para o webhook de prescreening do Talentum
//
// Fluxo: App Talentum → POST /api/webhooks/talentum/prescreening → banco
// O Talentum envia POSTs incrementais com o objeto completo acumulado.
// Toda persistência é upsert puro.
// Autenticação: X-Partner-Key (GCP API Key validada via Google API).
// =====================

// ─────────────────────────────────────────────────────────────────
// TalentumQuestion — catálogo deduplicado de perguntas (tabela talentum_questions)
// ─────────────────────────────────────────────────────────────────

export interface TalentumQuestion {
  id: string;
  questionId: string;       // ID da pergunta no sistema Talentum
  question: string;         // Texto da pergunta
  responseType: string;     // Tipo de resposta (ex: TEXT, BOOLEAN, MULTIPLE_CHOICE)
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertTalentumQuestionDTO {
  questionId: string;
  question: string;
  responseType: string;
}

// ─────────────────────────────────────────────────────────────────
// TalentumPrescreening — registro por tentativa worker × vaga (tabela talentum_prescreenings)
// ─────────────────────────────────────────────────────────────────

export type TalentumPrescreeningStatus =
  | 'INITIATED' | 'IN_PROGRESS' | 'COMPLETED' | 'ANALYZED'
  | 'QUALIFIED' | 'NOT_QUALIFIED' | 'IN_DOUBT' | 'PENDING';

export interface TalentumPrescreening {
  id: string;
  talentumPrescreeningId: string;   // ID do prescreening no Talentum — chave de dedup
  talentumProfileId: string;        // ID do perfil no Talentum
  workerId: string | null;          // Nullable: resolvido por lookup, pode ser preenchido em POST posterior
  jobPostingId: string | null;      // Nullable: resolvido por ILIKE em case_name, idem
  jobCaseName: string;              // prescreening.name bruto — preservado para auditoria
  status: TalentumPrescreeningStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type WebhookEnvironment = 'production' | 'test';

export interface UpsertTalentumPrescreeningDTO {
  talentumPrescreeningId: string;
  talentumProfileId: string;
  workerId: string | null;
  jobPostingId: string | null;
  jobCaseName: string;
  status: TalentumPrescreeningStatus;
  environment?: WebhookEnvironment;
  /**
   * `true` quando `jobPostingId` veio da resolução pelo `talentum_prescreening_id` (a vaga DONA do prescreening).
   * Só a dona sobrescreve a vaga já gravada; resolução por título/null nunca (continua COALESCE).
   */
  jobPostingResolvedById?: boolean;
}

export type TalentumDivergenceKind =
  | 'WORKER_NULL'
  | 'WORKER_EMAIL_AMBIGUOUS'
  | 'JOB_POSTING_NULL'
  | 'JOB_POSTING_BY_TITLE_ONLY'
  | 'JOB_POSTING_TITLE_DIFFERS_STORED'
  | 'JOB_POSTING_REPOINTED_TO_OWNER';

export interface InsertTalentumDivergenceDTO {
  kind: TalentumDivergenceKind;
  talentumPrescreeningId: string;
  talentumProfileId: string;
  prescreeningId: string | null;
  workerId: string | null;
  jobPostingId: string | null;
  expectedJobPostingId: string | null;
  environment: WebhookEnvironment;
}

// ─────────────────────────────────────────────────────────────────
// TalentumPrescreeningResponse — respostas (tabela talentum_prescreening_responses)
// ─────────────────────────────────────────────────────────────────

// 'register'      → veio de profile.registerQuestions (perguntas de cadastro do worker)
// 'prescreening'  → veio de response.state (perguntas específicas da vaga)
// A mesma questionId pode aparecer em ambas as fontes com respostas diferentes.
export type TalentumResponseSource = 'register' | 'prescreening';

export interface TalentumPrescreeningResponse {
  id: string;
  prescreeningId: string;         // FK → talentum_prescreenings.id
  questionId: string;             // FK → talentum_questions.id
  answer: string | null;          // null = sem resposta ainda; preenchida em POST posterior
  responseSource: TalentumResponseSource;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertTalentumResponseDTO {
  prescreeningId: string;
  questionId: string;             // UUID interno (talentum_questions.id)
  answer: string | null;
  responseSource: TalentumResponseSource;
}

// ─────────────────────────────────────────────────────────────────
// Payload externo recebido via webhook (re-exportado do validator)
// ─────────────────────────────────────────────────────────────────

// Definição inline para o domínio; o validator Zod em
// src/interfaces/validators/talentumPrescreeningSchema.ts usa este tipo como base.

export interface TalentumQuestionItem {
  questionId: string;
  question: string;
  answer: string;
  responseType: string;
}

export interface TalentumPrescreeningPayload {
  prescreening: {
    id: string;
    name: string;
    status: TalentumPrescreeningStatus;
  };
  profile: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    phoneNumber: string;
    cuil: string;
    registerQuestions: TalentumQuestionItem[];
  };
  response: {
    id: string;
    state: TalentumQuestionItem[];
  };
}
