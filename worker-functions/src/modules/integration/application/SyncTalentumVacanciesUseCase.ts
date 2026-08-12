/**
 * SyncTalentumVacanciesUseCase
 *
 * Orchestrates: fetch all Talentum projects → create or update vacancies
 * in job_postings with Talentum reference data, questions and FAQ.
 *
 * Rules:
 *  - No LLM/Gemini — pure data sync from Talentum to DB
 *  - Errors on individual projects do not abort the sync
 *  - Always save Talentum reference columns (projectId, whatsappUrl, etc.)
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { TalentumApiClient } from '../infrastructure/TalentumApiClient';
import type { TalentumProject, TalentumQuestionWithId, TalentumFaq } from '../domain/ITalentumApiClient';
import {
  JobPostingAuditRepository,
} from '../../matching/infrastructure/JobPostingAuditRepository';
import { normalizePrescreeningResponseType } from '@shared/utils/normalizePrescreeningResponseType';

// ─────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────

export interface SyncReport {
  total: number;
  updated: number;
  created: number;
  skipped: number;
  errors: Array<{
    projectId: string;
    title: string;
    error: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────

export class SyncTalentumVacanciesUseCase {
  private db: Pool;
  private auditRepo: JobPostingAuditRepository;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.auditRepo = new JobPostingAuditRepository();
  }

  async execute(opts?: { force?: boolean }): Promise<SyncReport> {
    const force = opts?.force ?? false;
    const report: SyncReport = {
      total: 0,
      updated: 0,
      created: 0,
      skipped: 0,
      errors: [],
    };

    // 1. Fetch all projects from Talentum
    const talentumClient = await TalentumApiClient.create();
    const projects = await talentumClient.listAllPrescreenings();
    report.total = projects.length;

    console.log(`[SyncTalentum] Fetched ${projects.length} projects from Talentum (force=${force})`);

    // 2. Process each project sequentially
    for (const project of projects) {
      try {
        await this.processProject(project, talentumClient, report, force);
      } catch (err: any) {
        console.error(`[SyncTalentum] Error processing project ${project.projectId} ("${project.title}"):`, err.message);
        report.errors.push({
          projectId: project.projectId,
          title: project.title,
          error: err.message,
        });
      }
    }

    console.log(
      `[SyncTalentum] Done: total=${report.total} updated=${report.updated} ` +
      `created=${report.created} skipped=${report.skipped} errors=${report.errors.length}`,
    );

    return report;
  }

  private async processProject(
    project: TalentumProject,
    talentumClient: TalentumApiClient,
    report: SyncReport,
    force = false,
  ): Promise<void> {
    // 2a. Extract case_number and vacancy_number from title
    //   "CASO 230"    → case_number=230, nova vacante
    //   "CASO 230-42" → case_number=230, vacancy_number=42 (vacante existente)
    const match = project.title.match(/CASO\s+(\d+)(?:-(\d+))?/i);
    const caseNumber = match ? parseInt(match[1], 10) : null;
    const parsedVacancyNumber = match?.[2] ? parseInt(match[2], 10) : null;

    // 2b. Lookup in DB — first by talentum_project_id, then by vacancy_number
    let existing: { id: string; talentum_project_id: string | null } | null = null;

    const byTalentum = await this.db.query(
      'SELECT id, talentum_project_id FROM job_postings WHERE talentum_project_id = $1',
      [project.projectId],
    );
    existing = byTalentum.rows[0] ?? null;

    // If not found by talentum_project_id, try by vacancy_number or case_number
    if (!existing && parsedVacancyNumber != null) {
      const byVacancy = await this.db.query(
        'SELECT id, talentum_project_id FROM job_postings WHERE vacancy_number = $1',
        [parsedVacancyNumber],
      );
      existing = byVacancy.rows[0] ?? null;
    }
    if (!existing && caseNumber != null) {
      const byCaseNumber = await this.db.query(
        `SELECT id, talentum_project_id FROM job_postings
         WHERE case_number = $1 AND deleted_at IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [caseNumber],
      );
      existing = byCaseNumber.rows[0] ?? null;
    }

    // 2b'. Skip if already synced with this Talentum project (unless force)
    if (!force && existing?.talentum_project_id === project.projectId) {
      console.log(`[SyncTalentum] Skipping "${project.title}" — already synced (talentum_project_id=${project.projectId})`);
      report.skipped++;
      return;
    }

    // 2c. Use list data by default; fetch full detail only when missing description or questions
    const needsDetail = !project.description || !project.questions?.length;
    const source = needsDetail
      ? await talentumClient.getPrescreening(project.projectId)
      : project;

    // 2d. Create or update (no LLM — just save Talentum data directly)
    let jobPostingId: string;
    let wasCreated = false;

    if (existing) {
      jobPostingId = existing.id;
      report.updated++;
    } else {
      jobPostingId = await this.createFromSync(caseNumber);
      report.created++;
      wasCreated = true;
    }

    // 2e. Save Talentum reference
    await this.saveTalentumReference(jobPostingId, wasCreated, {
      talentum_project_id: source.projectId,
      talentum_public_id: source.publicId,
      talentum_whatsapp_url: source.whatsappUrl,
      talentum_slug: source.slug,
      talentum_published_at: source.timestamp,
      talentum_description: source.description,
    });

    // 2f. Sync questions and FAQ from Talentum
    if (source.questions?.length) {
      await this.syncQuestions(jobPostingId, source.questions);
    }
    if (source.faq?.length) {
      await this.syncFaq(jobPostingId, source.faq);
    }

    console.log(
      `[SyncTalentum] ${existing ? 'Updated' : 'Created'} vacancy for "${project.title}" ` +
      `case_number=${caseNumber ?? 'null'} (id=${jobPostingId})`,
    );
  }

  /**
   * Creates a new vacancy with basic data from Talentum title.
   * No LLM parsing — fields will be filled manually or via other flows.
   * Audit CREATED inside the same transaction.
   */
  private async createFromSync(caseNumber: number | null): Promise<string> {
    const vnResult = await this.db.query<{ vn: string }>(
      "SELECT nextval('job_postings_vacancy_number_seq') AS vn",
    );
    const vacancyNumber = parseInt(vnResult.rows[0].vn);
    const title = caseNumber != null
      ? `CASO ${caseNumber}-${vacancyNumber}`
      : `VACANTE ${vacancyNumber}`;

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string }>(
        `INSERT INTO job_postings (
           vacancy_number, case_number, title, description, country, status
         ) VALUES ($1, $2, $3, '', 'AR', 'SEARCHING')
         RETURNING id`,
        [vacancyNumber, caseNumber, title],
      );
      const jobPostingId = result.rows[0].id;
      // Audit best-effort via SAVEPOINT — FK failure rolls back only the INSERT,
      // leaving the surrounding transaction (and the job_posting INSERT above) intact.
      await this.auditRepo.logEventSafe(client, {
        jobPostingId,
        eventType: 'CREATED',
        changes: { before: null, after: { vacancyNumber, caseNumber, title, status: 'SEARCHING' } },
        actorUserId: null,
        actorType: 'WEBHOOK',
        actorLabel: 'talentum_sync',
      });
      await client.query('COMMIT');
      return jobPostingId;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Persists Talentum reference columns on the job_posting.
   * When wasCreated=false (update path), audits UPDATED best-effort.
   */
  private async saveTalentumReference(
    jobPostingId: string,
    wasCreated: boolean,
    ref: {
      talentum_project_id: string;
      talentum_public_id: string;
      talentum_whatsapp_url: string;
      talentum_slug: string;
      talentum_published_at: string;
      talentum_description: string;
    },
  ): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE job_postings
         SET talentum_project_id   = $1,
             talentum_public_id    = $2,
             talentum_whatsapp_url = $3,
             talentum_slug         = $4,
             talentum_published_at = $5,
             talentum_description  = $6,
             updated_at            = NOW()
         WHERE id = $7`,
        [
          ref.talentum_project_id, ref.talentum_public_id, ref.talentum_whatsapp_url,
          ref.talentum_slug, ref.talentum_published_at, ref.talentum_description, jobPostingId,
        ],
      );
      // Only audit on update path — CREATED path already audited in createFromSync.
      // Audit best-effort via SAVEPOINT — FK failure rolls back only the INSERT,
      // leaving the surrounding transaction (and the UPDATE above) intact.
      if (!wasCreated) {
        await this.auditRepo.logEventSafe(client, {
          jobPostingId,
          eventType: 'UPDATED',
          fieldName: 'talentum_project_id',
          changes: { before: null, after: ref.talentum_project_id },
          actorUserId: null,
          actorType: 'WEBHOOK',
          actorLabel: 'talentum_sync',
        });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Replaces prescreening questions for a job posting with those from Talentum.
   * Uses DELETE + INSERT to keep it simple and idempotent.
   */
  private async syncQuestions(
    jobPostingId: string,
    questions: TalentumQuestionWithId[],
  ): Promise<void> {
    await this.db.query(
      'DELETE FROM job_posting_prescreening_questions WHERE job_posting_id = $1',
      [jobPostingId],
    );

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      await this.db.query(
        `INSERT INTO job_posting_prescreening_questions
           (job_posting_id, question_order, question, response_type,
            desired_response, weight, required, analyzed, early_stoppage)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          jobPostingId,
          i + 1,
          q.question,
          // Ticket 86ajfm80t: respeita o formato da Talentum; default seguro
          // ['text','audio'] só quando ausente/vazio/inválido.
          normalizePrescreeningResponseType(q.responseType),
          q.desiredResponse,
          q.weight,
          q.required,
          q.analyzed,
          q.earlyStoppage,
        ],
      );
    }
  }

  /**
   * Replaces FAQ entries for a job posting with those from Talentum.
   */
  private async syncFaq(
    jobPostingId: string,
    faq: TalentumFaq[],
  ): Promise<void> {
    await this.db.query(
      'DELETE FROM job_posting_prescreening_faq WHERE job_posting_id = $1',
      [jobPostingId],
    );

    for (let i = 0; i < faq.length; i++) {
      const f = faq[i];
      await this.db.query(
        `INSERT INTO job_posting_prescreening_faq
           (job_posting_id, faq_order, question, answer)
         VALUES ($1, $2, $3, $4)`,
        [jobPostingId, i + 1, f.question, f.answer],
      );
    }
  }
}
