/**
 * CreateJobPostingFromTalentumUseCase
 *
 * Creates a job_posting when Talentum fires a PRESCREENING.CREATED event.
 *
 * Rules:
 *  - vacancy_number is generated via SEQUENCE job_postings_vacancy_number_seq
 *  - case_number is extracted from data.name via the shared parser (T063 —
 *    tolerates "CASO N[-M]" legado e "EN N#M" / "N#M" novo)
 *  - Title: "CASO {caseNumber}-{vacancyNumber}" if caseNumber found, else "VACANTE {vacancyNumber}"
 *  - Status is always SEARCHING
 *  - Country defaults to AR
 *  - If talentum_project_id already exists → skip silently (anti-loop)
 *  - Unique constraint violation (23505) on talentum_project_id → treat as skip (race condition)
 *  - environment parameter is used only for logging, not persisted on job_postings
 *
 * Onda B: CREATED and link-existing mutations are audited as WEBHOOK/talentum_webhook.
 * Audit is inserted INSIDE the same pool.query — for the INSERT path we open a
 * short-lived transaction to keep audit atomic with the INSERT.
 */

import { Pool } from 'pg';
import {
  JobPostingAuditRepository,
} from '../../matching/infrastructure/JobPostingAuditRepository';
import { parseCaseTitleReference } from '@shared/utils/parseCaseTitleReference';
import { formatCaseTitle } from '@shared/utils/caseNumberFormat';
import { guardedPrescreeningIdSql, logPrescreeningIdCollision } from './talentumPrescreeningIdGuard';
import { TalentumApiClient } from '../infrastructure/TalentumApiClient';

// ─────────────────────────────────────────────────────────────────
// Input / Output types
// ─────────────────────────────────────────────────────────────────

export interface CreateJobPostingFromTalentumInput {
  _id: string;
  name: string;
}

export interface CreateJobPostingFromTalentumResult {
  created: boolean;
  skipped: boolean;
  jobPostingId?: string;
  caseNumber?: number | null;
  vacancyNumber?: number;
  reason?: string;
}

/** `GET /projects/{projectId}/prescreening` → `_id` (o `data.prescreening.id` dos webhooks de resposta). */
export type PrescreeningIdResolver = (talentumProjectId: string) => Promise<string | null>;

/**
 * Resolver de produção: reaproveita `TalentumApiClient.getPrescreening` (mesmo caminho do publish/sync/backfill).
 * Best-effort: qualquer falha → null (a vaga nasce sem o `_id` e o backfill preenche) — nunca derruba o webhook.
 */
export const talentumPrescreeningIdResolver: PrescreeningIdResolver = async (projectId) => {
  try {
    const client = await TalentumApiClient.create();
    const detail = await client.getPrescreening(projectId);
    return detail.prescreeningId ?? null;
  } catch (err) {
    console.warn(`[CreateJobPostingFromTalentum] não obteve o _id do prescreening (projeto ${projectId}): ${(err as Error).message}`);
    return null;
  }
};

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

// ─────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────

export class CreateJobPostingFromTalentumUseCase {
  private readonly auditRepo: JobPostingAuditRepository;

  /** `resolvePrescreeningId` default = não resolve (null): handlers de produção injetam `talentumPrescreeningIdResolver`. */
  constructor(
    private readonly pool: Pool,
    private readonly resolvePrescreeningId: PrescreeningIdResolver = async () => null,
  ) {
    this.auditRepo = new JobPostingAuditRepository();
  }

