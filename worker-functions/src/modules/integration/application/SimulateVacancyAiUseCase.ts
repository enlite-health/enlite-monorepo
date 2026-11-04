/**
 * SimulateVacancyAiUseCase — spec 029 T071.
 *
 * Simula a CRIAÇÃO de uma vacante com os prompts em edição: roda a descrição e o pré-screening
 * juntos, como `VacancyTalentumController.generateAIContent` (mesmo modelo, mesma escolha de
 * prescreening pela VAGA, mesmo `Promise.all`), e devolve a estrutura que a tela mostra.
 *
 * Invariante: NÃO persiste nada. Só lê (SELECT do caso + leitura do prompt ativo quando o corpo em
 * edição não veio) e chama o modelo. Não chama o Talentum.
 *
 * O prescreening é escolhido pelas profissões da vaga (`CUIDADOR` → CAREGIVER, senão AT), nunca por
 * slug recebido. Consequência: se a vaga é de CUIDADOR, o corpo de `PRESCREENING_AT` recebido é
 * IGNORADO (e vice-versa) — `usedSlugs` diz à tela qual prompt foi de fato exercitado.
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

export { JobPostingNotFoundError };

export interface SimulateVacancyAiInput {
  jobPostingId: string;
  /** Corpos em edição (podem não estar salvos). Ausente = usa o prompt ativo da tabela. */
  bodies: Partial<Record<AiPromptSlug, string>>;
}

export interface SimulateVacancyAiOutput {
  description: string;
  prescreening: { questions: unknown[]; faq: unknown[] };
  workerType: WorkerType;
  /** Os dois prompts exercitados: VACANCY_DESCRIPTION + o de prescreening escolhido pela vaga. */
  usedSlugs: [AiPromptSlug, AiPromptSlug];
}

export class SimulateVacancyAiUseCase {
  private readonly db: Pool;
  private readonly descService: TalentumDescriptionService;
  private readonly parserService: GeminiVacancyParserService;

  constructor(deps?: {
    db?: Pool;
    descService?: TalentumDescriptionService;
    parserService?: GeminiVacancyParserService;
  }) {
    this.db = deps?.db ?? DatabaseConnection.getInstance().getPool();
    // Mesmo modelo da produção (VacancyTalentumController).
    const fastModel = process.env.GEMINI_MODEL_FAST ?? 'gemini-2.5-flash';
    this.descService = deps?.descService ?? new TalentumDescriptionService(fastModel);
    this.parserService = deps?.parserService ?? new GeminiVacancyParserService(fastModel);
  }

  async execute(input: SimulateVacancyAiInput): Promise<SimulateVacancyAiOutput> {
    const { jobPostingId, bodies } = input;
    const { vacancy, patient, address } = await loadVacancyCase(this.db, jobPostingId);

    // Espelha VacancyTalentumController.generateAIContent: a vaga decide, não o slug recebido.
    const professions: string[] = vacancy.required_professions ?? [];
    const workerType: WorkerType = professions.includes('CUIDADOR') ? 'CUIDADOR' : 'AT';
    const prescreeningSlug: AiPromptSlug =
      workerType === 'CUIDADOR' ? 'PRESCREENING_CAREGIVER' : 'PRESCREENING_AT';

    const [descResult, prescreeningResult] = await Promise.all([
      this.descService.composeDescription(jobPostingId, bodies.VACANCY_DESCRIPTION),
      this.parserService.generateFromVacancyData(
        vacancy,
        patient,
        address,
        workerType,
        bodies[prescreeningSlug],
      ),
    ]);

    return {
      description: descResult.description,
      prescreening: {
        questions: prescreeningResult.prescreening.questions,
        faq: prescreeningResult.prescreening.faq,
      },
      workerType,
      usedSlugs: ['VACANCY_DESCRIPTION', prescreeningSlug],
    };
  }
}
