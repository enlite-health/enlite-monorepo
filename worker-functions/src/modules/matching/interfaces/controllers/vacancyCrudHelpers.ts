/**
 * vacancyCrudHelpers
 *
 * Module-level helpers for VacancyCrudController.
 * Extracted to keep VacancyCrudController within the 400-line limit.
 */

import type { Pool } from 'pg';
import { captureEntityDiff } from '@shared/audit/captureEntityDiff';
import type { EntityFieldDiff } from '@shared/audit/types';

export interface VacancyInsertParams {
  vacancyNumber: number;
  case_number: any;
  computedTitle: string;
  patient_id: any;
  required_professions: any;
  required_sex: any;
  age_range_min: any;
  age_range_max: any;
  worker_profile_sought: any;
  required_experience: any;
  worker_attributes: any;
  schedule: any;
  work_schedule: any;
  providers_needed: any;
  salary_text: any;
  payment_day: any;
  daily_obs: any;
  patient_address_id: any;
  /** Default: 'PENDING_ACTIVATION' when not provided. */
  status?: string;
  /** ISO date (YYYY-MM-DD) or full timestamp. Defaults to NOW() in the SQL when null. */
  published_at?: string | null;
  /** ISO date (YYYY-MM-DD) or full timestamp. Optional — left NULL when not provided. */
  closes_at?: string | null;
  /**
   * Guarda de vaga de teste/QA (migration 248). Quando true, o
   * VacancyAutoInviteHandler pula matchmaking/WJA/outbox por completo ao
   * processar o domain event `vacancy.created`. Default: false.
   */
  is_test?: boolean;
  /**
   * Permite a vaga nascer publicável (is_draft=false) SEM passar pelo
   * PublishVacancyToTalentumUseCase. Só tem efeito quando is_test=true
   * (ver buildInsertParams) — vaga real sempre nasce is_draft=true (DEFAULT
   * da migration 168), porque só o publish no Talentum pode destravar isso.
   * Existe para a fixture de E2E: ela precisa de uma vaga publicável sem
   * tocar Talentum/Groq (canal real proibido em teste).
   */
  is_draft?: boolean;
  /**
   * De qual serviço contratado esta vaga nasceu (migration 320, spec 013 bloco C). NULL para
   * `POST /vacancies` normal (o operador cria a vaga direto, sem passar por um serviço) e para
   * `activate` de paciente sem nenhum serviço declarado (fallback por endereço).
   */
  contracted_service_id?: string | null;
}

export const CANONICAL_STATUSES = new Set([
  'SEARCHING',
  'SEARCHING_REPLACEMENT',
  'RAPID_RESPONSE',
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
  'CLOSED',
]);

export const OPERATIONAL_EDITABLE_FIELDS = new Set(['schedule', 'status']);

export const FULL_ALLOWED_UPDATE_FIELDS = [
  'title', 'case_number', 'patient_id', 'patient_address_id',
  'required_professions', 'required_sex',
  'age_range_min', 'age_range_max',
  'worker_profile_sought', 'required_experience', 'worker_attributes',
  'schedule', 'work_schedule',
  'providers_needed', 'salary_text', 'payment_day',
  'daily_obs', 'status',
  'published_at', 'closes_at',
];

/**
 * SOURCE_LOCKED_FIELDS — as colunas de `job_postings` cujo valor vem do
 * paciente/serviço contratado (F3, `docs`/`fatos-medidos.md` da change
 * `completar-vacante-em-rascunho`), não do recrutamento. Fonte única: o
 * dono é `buildInsertParams` (via `pickSourceLockedFields`, abaixo) — é o
 * MESMO código que preenche essas colunas no INSERT do foguete
 * (`ActivateRecruitmentUseCase`). `GET /vacancies/:id` devolve esta lista
 * como `locked_fields` quando `contracted_service_id IS NOT NULL`, e `PUT
 * /vacancies/:id` (`authorizeVacancyUpdate`, abaixo) recusa com 422 qualquer
 * body que toque uma destas chaves na mesma condição — rascunho ou
 * publicada, porque a origem não muda de dono ao publicar.
 *
 * Coluna nova preenchida pelo foguete que não entrar aqui NÃO pode ser lida
 * de `pickSourceLockedFields` (o tipo não deixa) — e se alguém sabotar isso
 * por fora, o teste de paridade (`ActivateRecruitmentUseCase.sourceLockedFields.test.ts`,
 * `-t "paridade"`) morre.
 */