  async execute(
    data: CreateJobPostingFromTalentumInput,
    environment: string,
  ): Promise<CreateJobPostingFromTalentumResult> {
    console.log(
      `[CreateJobPostingFromTalentum] Received event — talentum_project_id=${data._id} ` +
      `name="${data.name}" environment=${environment}`,
    );

    // ── 1. Anti-loop: verificar se já existe por talentum_project_id ──
    const existing = await this.pool.query<{ id: string }>(
      'SELECT id FROM job_postings WHERE talentum_project_id = $1',
      [data._id],
    );

    if (existing.rows.length > 0) {
      const jobPostingId = existing.rows[0].id;
      console.log(
        `[CreateJobPostingFromTalentum] Skip — talentum_project_id=${data._id} already linked to job_posting=${jobPostingId}`,
      );
      return { created: false, skipped: true, jobPostingId, reason: 'already_exists' };
    }

    // ── 1b. `_id` do prescreening: o webhook de resposta só traz ele (≠ talentum_project_id em 98%) ──
    const prescreeningId = await this.resolvePrescreeningId(data._id);

    // ── 2. Extrair case_number e vacancy_number do título Talentum ───
    // T063: parser compartilhado — tolera "CASO N[-M]" (legado) e "EN N#M" / "N#M" (novo).
    const { caseNumber, ordinal: parsedVacancyNumber } = parseCaseTitleReference(data.name);

    // ── 3. Buscar vacante existente ────────────────────────────────
    let existingVacancy: { id: string; vacancy_number: number } | null = null;

    if (parsedVacancyNumber != null) {
      const byVn = await this.pool.query<{ id: string; vacancy_number: number }>(
        'SELECT id, vacancy_number FROM job_postings WHERE vacancy_number = $1',
        [parsedVacancyNumber],
      );
      existingVacancy = byVn.rows[0] ?? null;
    } else if (caseNumber != null) {
      const byCn = await this.pool.query<{ id: string; vacancy_number: number }>(
        `SELECT id, vacancy_number FROM job_postings
         WHERE case_number = $1 AND talentum_project_id IS NULL AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [caseNumber],
      );
      existingVacancy = byCn.rows[0] ?? null;
    }

    if (existingVacancy) {
      const jobPostingId = existingVacancy.id;
      // Link existing: best-effort audit — UPDATE + audit in same transaction
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        const linked = await client.query(
          `UPDATE job_postings
           SET talentum_project_id = $1, talentum_published_at = NOW(),
               talentum_prescreening_id = COALESCE(${guardedPrescreeningIdSql(3, 2)}, talentum_prescreening_id)
           WHERE id = $2
           RETURNING talentum_prescreening_id`,
          [data._id, jobPostingId, prescreeningId],
        );
        await logPrescreeningIdCollision(client, jobPostingId, prescreeningId, linked.rows[0]?.talentum_prescreening_id);
        // Audit best-effort via SAVEPOINT — FK failure rolls back only the INSERT,
        // leaving the surrounding transaction (and the UPDATE above) intact.
        await this.auditRepo.logEventSafe(client, {
          jobPostingId,
          eventType: 'UPDATED',
          fieldName: 'talentum_project_id',
          changes: { before: null, after: data._id },
          actorUserId: null,
          actorType: 'WEBHOOK',
          actorLabel: 'talentum_webhook',
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      console.log(
        `[CreateJobPostingFromTalentum] Linked existing vacancy_number=${existingVacancy.vacancy_number} ` +
        `(job_posting=${jobPostingId}) to talentum_project_id=${data._id}`,
      );
      return { created: false, skipped: false, jobPostingId, caseNumber, vacancyNumber: existingVacancy.vacancy_number, reason: 'linked_existing' };
    }

    // ── 4. Gerar vacancy_number via SEQUENCE ──────────────────────
    const vnResult = await this.pool.query<{ vn: string }>(
      "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
    );
    const vacancyNumber = parseInt(vnResult.rows[0].vn);
    const title = caseNumber != null
      ? formatCaseTitle(caseNumber, vacancyNumber)
      : `VACANTE ${vacancyNumber}`;

    // ── 5. Inserir job_posting + audit CREATED na mesma transação ──
    try {
      const client = await this.pool.connect();
      let jobPostingId: string;
      try {
        await client.query('BEGIN');
        const insertResult = await client.query<{ id: string; talentum_prescreening_id: string | null }>(
          `INSERT INTO job_postings (
             vacancy_number, case_number, title,
             status, country,
             talentum_project_id, talentum_published_at, talentum_prescreening_id
           ) VALUES (
             $1, $2, $3,
             'SEARCHING', 'AR',
             $4, NOW(), ${guardedPrescreeningIdSql(5, 6)}
           )
           RETURNING id, talentum_prescreening_id`,
          // $6: a vaga ainda não existe → uuid nulo (o guard compara `o.id <> $6` contra as OUTRAS vivas).
          [vacancyNumber, caseNumber, title, data._id, prescreeningId, NIL_UUID],
        );
        jobPostingId = insertResult.rows[0].id;
        await logPrescreeningIdCollision(client, jobPostingId, prescreeningId, insertResult.rows[0].talentum_prescreening_id);

        // Audit best-effort via SAVEPOINT — FK failure rolls back only the INSERT,
        // leaving the surrounding transaction (and the job_posting INSERT above) intact.
        await this.auditRepo.logEventSafe(client, {
          jobPostingId,
          eventType: 'CREATED',
          changes: {
            before: null,
            after: { vacancyNumber, caseNumber, title, status: 'SEARCHING', talentum_project_id: data._id, talentum_prescreening_id: prescreeningId },
          },
          actorUserId: null,
          actorType: 'WEBHOOK',
          actorLabel: 'talentum_webhook',
        });

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      console.log(
        `[CreateJobPostingFromTalentum] Created job_posting=${jobPostingId} ` +
        `vacancy_number=${vacancyNumber} case_number=${caseNumber ?? 'null'} ` +
        `title="${title}" talentum_project_id=${data._id}`,
      );

      return { created: true, skipped: false, jobPostingId, caseNumber, vacancyNumber };
    } catch (err: unknown) {
      // ── Race condition: unique_violation em talentum_project_id ──
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') {
        const raceExisting = await this.pool.query<{ id: string }>(
          'SELECT id FROM job_postings WHERE talentum_project_id = $1',
          [data._id],
        );
        const jobPostingId = raceExisting.rows[0]?.id;
        console.log(
          `[CreateJobPostingFromTalentum] Race condition — talentum_project_id=${data._id} ` +
          `already inserted concurrently, job_posting=${jobPostingId ?? 'unknown'}`,
        );
        return { created: false, skipped: true, jobPostingId, reason: 'race_condition' };
      }
      throw err;
    }
  }
}

export default CreateJobPostingFromTalentumUseCase;
