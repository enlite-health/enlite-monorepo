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

// ── A MESMA regra, em SQL — para o FILTRO e os CONTADORES da listagem ────────────────────────
//
// Por que existe: `needsAttention`/`attentionReasons` são DERIVADOS a cada leitura (nunca gravados
// em `patients.needs_attention`/`attention_reasons`, que seguem só com os motivos legados). O
// filtro, o `total_count` e os contadores de `stats()` rodam no BANCO, antes de qualquer linha
// chegar ao JS — se eles lerem a coluna guardada, discordam do badge que a própria lista mostra
// (o paciente aparece marcado e SOME quando a operadora filtra por ele).
//
// A trava contra divergência é de COMPILAÇÃO, não de disciplina: `MISSING_SQL` é um
// `Record<PatientCompletenessCode, …>`, então um código novo em `PATIENT_COMPLETENESS_CODES` NÃO
// COMPILA até ganhar cláusula aqui. E a equivalência cláusula-a-cláusula com
// `computePatientCompleteness` é medida contra Postgres real, linha a linha, em
// `tests/e2e/c1b-patient-list-attention-agreement.e2e.test.ts` (teste diferencial: as duas
// implementações têm de dar o MESMO veredito para a mesma linha).

/** O motivo derivado que a lista publica — nunca gravado em `patients.attention_reasons`. */
export const INCOMPLETE_ADMISSION_REASON = 'INCOMPLETE_ADMISSION';

/** Uma cláusula SQL por código do checklist. `p` é o alias da tabela `patients`. */
const MISSING_SQL: Record<PatientCompletenessCode, (p: string) => string> = {
  // activeAddressCount < 1
  ADDRESS: (p) => `NOT EXISTS (SELECT 1 FROM patient_addresses pa WHERE pa.patient_id = ${p}.id AND pa.archived_at IS NULL)`,
  // isMinor(birthDate) && activeResponsibleCount < 1 — "menos de 18 anos HOJE, em UTC", igual ao
  // `isMinor` acima: quem nasceu exatamente na data de corte já fez 18 e NÃO é menor (`>` estrito).
  RESPONSIBLE: (p) => `(${p}.birth_date IS NOT NULL
        AND ${p}.birth_date > (((NOW() AT TIME ZONE 'UTC')::date - INTERVAL '${MINOR_AGE_YEARS} years')::date)
        AND NOT EXISTS (SELECT 1 FROM patient_responsibles pr WHERE pr.patient_id = ${p}.id))`,
  // !insuranceInformed || trim() === '' — mesmo COALESCE que a listagem projeta.
  COVERAGE: (p) => `BTRIM(COALESCE(${p}.insurance_informed, ${p}.health_insurance_name, '')) = ''`,
  // activeContractedServiceCount < 1
  CONTRACTED_SERVICE: (p) => `NOT EXISTS (SELECT 1 FROM patient_contracted_services pcs WHERE pcs.patient_id = ${p}.id AND pcs.active)`,
  // !hasConsent — `null` e `false` contam como ausente, igual ao JS.
  CONSENT: (p) => `${p}.has_consent IS NOT TRUE`,
};

/**
 * `status ∈ ACTIVATABLE_STATUSES && missing.length > 0` — a mesma conta do mapper da listagem.
 *
 * ⚠️ Dois pontos onde o SQL tem TRÊS valores e o JS só tem dois — e onde o teste diferencial pegou
 * a divergência de verdade: `status` é NULLABLE (legado), e `NULL IN (…)` é NULL, não FALSE; o
 * `NULL` subiria por todo o OR e o filtro devolveria "nem sim nem não" para essas linhas.
 * `COALESCE(status,'')` fecha isso. As 5 cláusulas de `missing` nunca são NULL (NOT EXISTS,
 * BTRIM/COALESCE, IS NOT TRUE e a de idade guardada por IS NOT NULL).
 */
export function patientIncompleteAdmissionSql(p = 'p'): string {
  const statuses = ACTIVATABLE_STATUSES.map((s) => `'${s}'`).join(', ');
  const missing = PATIENT_COMPLETENESS_CODES.map((code) => MISSING_SQL[code](p)).join('\n        OR ');
  return `(COALESCE(${p}.status, '') IN (${statuses}) AND (${missing}))`;
}

/** `needsAttention` derivado: o legado GUARDADO OU a admissão incompleta. `IS TRUE` (não `= true`)
 * pelo mesmo motivo: a coluna legada aceita NULL e `NULL = true` é NULL. */
export function patientNeedsAttentionSql(p = 'p'): string {
  return `(${p}.needs_attention IS TRUE OR ${patientIncompleteAdmissionSql(p)})`;
}

/**
 * "a lista publica este motivo para esta linha?" — `reasonParam` é o placeholder (`$3`) com o
 * código pedido pelo filtro. Espelha `attentionReasonsDerived` do mapper: legado + o derivado.
 */
export function patientHasAttentionReasonSql(reasonParam: string, p = 'p'): string {
  return `(${reasonParam} = ANY(${p}.attention_reasons)
        OR (${reasonParam} = '${INCOMPLETE_ADMISSION_REASON}' AND ${patientIncompleteAdmissionSql(p)}))`;
}
