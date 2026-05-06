import { Request, Response } from 'express';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  PublishVacancyToTalentumUseCase,
  PublishError,
  SyncTalentumVacanciesUseCase,
  TalentumDescriptionService,
  GeminiVacancyParserService,
} from '@modules/integration';

/**
 * VacancyTalentumController
 *
 * Talentum integration + prescreening configuration endpoints.
 * Split from VacanciesController to respect the 400-line limit.
 */
export class VacancyTalentumController {
  private db: Pool;

  constructor() {
    this.db = DatabaseConnection.getInstance().getPool();
  }

  async publishToTalentum(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const useCase = new PublishVacancyToTalentumUseCase();
      const result = await useCase.publish({ jobPostingId: id });
      res.status(200).json({ success: true, data: result });
    } catch (error: any) {
      if (error instanceof PublishError) {
        res.status(error.statusCode).json({ success: false, error: error.message });
        return;
      }
      console.error('[VacancyTalentum] Error publishing to Talentum:', error);
      res.status(500).json({ success: false, error: 'Failed to publish to Talentum', details: error.message });
    }
  }

  async unpublishFromTalentum(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const useCase = new PublishVacancyToTalentumUseCase();
      await useCase.unpublish({ jobPostingId: id });
      res.status(200).json({ success: true, message: 'Vacancy unpublished from Talentum' });
    } catch (error: any) {
      if (error instanceof PublishError) {
        res.status(error.statusCode).json({ success: false, error: error.message });
        return;
      }
      console.error('[VacancyTalentum] Error unpublishing from Talentum:', error);
      res.status(500).json({ success: false, error: 'Failed to unpublish from Talentum', details: error.message });
    }
  }

  async generateTalentumDescription(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const descService = new TalentumDescriptionService();
      const result = await descService.generateDescription(id);
      res.status(200).json({ success: true, data: { description: result.description } });
    } catch (error: any) {
      console.error('[VacancyTalentum] Error generating Talentum description:', error);
      res.status(500).json({ success: false, error: 'Failed to generate description', details: error.message });
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
          [id]
        ),
        this.db.query(
          `SELECT id, question, answer, faq_order
           FROM job_posting_prescreening_faq
           WHERE job_posting_id = $1
           ORDER BY faq_order ASC`,
          [id]
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
    } catch (error: any) {
      console.error('[VacancyTalentum] Error fetching prescreening config:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch prescreening config', details: error.message });
    }
  }

  async syncFromTalentum(req: Request, res: Response): Promise<void> {
    try {
      const force = req.query.force === 'true';
      const useCase = new SyncTalentumVacanciesUseCase();
      const report = await useCase.execute({ force });
      res.status(200).json({ success: true, data: report });
    } catch (error: any) {
      const isTalentumError = error.message?.includes('Talentum') || error.message?.includes('tl_auth');
      const status = isTalentumError ? 502 : 500;
      const label = isTalentumError ? 'Talentum communication' : 'sync';
      console.error(`[VacancyTalentum] Error in syncFromTalentum:`, error);
      res.status(status).json({ success: false, error: `Failed ${label}`, details: error.message });
    }
  }

  /**
   * POST /api/admin/vacancies/:id/generate-ai-content
   *
   * Generates Talentum description + prescreening questions + FAQ for the given
   * vacancy using the existing AI services. Does NOT persist anything — the
   * caller is responsible for saving via savePrescreeningConfig.
   */
  async generateAIContent(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      // 1. Load vacancy + patient + address (read-only)
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
        title: row.title,
        case_number: row.case_number,
        required_professions: row.required_professions,
        required_sex: row.required_sex,
        age_range_min: row.age_range_min,
        age_range_max: row.age_range_max,
        required_experience: row.required_experience,
        worker_attributes: row.worker_attributes,
        schedule: row.schedule,
        work_schedule: row.work_schedule,
        providers_needed: row.providers_needed,
        salary_text: row.salary_text,
        payment_day: row.payment_day,
        daily_obs: row.daily_obs,
      };

      const patientData = {
        diagnosis: row.diagnosis,
        dependency_level: row.dependency_level,
        service_type: row.service_type,
      };

      const addressData = {
        address_formatted: row.address_formatted,
        city: row.city,
        state: row.state,
      };

      // 2. Generate description (without persisting)
      const descService = new TalentumDescriptionService();
      const descResult = await descService.generateDescriptionPreview(id);

      // 3. Generate prescreening questions + FAQ
      const geminiService = new GeminiVacancyParserService();
      const professions: string[] = vacancyData.required_professions ?? [];
      const workerType = professions.includes('CUIDADOR') ? 'CUIDADOR' : 'AT';
      const prescreeningResult = await geminiService.generateFromVacancyData(
        vacancyData,
        patientData,
        addressData,
        workerType,
      );

      // 4. Return without persisting
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
    } catch (error: any) {
      console.error('[VacancyTalentum] Error generating AI content:', error);
      res.status(500).json({
        success: false,
        error: 'Failed to generate AI content',
        details: error.message,
      });
    }
  }

  async savePrescreeningConfig(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { questions = [], faq = [] } = req.body;

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (!q.question || typeof q.question !== 'string' || q.question.trim() === '') {
          res.status(400).json({ success: false, error: `questions[${i}].question is required and must be non-empty` });
          return;
        }
        if (!q.desiredResponse || typeof q.desiredResponse !== 'string' || q.desiredResponse.trim() === '') {
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
          const q = questions[i];
          await client.query(
            `INSERT INTO job_posting_prescreening_questions
               (job_posting_id, question_order, question, response_type, desired_response,
                weight, required, analyzed, early_stoppage)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              id, i + 1, q.question.trim(),
              q.responseType ?? ['text', 'audio'],
              q.desiredResponse.trim(),
              Number(q.weight),
              q.required ?? false,
              q.analyzed ?? true,
              q.earlyStoppage ?? false,
            ]
          );
        }

        for (let i = 0; i < faq.length; i++) {
          const f = faq[i];
          await client.query(
            `INSERT INTO job_posting_prescreening_faq
               (job_posting_id, faq_order, question, answer)
             VALUES ($1, $2, $3, $4)`,
            [id, i + 1, f.question?.trim() ?? '', f.answer?.trim() ?? '']
          );
        }

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
           FROM job_posting_prescreening_questions
           WHERE job_posting_id = $1
           ORDER BY question_order ASC`,
          [id]
        ),
        this.db.query(
          `SELECT id, question, answer, faq_order
           FROM job_posting_prescreening_faq
           WHERE job_posting_id = $1
           ORDER BY faq_order ASC`,
          [id]
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
            id: row.id, question: row.question,
            answer: row.answer, faqOrder: row.faq_order,
          })),
        },
      });
    } catch (error: any) {
      console.error('[VacancyTalentum] Error saving prescreening config:', error);
      res.status(500).json({ success: false, error: 'Failed to save prescreening config', details: error.message });
    }
  }
}