export const SOURCE_LOCKED_FIELDS = [
  'case_number',
  'patient_id',
  'patient_address_id',
  'contracted_service_id',
  'age_range_min',
  'age_range_max',
  'schedule',
  'providers_needed',
] as const satisfies readonly (keyof VacancyInsertParams)[];

export type SourceLockedField = (typeof SOURCE_LOCKED_FIELDS)[number];

/**
 * Extrai de `p` só os campos travados pela origem (`SOURCE_LOCKED_FIELDS`).
 * `buildInsertParams` consome isto para montar as colunas do INSERT que vêm
 * do serviço — nunca lê `p.case_number`/`p.patient_id`/etc. direto para
 * essas 8 colunas. O tipo de retorno (`Pick<VacancyInsertParams,
 * SourceLockedField>`) é o que faz uma coluna nova "não compilar" sem
 * entrar na constante: não dá para ler `locked.<campo>` se `<campo>` não
 * está em `SOURCE_LOCKED_FIELDS`.
 */
export function pickSourceLockedFields(
  p: VacancyInsertParams,
): Pick<VacancyInsertParams, SourceLockedField> {
  const out = {} as Pick<VacancyInsertParams, SourceLockedField>;
  for (const field of SOURCE_LOCKED_FIELDS) {
    out[field] = p[field];
  }
  return out;
}

export type UpdateAuthorizationResult =
  | { kind: 'error'; status: number; error: string; lockedFields?: readonly string[] }
  | { kind: 'ok'; isDraft: boolean; currentStatus: string | null };

/**
 * Validates that a PUT /api/admin/vacancies/:id is allowed:
 *   - status (when present) must be canonical
 *   - vacancy must exist
 *   - when is_draft=false: only OPERATIONAL_EDITABLE_FIELDS are allowed
 *   - when is_draft=true and patient_id is changing: new patient must exist
 *   - when is_draft=true and patient_address_id is changing: address must
 *     belong to the (current or new) patient AND be active (archived_at IS NULL)
 *
 * is_draft is the canonical "incomplete publication" flag (migration 168).
 * Decoupled from status — operator may pick a public status on Step 1 and
 * still have is_draft=true until Talentum publish flips it.
 */
