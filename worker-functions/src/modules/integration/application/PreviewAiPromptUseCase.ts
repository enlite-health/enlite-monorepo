/**
 * PreviewAiPromptUseCase — spec 029 T030.
 *
 * Mostra o que um prompt AINDA NÃO SALVO produziria para UM CASO REAL, sem gravar e sem publicar.
 * Não monta payload próprio: delega aos MESMOS geradores da produção, passando o texto em edição
 * como override opcional do corpo do prompt (uma cópia da montagem divergiria em silêncio).
 *
 * Invariantes: não escreve em `job_postings`, `job_posting_audit_log`, tabelas de prescreening,
 * `ai_prompts` nem trilha; não chama o Talentum. A única leitura própria é um SELECT do caso
 * (mesmo de `VacancyTalentumController`), somente-leitura.
 */
import type { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  TalentumDescriptionService,
  JobPostingNotFoundError,
} from '../infrastructure/TalentumDescriptionService';
import {
  GeminiVacancyParserService,
  type WorkerType,
} from '../infrastructure/GeminiVacancyParserService';
import type { AiPromptSlug } from '../domain/AiPromptSlug';

/** `body` vazio ou só espaços — o controller traduz em 400. */
export class PreviewEmptyBodyError extends Error {
  constructor() {
    super('Preview body must not be empty');
    this.name = 'PreviewEmptyBodyError';
  }
}

export { JobPostingNotFoundError };

export interface PreviewAiPromptInput {
  slug: AiPromptSlug;
  body: string;
  jobPostingId: string;
}

export interface PreviewAiPromptOutput {
  jobPostingId: string;
  slug: AiPromptSlug;
  generated: string;
}

/** O workerType vem do slug, nunca de fora (espelha GeminiVacancyParserService.buildSystemPrompt). */
const WORKER_TYPE_BY_SLUG: Record<Exclude<AiPromptSlug, 'VACANCY_DESCRIPTION'>, WorkerType> = {
  PRESCREENING_AT: 'AT',
  PRESCREENING_CAREGIVER: 'CUIDADOR',
};

export class PreviewAiPromptUseCase {
  private readonly db: Pool;
  private readonly descService: TalentumDescriptionService;
  private readonly parserService: GeminiVacancyParserService;

  constructor(deps?: {
    db?: Pool;
    descService?: TalentumDescriptionService;
    parserService?: GeminiVacancyParserService;
  }) {
    this.db = deps?.db ?? DatabaseConnection.getInstance().getPool();
    this.descService = deps?.descService ?? new TalentumDescriptionService();
    this.parserService = deps?.parserService ?? new GeminiVacancyParserService();
  }

  async execute(input: PreviewAiPromptInput): Promise<PreviewAiPromptOutput> {
    const { slug, body, jobPostingId } = input;
    if (!body || body.trim().length === 0) {
      throw new PreviewEmptyBodyError();
    }

    if (slug === 'VACANCY_DESCRIPTION') {
      const composed = await this.descService.composeDescription(jobPostingId, body);
      return { jobPostingId, slug, generated: composed.description };
    }

    const workerType = WORKER_TYPE_BY_SLUG[slug];
    const { vacancy, patient, address } = await this.loadCase(jobPostingId);
    const parsed = await this.parserService.generateFromVacancyData(
      vacancy,
      patient,
      address,
      workerType,
      body,
    );
    return { jobPostingId, slug, generated: JSON.stringify(parsed.prescreening, null, 2) };
  }

  /** Mesma consulta e mesmo mapeamento de VacancyTalentumController (somente-leitura). */
  private async loadCase(jobPostingId: string) {
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
      [jobPostingId],
    );
    if (result.rows.length === 0) {
      throw new JobPostingNotFoundError(jobPostingId);
    }
    const row = result.rows[0];
    return {
      vacancy: {
        title: row.title, case_number: row.case_number,
        required_professions: row.required_professions, required_sex: row.required_sex,
        age_range_min: row.age_range_min, age_range_max: row.age_range_max,
        required_experience: row.required_experience, worker_attributes: row.worker_attributes,
        schedule: row.schedule, work_schedule: row.work_schedule,
        providers_needed: row.providers_needed, salary_text: row.salary_text,
        payment_day: row.payment_day, daily_obs: row.daily_obs,
      },
      patient: { diagnosis: row.diagnosis, dependency_level: row.dependency_level, service_type: row.service_type },
      address: { address_formatted: row.address_formatted, city: row.city, state: row.state },
    };
  }
}
