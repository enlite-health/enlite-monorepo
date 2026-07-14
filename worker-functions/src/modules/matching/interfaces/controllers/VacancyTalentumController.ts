import { Request, Response } from 'express';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  PublishVacancyToTalentumUseCase,
  PublishError,
  SyncTalentumVacanciesUseCase,
  TalentumDescriptionService,
  GeminiVacancyParserService,
  GeminiApiError,
} from '@modules/integration';
import { loggingAls, reportError } from '@shared/logging';
import {
  JobPostingAuditRepository,
} from '../../infrastructure/JobPostingAuditRepository';
import type { AuditActor } from '@modules/integration';
import { getVacancyTalentumStatus } from './vacancyTalentumStatusHelper';
import { normalizePrescreeningResponseType } from '@shared/utils/normalizePrescreeningResponseType';

/**
 * VacancyTalentumController
 *
 * Talentum integration + prescreening configuration endpoints.
 * Split from VacanciesController to respect the 400-line limit.
 *
 * Onda B: publishToTalentum / unpublishFromTalentum pass actor to use case.
 * savePrescreeningConfig audits UPDATED (prescreening_config) best-effort.
 */
export class VacancyTalentumController {
  private db: Pool;
  private auditRepo: JobPostingAuditRepository;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
    this.auditRepo = new JobPostingAuditRepository();
  }

  /** Builds an AuditActor from an authenticated admin request. */
  private extractActor(req: Request): AuditActor {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = (req as any).user as { uid?: string } | undefined;
    return {
      actorUserId: user?.uid ?? null,
      actorType: 'HUMAN',
      actorLabel: 'admin_panel',
      traceId: loggingAls.getStore()?.traceId ?? null,
    };
  }

  /**
   * Maps an AI-generation failure to an HTTP response. A transient Gemini
   * error (429 DSQ/quota or 5xx overload) is surfaced as a retryable 503.
   */
  private respondAIError(res: Response, error: unknown, fallbackError: string): void {
    if (error instanceof GeminiApiError && error.isTransient) {
      res.status(503).json({
        success: false,
        error:
          'El servicio de IA está temporalmente sobrecargado. ' +
          'Esperá unos segundos y volvé a intentar.',
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: fallbackError,
      details: error instanceof Error ? error.message : String(error),
    });
  }

  async publishToTalentum(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const actor = this.extractActor(req);
      const useCase = new PublishVacancyToTalentumUseCase();
      const result = await useCase.publish({ jobPostingId: id }, actor);
      res.status(200).json({ success: true, data: result });
    } catch (error: unknown) {
      if (error instanceof PublishError) {
        res.status(error.statusCode).json({ success: false, error: error.message });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      reportError(error instanceof Error ? error : new Error(msg), { source: 'VacancyTalentumController:publishToTalentum' });
      res.status(500).json({ success: false, error: 'Failed to publish to Talentum', details: msg });
    }
  }

  async unpublishFromTalentum(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const actor = this.extractActor(req);
      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.unpublish({ jobPostingId: id }, actor);
      res.status(200).json({ success: true, message: 'Vacancy unpublished from Talentum' });
    } catch (error: unknown) {
      if (error instanceof PublishError) {
        res.status(error.statusCode).json({ success: false, error: error.message });
        return;
      }
      const msg = error instanceof Error ? error.message : String(error);
      reportError(error instanceof Error ? error : new Error(msg), { source: 'VacancyTalentumController:unpublishFromTalentum' });
      res.status(500).json({ success: false, error: 'Failed to unpublish from Talentum', details: msg });
    }
  }

  /**
   * GET /api/admin/vacancies/:id/talentum-status
   *
   * Verifica se a vaga está realmente publicada no Talentum (fonte de
   * verdade externa), não apenas se `talentum_project_id` está preenchido
   * no nosso banco. Usado pelo E2E para provar publish/unpublish.
   * Lógica delegada a vacancyTalentumStatusHelper (limite de 400 linhas).
   */
  async getTalentumStatus(req: Request, res: Response): Promise<void> {
    const { id } = req.params;
    const result = await getVacancyTalentumStatus(this.db, id);

    if (result.kind === 'not_found') {
      res.status(404).json({ success: false, error: 'Vacancy not found' });
      return;
    }
    if (result.kind === 'error') {
      reportError(new Error(result.message), { source: 'VacancyTalentumController:getTalentumStatus', vacancyId: id });
      res.status(502).json({ success: false, error: 'Failed to check Talentum status', details: result.message });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        published: result.published,
        exists: result.exists,
        ...(result.whatsappUrl ? { whatsappUrl: result.whatsappUrl } : {}),
        ...(result.audioEnabled !== undefined ? { audioEnabled: result.audioEnabled } : {}),
      },
    });
  }

  async generateTalentumDescription(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const actor = this.extractActor(req);
      const descService = new TalentumDescriptionService();
      const result = await descService.generateDescription(id, actor);
      res.status(200).json({ success: true, data: { description: result.description } });
    } catch (error: unknown) {
      reportError(error instanceof Error ? error : new Error(String(error)), { source: 'VacancyTalentumController:generateTalentumDescription' });
      this.respondAIError(res, error, 'Failed to generate description');
    }
  }

  async getPrescreeningConfig(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const [questionsResult, faqResult] = await Promise.all([
        this.db.query(
          `SELECT id, question, response_type, desired_response, weight,
                  required, analyzed, early_stoppage, question_order
           FROM job_posting_prescreening_questions
           WHERE job_posting_id = $1
           ORDER BY question_order ASC`,
          [id],
        ),
        this.db.query(
          `SELECT id, question, answer, faq_order
           FROM job_posting_prescreening_faq
           WHERE job_posting_id = $1
           ORDER BY faq_order ASC`,
          [id],
        ),
      ]);

      const questions = questionsResult.rows.map(row => ({
        id: row.id,
        question: row.question,
        responseType: row.response_type,
        desiredResponse: row.desired_response,
        weight: row.weight,
        required: row.required,
        analyzed: row.analyzed,
        earlyStoppage: row.early_stoppage,
        questionOrder: row.question_order,
      }));

      const faq = faqResult.rows.map(row => ({
        id: row.id,
        question: row.question,
        answer: row.answer,
        faqOrder: row.faq_order,
      }));

      res.status(200).json({ success: true, data: { questions, faq } });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(error instanceof Error ? error : new Error(msg), { source: 'VacancyTalentumController:getPrescreeningConfig' });
      res.status(500).json({ success: false, error: 'Failed to fetch prescreening config', details: msg });
    }
  }

  async syncFromTalentum(req: Request, res: Response): Promise<void> {
    try {
      const force = req.query.force === 'true';
      const useCase = new SyncTalentumVacanciesUseCase();
      const report = await useCase.execute({ force });
      res.status(200).json({ success: true, data: report });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      const isTalentumError = msg.includes('Talentum') || msg.includes('tl_auth');
      const status = isTalentumError ? 502 : 500;
      const label = isTalentumError ? 'Talentum communication' : 'sync';
      reportError(error instanceof Error ? error : new Error(msg), { source: 'VacancyTalentumController:syncFromTalentum' });
      res.status(status).json({ success: false, error: `Failed ${label}`, details: msg });
    }
  }

  /**
   * POST /api/admin/vacancies/:id/generate-ai-content
   * Generates description + prescreening without persisting.
   */
  async generateAIContent(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const result = await this.db.query(
        `SELECT
           jp.id, jp.title, jp.case_number, jp.required_professions, jp.required_sex,
           jp.age_range_min, jp.age_range_max, jp.required_experience, jp.worker_attributes,
           jp.schedule, jp.work_schedule, jp.providers_needed, jp.salary_text,
           jp.payment_day, jp.daily_obs,
           pa.address_formatted, pa.city, pa.state,
           p.diagnosis, p.dependency_level, p.service_type
         FROM job_postings jp
         LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
         LEFT JOIN patients p ON jp.patient_id = p.id
         WHERE jp.id = $1`,
        [id],
      );

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Vacancy not found' });
        return;
      }

      const row = result.rows[0];
      const vacancyData = {
        title: row.title, case_number: row.case_number,
        required_professions: row.required_professions, required_sex: row.required_sex,
        age_range_min: row.age_range_min, age_range_max: row.age_range_max,
        required_experience: row.required_experience, worker_attributes: row.worker_attributes,
        schedule: row.schedule, work_schedule: row.work_schedule,
        providers_needed: row.providers_needed, salary_text: row.salary_text,
        payment_day: row.payment_day, daily_obs: row.daily_obs,
      };
      const patientData = { diagnosis: row.diagnosis, dependency_level: row.dependency_level, service_type: row.service_type };
      const addressData = { address_formatted: row.address_formatted, city: row.city, state: row.state };

      const fastModel = process.env.GEMINI_MODEL_FAST ?? 'gemini-2.5-flash';
      const descService = new TalentumDescriptionService(fastModel);
      const geminiService = new GeminiVacancyParserService(fastModel);
      const professions: string[] = vacancyData.required_professions ?? [];
      const workerType = professions.includes('CUIDADOR') ? 'CUIDADOR' : 'AT';
      const [descResult, prescreeningResult] = await Promise.all([
        descService.generateDescriptionPreview(id),
        geminiService.generateFromVacancyData(vacancyData, patientData, addressData, workerType),
      ]);

      res.status(200).json({
        success: true,
        data: {
          description: descResult.description,
          prescreening: {
            questions: prescreeningResult.prescreening.questions,
            faq: prescreeningResult.prescreening.faq,
          },
        },
      });
    } catch (error: unknown) {
      reportError(error instanceof Error ? error : new Error(String(error)), { source: 'VacancyTalentumController:generateAIContent' });
      this.respondAIError(res, error, 'Failed to generate AI content');
    }
  }

  async savePrescreeningConfig(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { questions = [], faq = [] } = req.body as { questions: unknown[]; faq: unknown[] };
      const actor = this.extractActor(req);

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i] as Record<string, unknown>;
        if (!q.question || typeof q.question !== 'string' || (q.question as string).trim() === '') {
          res.status(400).json({ success: false, error: `questions[${i}].question is required and must be non-empty` });
          return;
        }
        if (!q.desiredResponse || typeof q.desiredResponse !== 'string' || (q.desiredResponse as string).trim() === '') {
          res.status(400).json({ success: false, error: `questions[${i}].desiredResponse is required and must be non-empty` });
          return;
        }
        const weight = Number(q.weight);
        if (!Number.isInteger(weight) || weight < 1 || weight > 10) {
          res.status(400).json({ success: false, error: `questions[${i}].weight must be an integer between 1 and 10` });
          return;
        }
      }

      const client = await this.db.connect();
      try {
        await client.query('BEGIN');
        await client.query(`DELETE FROM job_posting_prescreening_questions WHERE job_posting_id = $1`, [id]);
        await client.query(`DELETE FROM job_posting_prescreening_faq WHERE job_posting_id = $1`, [id]);

        for (let i = 0; i < questions.length; i++) {
          const q = questions[i] as Record<string, unknown>;
          await client.query(
            `INSERT INTO job_posting_prescreening_questions
               (job_posting_id, question_order, question, response_type, desired_response,
                weight, required, analyzed, early_stoppage)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              id, i + 1, (q.question as string).trim(),
              // Ticket 86ajfm80t: persiste a escolha da UI (switch áudio+texto
              // vs só-texto); default ['text','audio'] quando ausente/vazio.
              normalizePrescreeningResponseType(q.responseType),
              (q.desiredResponse as string).trim(),
              Number(q.weight), q.required ?? false, q.analyzed ?? true, q.earlyStoppage ?? false,
            ],
          );
        }
        for (let i = 0; i < faq.length; i++) {
          const f = faq[i] as Record<string, unknown>;
          await client.query(
            `INSERT INTO job_posting_prescreening_faq (job_posting_id, faq_order, question, answer)
             VALUES ($1, $2, $3, $4)`,
            [id, i + 1, (f.question as string | undefined)?.trim() ?? '', (f.answer as string | undefined)?.trim() ?? ''],
          );
        }

        // Audit best-effort via SAVEPOINT — FK failure rolls back only the INSERT,
        // leaving the surrounding transaction (and the DELETE+INSERTs above) intact.
        await this.auditRepo.logEventSafe(client, {
          jobPostingId: id,
          eventType: 'UPDATED',
          fieldName: 'prescreening_config',
          changes: { before: null, after: { questionsCount: questions.length, faqCount: faq.length } },
          actorUserId: actor.actorUserId,
          actorType: actor.actorType,
          actorLabel: actor.actorLabel,
          traceId: actor.traceId ?? null,
        });

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const [savedQuestions, savedFaq] = await Promise.all([
        this.db.query(
          `SELECT id, question, response_type, desired_response, weight,
                  required, analyzed, early_stoppage, question_order
           FROM job_posting_prescreening_questions WHERE job_posting_id = $1 ORDER BY question_order ASC`,
          [id],
        ),
        this.db.query(
          `SELECT id, question, answer, faq_order FROM job_posting_prescreening_faq
           WHERE job_posting_id = $1 ORDER BY faq_order ASC`,
          [id],
        ),
      ]);

      res.status(200).json({
        success: true,
        data: {
          questions: savedQuestions.rows.map(row => ({
            id: row.id, question: row.question, responseType: row.response_type,
            desiredResponse: row.desired_response, weight: row.weight,
            required: row.required, analyzed: row.analyzed,
            earlyStoppage: row.early_stoppage, questionOrder: row.question_order,
          })),
          faq: savedFaq.rows.map(row => ({
            id: row.id, question: row.question, answer: row.answer, faqOrder: row.faq_order,
          })),
        },
      });
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      reportError(error instanceof Error ? error : new Error(msg), { source: 'VacancyTalentumController:savePrescreeningConfig' });
      res.status(500).json({ success: false, error: 'Failed to save prescreening config', details: msg });
    }
  }
}
