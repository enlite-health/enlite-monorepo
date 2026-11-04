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
import { loadVacancyCase } from './loadVacancyCase';

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
    // Mesmo modelo da produção (VacancyTalentumController): o preview existe para "ver antes de
    // confiar" e não pode testar um modelo diferente do que gera a vacante real.
    const fastModel = process.env.GEMINI_MODEL_FAST ?? 'gemini-2.5-flash';
    this.descService = deps?.descService ?? new TalentumDescriptionService(fastModel);
    this.parserService = deps?.parserService ?? new GeminiVacancyParserService(fastModel);
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
    const { vacancy, patient, address } = await loadVacancyCase(this.db, jobPostingId);
    const parsed = await this.parserService.generateFromVacancyData(
      vacancy,
      patient,
      address,
      workerType,
      body,
    );
    return { jobPostingId, slug, generated: JSON.stringify(parsed.prescreening, null, 2) };
  }
}
