/**
 * CreateJobPostingFromTalentumUseCase
 *
 * Creates a job_posting when Talentum fires a PRESCREENING.CREATED event.
 *
 * Rules:
 *  - vacancy_number is generated via SEQUENCE job_postings_vacancy_number_seq
 *  - case_number is extracted from data.name via regex /CASO\s+(\d+)/i
 *  - Title: "CASO {caseNumber}-{vacancyNumber}" if caseNumber found, else "VACANTE {vacancyNumber}"
 *  - Status is always SEARCHING
 *  - Country defaults to AR
 *  - If talentum_project_id already exists → skip silently (anti-loop)
 *  - Unique constraint violation (23505) on talentum_project_id → treat as skip (race condition)
 *  - environment parameter is used only for logging, not persisted on job_postings
 */

import { Pool } from 'pg';

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

// ─────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────

export class CreateJobPostingFromTalentumUseCase {
  constructor(private readonly pool: Pool) {}

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
      return {
        created: false,
        skipped: true,
        jobPostingId,
        reason: 'already_exists',
      };
    }

    // ── 2. Extrair case_number e vacancy_number do título Talentum ───
    //   "CASO 230"    → case_number=230, vacante nova (gerar vacancy_number)
    //   "CASO 230-42" → case_number=230, vacante 42 já existe (vincular ao Talentum)
    const caseMatch = data.name.match(/CASO\s+(\d+)(?:-(\d+))?/i);
    const caseNumber: number | null = caseMatch ? parseInt(caseMatch[1], 10) : null;
    const parsedVacancyNumber: number | null = caseMatch?.[2] ? parseInt(caseMatch[2], 10) : null;

    // ── 3. Buscar vacante existente ────────────────────────────────
    //   "CASO 230-42" → busca por vacancy_number=42 (match exato)
    //   "CASO 230"    → busca por case_number=230 (pega a mais recente sem talentum vinculado)
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
      await this.pool.query(
        `UPDATE job_postings SET talentum_project_id = $1, talentum_published_at = NOW() WHERE id = $2`,
        [data._id, jobPostingId],
      );

      console.log(
        `[CreateJobPostingFromTalentum] Linked existing vacancy_number=${existingVacancy.vacancy_number} ` +
        `(job_posting=${jobPostingId}) to talentum_project_id=${data._id}`,
      );

      return {
        created: false,
        skipped: false,
        jobPostingId,
        caseNumber,
        vacancyNumber: existingVacancy.vacancy_number,
        reason: 'linked_existing',
      };
    }

    // ── 4. Gerar vacancy_number via SEQUENCE (vacante nova — nenhuma existente encontrada) ──
    const vnResult = await this.pool.query<{ vn: string }>(
      "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
    );
    const vacancyNumber = parseInt(vnResult.rows[0].vn);
    const title = caseNumber != null
      ? `CASO ${caseNumber}-${vacancyNumber}`
      : `VACANTE ${vacancyNumber}`;

    // ── 5. Inserir job_posting ──────────────────────────────────────
    try {
      const insertResult = await this.pool.query<{ id: string }>(
        `INSERT INTO job_postings (
           vacancy_number, case_number, title,
           status, country,
           talentum_project_id, talentum_published_at
         ) VALUES (
           $1, $2, $3,
           'SEARCHING', 'AR',
           $4, NOW()
         )
         RETURNING id`,
        [vacancyNumber, caseNumber, title, data._id],
      );

      const jobPostingId = insertResult.rows[0].id;

      console.log(
        `[CreateJobPostingFromTalentum] Created job_posting=${jobPostingId} ` +
        `vacancy_number=${vacancyNumber} case_number=${caseNumber ?? 'null'} ` +
        `title="${title}" talentum_project_id=${data._id}`,
      );

      return {
        created: true,
        skipped: false,
        jobPostingId,
        caseNumber,
        vacancyNumber,
      };
    } catch (err: any) {
      // ── 4. Race condition: unique_violation em talentum_project_id ──
      if (err.code === '23505') {
        const raceExisting = await this.pool.query<{ id: string }>(
          'SELECT id FROM job_postings WHERE talentum_project_id = $1',
          [data._id],
        );
        const jobPostingId = raceExisting.rows[0]?.id;

        console.log(
          `[CreateJobPostingFromTalentum] Race condition — talentum_project_id=${data._id} ` +
          `already inserted concurrently, job_posting=${jobPostingId ?? 'unknown'}`,
        );

        return {
          created: false,
          skipped: true,
          jobPostingId,
          reason: 'race_condition',
        };
      }

      throw err;
    }
  }
}

export default CreateJobPostingFromTalentumUseCase;
