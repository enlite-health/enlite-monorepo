/**
 * PublishVacancyToTalentumUseCase
 *
 * Orchestrates: generate description (Groq) → create prescreening (Talentum API)
 * → fetch whatsappUrl → save references in job_postings.
 *
 * Also handles unpublishing (delete from Talentum + clear DB columns).
 *
 * Onda B: publish/unpublish accept an optional `actor` param for audit logging.
 * Audit rows are inserted INSIDE the existing transaction via logEventSafe (SAVEPOINT).
 * If the audit INSERT fails, only the audit row is rolled back — the surrounding
 * transaction (UPDATE job_postings) is NOT affected and always commits.
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { TalentumDescriptionService } from '../infrastructure/TalentumDescriptionService';
import { TalentumApiClient } from '../infrastructure/TalentumApiClient';
import type { TalentumQuestion, TalentumFaq } from '../domain/ITalentumApiClient';
import {
  JobPostingAuditRepository,
  type AuditActorType,
} from '../../matching/infrastructure/JobPostingAuditRepository';

// ─────────────────────────────────────────────────────────────────
// Input / Output types
// ─────────────────────────────────────────────────────────────────

interface PublishInput {
  jobPostingId: string;
}

interface PublishOutput {
  projectId: string;
  publicId: string;
  whatsappUrl: string;
}

interface UnpublishInput {
  jobPostingId: string;
}

export interface AuditActor {
  actorUserId: string | null;
  actorType: AuditActorType;
  actorLabel: string;
  traceId?: string | null;
}

// ─────────────────────────────────────────────────────────────────
// Use case
// ─────────────────────────────────────────────────────────────────

export class PublishVacancyToTalentumUseCase {
  private db: Pool;
  private auditRepo: JobPostingAuditRepository;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.auditRepo = new JobPostingAuditRepository();
  }

  /**
   * Publishes a vacancy to Talentum.
   *
   * Steps:
   *  1. Load vacancy + validate state
   *  2. Generate description via Groq if missing
   *  3. Load prescreening questions + FAQ from DB
   *  4. Create prescreening project on Talentum
   *  5. GET the project to obtain whatsappUrl + slug
   *  6. Save references in job_postings (within transaction) + audit DRAFT_CHANGED
   */
  async publish(input: PublishInput, actor?: AuditActor): Promise<PublishOutput> {
    const { jobPostingId } = input;

    // 1. Load vacancy and validate
    const jpResult = await this.db.query(
      `SELECT id, title, talentum_project_id, talentum_description, is_draft
       FROM job_postings WHERE id = $1 AND deleted_at IS NULL`,
      [jobPostingId],
    );

    if (jpResult.rows.length === 0) {
      throw new PublishError(404, `Vacancy ${jobPostingId} not found`);
    }

    const vacancy = jpResult.rows[0] as {
      title: string | null;
      talentum_project_id: string | null;
      talentum_description: string | null;
      is_draft: boolean;
    };

    // CA-4.2: already published → 409
    if (vacancy.talentum_project_id) {
      throw new PublishError(409, 'Vacancy is already published on Talentum');
    }

    // CA-4.1: must have prescreening questions → 400
    const questionsResult = await this.db.query(
      `SELECT id, question, response_type, desired_response, weight,
              required, analyzed, early_stoppage
       FROM job_posting_prescreening_questions
       WHERE job_posting_id = $1
       ORDER BY question_order ASC`,
      [jobPostingId],
    );

    if (questionsResult.rows.length === 0) {
      throw new PublishError(400, 'No prescreening questions configured for this vacancy');
    }

    // 2. Generate description if missing (CA-4.3)
    let description = vacancy.talentum_description as string | null;
    if (!description) {
      const descService = new TalentumDescriptionService();
      const generated = await descService.generateDescription(jobPostingId, actor);
      description = generated.description;
    }

    // 3. Map questions to Talentum format
    const questions: TalentumQuestion[] = questionsResult.rows.map(row => ({
      question: row.question,
      type: 'text' as const,
      responseType: row.response_type ?? ['text', 'audio'],
      desiredResponse: row.desired_response,
      weight: row.weight,
      required: row.required,
      analyzed: row.analyzed,
      earlyStoppage: row.early_stoppage,
    }));

    // Load FAQ (optional)
    const faqResult = await this.db.query(
      `SELECT question, answer
       FROM job_posting_prescreening_faq
       WHERE job_posting_id = $1
       ORDER BY faq_order ASC`,
      [jobPostingId],
    );
    const faq: TalentumFaq[] = faqResult.rows.map(row => ({
      question: row.question,
      answer: row.answer,
    }));

    // 4. Create prescreening on Talentum
    let talentumClient: TalentumApiClient;
    try {
      talentumClient = await TalentumApiClient.create();
    } catch (err: unknown) {
      throw new PublishError(502, `Failed to initialize Talentum client: ${(err as Error).message}`);
    }

    let projectId: string;
    let publicId: string;
    try {
      const createResult = await talentumClient.createPrescreening({
        title: vacancy.title ?? `Caso ${jobPostingId}`,
        description: description!,
        questions,
        faq: faq.length > 0 ? faq : undefined,
      });
      projectId = createResult.projectId;
      publicId = createResult.publicId;
    } catch (err: unknown) {
      throw new PublishError(502, `Talentum API error (create): ${(err as Error).message}`);
    }

    // 5. GET project to obtain whatsappUrl + slug
    let whatsappUrl: string;
    let slug: string;
    try {
      const project = await talentumClient.getPrescreening(projectId);
      whatsappUrl = project.whatsappUrl;
      slug = project.slug;
    } catch (err: unknown) {
      throw new PublishError(502, `Talentum API error (get): ${(err as Error).message}`);
    }

    // 6. Save references + audit DRAFT_CHANGED (CA-4.7: transaction)
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE job_postings
         SET talentum_project_id   = $1,
             talentum_public_id    = $2,
             talentum_whatsapp_url = $3,
             talentum_slug         = $4,
             talentum_published_at = NOW(),
             is_draft              = false,
             updated_at            = NOW()
         WHERE id = $5`,
        [projectId, publicId, whatsappUrl, slug, jobPostingId],
      );

      // Audit best-effort via SAVEPOINT — FK failure rolls back only the INSERT,
      // leaving the surrounding transaction (and the UPDATE above) intact.
      if (actor) {
        await this.auditRepo.logEventSafe(client, {
          jobPostingId,
          eventType: 'DRAFT_CHANGED',
          fieldName: 'is_draft',
          changes: { before: vacancy.is_draft, after: false },
          actorUserId: actor.actorUserId,
          actorType: actor.actorType,
          actorLabel: actor.actorLabel,
          traceId: actor.traceId ?? null,
        });
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `[PublishVacancy] Published vacancy ${jobPostingId} → Talentum project ${projectId}`,
    );

    return { projectId, publicId, whatsappUrl };
  }

  /**
   * Unpublishes a vacancy from Talentum.
   * Deletes the prescreening project and clears all Talentum columns.
   * Audits DRAFT_CHANGED (is_draft: false → true).
   */
  async unpublish(input: UnpublishInput, actor?: AuditActor): Promise<void> {
    const { jobPostingId } = input;

    const jpResult = await this.db.query(
      `SELECT talentum_project_id, is_draft FROM job_postings WHERE id = $1 AND deleted_at IS NULL`,
      [jobPostingId],
    );

    if (jpResult.rows.length === 0) {
      throw new PublishError(404, `Vacancy ${jobPostingId} not found`);
    }

    const row = jpResult.rows[0] as { talentum_project_id: string | null; is_draft: boolean };
    const talentumProjectId = row.talentum_project_id;
    if (!talentumProjectId) {
      throw new PublishError(400, 'Vacancy is not published on Talentum');
    }

    // Delete from Talentum
    try {
      const talentumClient = await TalentumApiClient.create();
      await talentumClient.deletePrescreening(talentumProjectId);
    } catch (err: unknown) {
      throw new PublishError(502, `Talentum API error (delete): ${(err as Error).message}`);
    }

    // Clear columns + audit DRAFT_CHANGED (CA-4.5)
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE job_postings
         SET talentum_project_id   = NULL,
             talentum_public_id    = NULL,
             talentum_whatsapp_url = NULL,
             talentum_slug         = NULL,
             talentum_published_at = NULL,
             is_draft              = true,
             updated_at            = NOW()
         WHERE id = $1`,
        [jobPostingId],
      );

      // Audit best-effort via SAVEPOINT — FK failure rolls back only the INSERT,
      // leaving the surrounding transaction (and the UPDATE above) intact.
      if (actor) {
        await this.auditRepo.logEventSafe(client, {
          jobPostingId,
          eventType: 'DRAFT_CHANGED',
          fieldName: 'is_draft',
          changes: { before: row.is_draft, after: true },
          actorUserId: actor.actorUserId,
          actorType: actor.actorType,
          actorLabel: actor.actorLabel,
          traceId: actor.traceId ?? null,
        });
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    console.log(
      `[PublishVacancy] Unpublished vacancy ${jobPostingId} (Talentum project ${talentumProjectId})`,
    );
  }
}

// ─────────────────────────────────────────────────────────────────
// Custom error with HTTP status
// ─────────────────────────────────────────────────────────────────

export class PublishError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}
