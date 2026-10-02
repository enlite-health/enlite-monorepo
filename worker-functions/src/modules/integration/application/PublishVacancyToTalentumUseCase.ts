/**
 * PublishVacancyToTalentumUseCase
 *
 * Orchestrates: generate description (Groq) → create prescreening (Talentum API v2: o `create` já
 * publica — complete-submodule + init) → fetch o link WEB (`https://www.v2.talentum.chat/public/pre-screening/<publicId>/chat`,
 * gravado em `talentum_whatsapp_url`; nome do campo mantido, decisão (a)) → save references in job_postings.
 *
 * Also handles unpublishing (delete from Talentum + clear DB columns).
 *
 * Onda B: publish/unpublish accept an optional `actor` param for audit logging.
 * Audit rows are inserted INSIDE the existing transaction via logEventSafe (SAVEPOINT).
 * If the audit INSERT fails, only the audit row is rolled back — the surrounding
 * transaction (UPDATE job_postings) is NOT affected and always commits.
 *
 * 7. Pós-commit: `onVacancyLaunched` (paciente do funil → Búsqueda).
 */

import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { reportError } from '@shared/logging';
import { TalentumDescriptionService } from '../infrastructure/TalentumDescriptionService';
import { TalentumApiClient } from '../infrastructure/TalentumApiClient';
import { DEAD_PROJECT_MESSAGE, isDeadProjectError } from '../domain/talentumErrors';
import type { TalentumQuestion } from '../domain/ITalentumApiClient';
import { normalizePrescreeningResponseType } from '@shared/utils/normalizePrescreeningResponseType';
import {
  JobPostingAuditRepository,
  type AuditActorType,
} from '../../matching/infrastructure/JobPostingAuditRepository';
// DX-6.1: chamado DEPOIS do commit do envio (nunca antes). `onVacancyLaunched` nunca lança
// (DX-6.2) — o catch abaixo é a 2ª trava, não o contrato do gancho.
import { onVacancyLaunched } from '../../case/application/VacancyLaunchHook';

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
  private launchHook: (jobPostingId: string) => Promise<unknown>;

  constructor(launchHook: (jobPostingId: string) => Promise<unknown> = onVacancyLaunched) {
    this.db = DatabaseConnection.getInstance().getPool();
    this.auditRepo = new JobPostingAuditRepository();
    this.launchHook = launchHook;
  }

  /**
   * Publishes a vacancy to Talentum.
   *
   * Steps:
   *  1. Load vacancy + validate state
   *  2. Generate description via Groq if missing
   *  3. Load prescreening questions from DB (FAQ não vai: a v2 não tem — decisão (g))
   *  4. Create prescreening project on Talentum
   *  5. GET the project to obtain the web link (derivado do publicId, nunca wa.me) + slug
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
      // Ticket 86ajfm80t: envia o formato configurado (respeita só-texto
      // deliberado); default seguro ['text','audio'] quando o dado é nulo/vazio.
      responseType: normalizePrescreeningResponseType(row.response_type),
      desiredResponse: row.desired_response,
      weight: row.weight,
      required: row.required,
      analyzed: row.analyzed,
      earlyStoppage: row.early_stoppage,
    }));

    // FAQ: a Talentum v2 não tem FAQ (spec 040, decisão (g)) — ela fica SÓ no nosso banco
    // (`job_posting_prescreening_faq`); não é lida aqui nem enviada ao create.

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

    // invariante 7 (D434): o lançamento é o envio aceito — pós-commit, idempotente. O gancho
    // não lança por contrato (DX-6.2); este catch é a 2ª trava: o envio JÁ está commitado e na
    // Talentum — devolver 500 aqui faria o operador tentar de novo e levar 409.
    try {
      await this.launchHook(jobPostingId);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      reportError(error, { source: 'PublishVacancyToTalentumUseCase:launchHook' });
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
      // Spec 040: id gravado antes da migração para a v2 → 404. Erro claro, não um 502 mudo.
      if (isDeadProjectError(err)) {
        throw new PublishError(409, DEAD_PROJECT_MESSAGE);
      }
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