export async function authorizeVacancyUpdate(
  db: Pool,
  vacancyId: string,
  updates: Record<string, unknown>,
): Promise<UpdateAuthorizationResult> {
  if (updates.status !== undefined && !CANONICAL_STATUSES.has(updates.status as string)) {
    return {
      kind: 'error',
      status: 400,
      error: `Invalid status value "${updates.status}". Must be one of: ${[...CANONICAL_STATUSES].join(', ')}`,
    };
  }

  const currentRow = await db.query<{
    status: string | null;
    is_draft: boolean | null;
    patient_id: string | null;
    contracted_service_id: string | null;
  }>(
    'SELECT status, is_draft, patient_id, contracted_service_id FROM job_postings WHERE id = $1',
    [vacancyId],
  );
  if (currentRow.rows.length === 0) {
    return { kind: 'error', status: 404, error: 'Vacancy not found' };
  }
  const currentStatus = currentRow.rows[0].status;
  const isDraft = currentRow.rows[0].is_draft === true;
  const contractedServiceId = currentRow.rows[0].contracted_service_id;
  const effectivePatientId =
    typeof updates.patient_id === 'string' && updates.patient_id
      ? (updates.patient_id as string)
      : currentRow.rows[0].patient_id;

  // F3/fase-1 (`completar-vacante-em-rascunho`): a vaga nascida do foguete tem
  // `contracted_service_id` — os campos de SOURCE_LOCKED_FIELDS vêm do
  // paciente/serviço, não do recrutamento, e continuam travados MESMO
  // publicada (a origem não muda de dono ao publicar). Roda ANTES do gate de
  // rascunho/publicada abaixo — o 422 é a regra mais específica.
  if (contractedServiceId != null) {
    const lockedFields = SOURCE_LOCKED_FIELDS.filter((f) => f in updates);
    if (lockedFields.length > 0) {
      return {
        kind: 'error',
        status: 422,
        error: `Campos travados pela origem (paciente/serviço contratado) não podem ser editados: ${lockedFields.join(', ')}.`,
        lockedFields,
      };
    }
  }

  if (!isDraft) {
    const forbidden = Object.keys(updates).filter(f => !OPERATIONAL_EDITABLE_FIELDS.has(f));
    if (forbidden.length > 0) {
      return {
        kind: 'error',
        status: 403,
        error: `Forbidden fields for vacancy in status "${currentStatus}": ${forbidden.join(', ')}. Only schedule and status can be edited.`,
      };
    }
  }

  if (isDraft && 'patient_id' in updates) {
    const newPatientId = updates.patient_id;
    if (newPatientId === null || newPatientId === '' || typeof newPatientId !== 'string') {
      return {
        kind: 'error',
        status: 400,
        error: 'patient_id não pode ser removido de uma vaga existente.',
      };
    }
    const patientCheck = await db.query<{ id: string }>(
      'SELECT id FROM patients WHERE id = $1 AND deleted_at IS NULL',
      [newPatientId],
    );
    if (patientCheck.rows.length === 0) {
      return {
        kind: 'error',
        status: 400,
        error: 'patient_id inválido — paciente não encontrado ou foi removido.',
      };
    }
  }

  if (isDraft && 'patient_address_id' in updates && updates.patient_address_id) {
    const ownerCheck = await db.query(
      `SELECT 1
         FROM patient_addresses pa
        WHERE pa.id = $1
          AND pa.patient_id = $2
          AND pa.archived_at IS NULL`,
      [updates.patient_address_id, effectivePatientId],
    );
    if (ownerCheck.rows.length === 0) {
      return {
        kind: 'error',
        status: 400,
        error: 'patient_address_id não pertence ao patient_id informado ou foi arquivado',
      };
    }
  }

  return { kind: 'ok', isDraft, currentStatus };
}

export function buildInsertQuery(): string {
  // `published_at` defaults to NOW() when the caller passes NULL — matches the
  // product rule that publication date auto-fills with today if left blank.
  // `closes_at` stays NULL when not provided (optional).
  //
  // `case_ordinal` (spec 027 Fase 5, migration 460) — a enésima vaga do caso
  // (patient_id). NÃO ganha placeholder novo: é computada por subquery DENTRO
  // do próprio INSERT, reusando $4 (patient_id) — sempre a MESMA transação/
  // statement de quem chama, nunca uma 2ª ida ao banco. Concorrência real (dois
  // cliques simultâneos no mesmo caso) é resolvida pelo índice único
  // idx_job_postings_case_ordinal: o 2º INSERT bloqueia no lock de valor do
  // índice, e ao destravar já vê o valor commitado do 1º — reconta e bate 23505
  // se ainda colidir. Callers tratam 23505 com retry (ver isCaseOrdinalConflict/
  // retryOnCaseOrdinalConflict abaixo).
  return `
    INSERT INTO job_postings (
      vacancy_number, case_number, title, patient_id,
      required_professions, required_sex,
      age_range_min, age_range_max,
      worker_profile_sought, required_experience, worker_attributes,
      schedule, work_schedule,
      providers_needed, salary_text, payment_day,
      daily_obs,
      patient_address_id,
      status,
      published_at, closes_at,
      country,
      is_test,
      contracted_service_id,
      is_draft,
      case_ordinal
    ) VALUES (
      $1, $2, $3, $4,
      $5, $6,
      $7, $8,
      $9, $10, $11,
      $12, $13,
      $14, $15, $16,
      $17,
      $18,
      $19,
      COALESCE($20::timestamptz, NOW()), $21::timestamptz,
      'AR',
      $22,
      $23,
      $24,
      CASE WHEN $4::uuid IS NULL THEN NULL ELSE (
        SELECT COALESCE(MAX(jp2.case_ordinal), 0) + 1
          FROM job_postings jp2
         WHERE jp2.patient_id = $4::uuid
      ) END
    )
    RETURNING *
  `;
}

