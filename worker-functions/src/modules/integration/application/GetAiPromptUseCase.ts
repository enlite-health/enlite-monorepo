import { AiPromptRepository } from '../infrastructure/AiPromptRepository';
import type { AiPrompt } from '../infrastructure/AiPromptRepository';
import { isAiPromptSlug } from '../domain/AiPromptSlug';

export interface GetAiPromptResult {
  found: true;
  prompt: AiPrompt;
}

export interface GetAiPromptNotFound {
  found: false;
}

export type GetAiPromptOutput = GetAiPromptResult | GetAiPromptNotFound;

/**
 * GetAiPromptUseCase — leitura de prompts de IA editáveis (spec 029, T009).
 *
 * Cobre as duas leituras do contrato (`contracts/admin-ai-prompts.md`):
 *   - `execute(slug)`  → `GET /api/admin/ai-prompts/{slug}` (um registro)
 *   - `list()`         → `GET /api/admin/ai-prompts` (os três registros)
 *
 * `execute` recebe `slug` como `string` crua (não `AiPromptSlug`) de propósito: o contrato exige
 * **404, não 400**, tanto para identificador fora do conjunto fechado (`AI_PROMPT_SLUGS`) quanto
 * para slug válido sem linha na tabela — as duas causas colapsam no mesmo `{ found: false }`,
 * porque para quem chama a rota "não existe" é o mesmo caso nos dois. Se o tipo de entrada fosse
 * `AiPromptSlug`, o TypeScript não deixaria representar "identificador desconhecido" para testar.
 *
 * Zero lógica de negócio — só orquestração, mesmo padrão de `GetPatientByIdUseCase`.
 */
export class GetAiPromptUseCase {
  private readonly repo: AiPromptRepository;

  constructor(repo?: AiPromptRepository) {
    this.repo = repo ?? new AiPromptRepository();
  }

  async execute(slug: string): Promise<GetAiPromptOutput> {
    if (!isAiPromptSlug(slug)) {
      return { found: false };
    }

    const prompt = await this.repo.findBySlug(slug);
    if (prompt === null) {
      return { found: false };
    }

    return { found: true, prompt };
  }

  async list(): Promise<AiPrompt[]> {
    return this.repo.listAll();
  }
}
