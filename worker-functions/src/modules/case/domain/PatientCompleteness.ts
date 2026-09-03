/**
 * PatientCompleteness — critério único de "pronto para ativar" (spec 014, US-D1, SUP-D1).
 *
 * Lex D1.1/D1.2 (specs/013-admissao-c-servicio-contratado/lex-veredito.md): os códigos do
 * checklist vivem SÓ aqui (constante única, sem item clínico) e a MESMA função alimenta:
 *   - `GET /api/admin/patients/:id` → `completeness: { missing, ready }` (só no detalhe — a
 *     lista/kanban continuam com o booleano `needsAttention` + enum fechado `attentionReasons`).
 *   - `ActivatePatientUseCase` → a MESMA regra decide se `POST /activate` aceita ou rejeita
 *     (422 com os códigos que faltam), para o checklist nunca divergir do gate real.
 *
 * SUP-D1: se o critério abaixo estiver errado, a LISTA de códigos muda — a mecânica (função
 * única lida pelos dois lados) não.
 */

export const PATIENT_COMPLETENESS_CODES = [
  'ADDRESS',
  'RESPONSIBLE',
  'COVERAGE',
  'CONTRACTED_SERVICE',
  'CONSENT',
] as const;

export type PatientCompletenessCode = (typeof PATIENT_COMPLETENESS_CODES)[number];

/**
 * QA-caça rodada 1 / decisão do Gabriel 03/09 (D255): dos 5 códigos de
 * `PATIENT_COMPLETENESS_CODES`, só ADDRESS BLOQUEIA `POST /activate`. Medido na réplica de
 * produção (D165, só contagens): 370 pacientes vivos, apenas 23 com `has_consent=true` —
 * bloquear por CONSENT/RESPONSIBLE/COVERAGE travaria quase toda a operação hoje. Fonte ÚNICA:
 * `ActivatePatientUseCase` e `computePatientCompleteness` leem esta constante — nenhum dos dois
 * reimplementa "quais códigos bloqueiam".
 */
export const ACTIVATION_BLOCKING_CODES = ['ADDRESS'] as const;

/**
 * Status do paciente em que o checklist/botão "Activar paciente" fazem sentido. Fora daqui
 * (ex.: ACTIVE, SOLICITANTE, DISCONTINUED) o paciente já foi ativado ou ainda não chegou à
 * admissão — mostrar o checklist é ruído sem ação possível (QA-caça 🟡3).
 */
export const ACTIVATABLE_STATUSES = ['ADMISSION', 'PENDING_ADMISSION'] as const;

export interface PatientCompletenessInput {
  /** Data de nascimento do paciente (ISO ou Date) — usada só para decidir se RESPONSIBLE é exigido. */
  birthDate: string | Date | null;
  hasConsent: boolean | null;
  /** `insuranceInformed` (ou `health_insurance_name`) — string vazia conta como ausente. */
  insuranceInformed: string | null;
  activeAddressCount: number;
  activeResponsibleCount: number;
  activeContractedServiceCount: number;
  /** Data de referência para o cálculo de idade — injetável nos testes; default `new Date()`. */
  now?: Date;
}

export interface PatientCompletenessResult {
  missing: PatientCompletenessCode[];
  /** missing ∩ ACTIVATION_BLOCKING_CODES (D255) — os códigos que REALMENTE bloqueiam o activate. */
  blocking: PatientCompletenessCode[];
  ready: boolean;
  /** blocking.length === 0 — o gate real de `POST /activate` lê ISTO, nunca `missing`/`ready`. */
  canActivate: boolean;
}

const MINOR_AGE_YEARS = 18;

/**
 * true quando `birthDate` representa alguém com MENOS de 18 anos na data `now`.
 * `birthDate` ausente/ inválida → false (não bloqueia por um dado que a própria ficha
 * já cobra por outro caminho — a idade não é o objeto desta spec).
 */
export function isMinor(birthDate: string | Date | null, now: Date = new Date()): boolean {
  if (birthDate == null) return false;
  const dob = birthDate instanceof Date ? birthDate : new Date(birthDate);
  if (Number.isNaN(dob.getTime())) return false;

  // UTC em ambos os lados, de propósito: `birthDate` chega como data-only ('YYYY-MM-DD',
  // coluna `date` do Postgres) — o parser do JS lê data-only como MEIA-NOITE UTC. Comparar
  // com getters LOCAIS (getMonth/getDate) desalinha perto da virada do dia em qualquer fuso
  // que não seja UTC (medido: America/Argentina/Buenos_Aires, UTC-3, dava "18 anos" um dia
  // antes do aniversário real). UTC nos dois lados elimina o fuso da conta.
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) {
    age -= 1;
  }
  return age < MINOR_AGE_YEARS;
}

/**
 * Calcula o checklist de completude — critério ÚNICO (SUP-D1) lido tanto pelo detalhe da
 * ficha quanto pelo gate de `POST /activate`.
 */
export function computePatientCompleteness(
  input: PatientCompletenessInput,
): PatientCompletenessResult {
  const missing: PatientCompletenessCode[] = [];

  if (input.activeAddressCount < 1) {
    missing.push('ADDRESS');
  }
  if (isMinor(input.birthDate, input.now) && input.activeResponsibleCount < 1) {
    missing.push('RESPONSIBLE');
  }
  if (!input.insuranceInformed || input.insuranceInformed.trim().length === 0) {
    missing.push('COVERAGE');
  }
  if (input.activeContractedServiceCount < 1) {
    missing.push('CONTRACTED_SERVICE');
  }
  if (!input.hasConsent) {
    missing.push('CONSENT');
  }

  const blocking = missing.filter((code) =>
    (ACTIVATION_BLOCKING_CODES as readonly PatientCompletenessCode[]).includes(code),
  );

  return { missing, blocking, ready: missing.length === 0, canActivate: blocking.length === 0 };
}