// ─── case_ordinal conflict retry (spec 027 Fase 5) ───────────────────────────

/** O 23505 que é CONFLITO DE case_ordinal — e só ele (mesma régua de isCaseNumberConflict). */
export function isCaseOrdinalConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: string; constraint?: string };
  return e.code === '23505' && e.constraint === 'idx_job_postings_case_ordinal';
}

export const CASE_ORDINAL_MAX_ATTEMPTS = 5;

/**
 * Reexecuta `attempt` até MAX_ATTEMPTS quando o erro é um conflito de
 * case_ordinal (corrida entre dois INSERTs no mesmo caso). `onConflict`,
 * quando informado, roda ANTES de cada nova tentativa — usado pelos callers
 * que estão dentro de uma transação explícita para `ROLLBACK TO SAVEPOINT`
 * (o 23505 aborta a transação até lá). Erro que não é conflito de
 * case_ordinal sobe na hora, sem retry.
 */
export async function retryOnCaseOrdinalConflict<T>(
  attempt: () => Promise<T>,
  onConflict?: () => Promise<void>,
  maxAttempts: number = CASE_ORDINAL_MAX_ATTEMPTS,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isCaseOrdinalConflict(err)) throw err;
      lastErr = err;
      if (onConflict) await onConflict();
    }
  }
  throw lastErr;
}

// ─── Diff helper (Onda A — pure, no DB) ──────────────────────────────────────

/**
 * VacancyFieldDiff: alias de EntityFieldDiff para compatibilidade com callers
 * existentes que importam este tipo daqui.
 */
export type VacancyFieldDiff = EntityFieldDiff;

/**
 * captureVacancyDiff
 *
 * Função pura que compara dois snapshots de uma vaga e retorna apenas os campos
 * que realmente mudaram, filtrados pela lista de campos permitidos.
 *
 * Delega para captureEntityDiff (shared/audit) — a lógica de diff mora lá.
 * API pública preservada: mesma assinatura e tipo de retorno que os callers usam.
 *
 * @param before        - Snapshot da vaga antes da mutação (objeto plano).
 * @param after         - Snapshot da vaga após a mutação (objeto plano).
 * @param allowedFields - Whitelist de campos a inspecionar (ex: FULL_ALLOWED_UPDATE_FIELDS).
 * @returns Array de { field, before, after } apenas para campos que mudaram.
 */
export function captureVacancyDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  allowedFields: readonly string[],
): VacancyFieldDiff[] {
  return captureEntityDiff(before, after, allowedFields);
}

export function buildInsertParams(p: VacancyInsertParams): unknown[] {
  const status =
    p.status && CANONICAL_STATUSES.has(p.status) ? p.status : 'PENDING_ACTIVATION';

  // Vaga real SEMPRE nasce is_draft=true (mesmo comportamento de sempre — só
  // o publish no Talentum destrava). A exceção é restrita a is_test=true:
  // fixture de E2E precisa nascer publicável sem tocar Talentum/Groq.
  const isDraft = !(p.is_test === true && p.is_draft === false);

  // As 8 colunas que vêm do paciente/serviço (SOURCE_LOCKED_FIELDS) são lidas
  // SÓ daqui — nunca de `p.<campo>` direto — para que o INSERT e o `locked_fields`
  // do GET/PUT nunca divirjam (fonte única, teste de paridade).
  const locked = pickSourceLockedFields(p);

  return [
    p.vacancyNumber,
    locked.case_number,
    p.computedTitle,
    locked.patient_id,
    p.required_professions ?? [],
    p.required_sex ?? null,
    locked.age_range_min ?? null,
    locked.age_range_max ?? null,
    p.worker_profile_sought ?? null,
    p.required_experience ?? null,
    p.worker_attributes ?? null,
    locked.schedule ? JSON.stringify(locked.schedule) : null,
    p.work_schedule ?? null,
    locked.providers_needed,
    p.salary_text ?? 'A convenir',
    p.payment_day ?? null,
    p.daily_obs ?? null,
    locked.patient_address_id ?? null,
    status,
    p.published_at ?? null,
    p.closes_at ?? null,
    p.is_test === true,
    locked.contracted_service_id ?? null,
    isDraft,
  ];
}
