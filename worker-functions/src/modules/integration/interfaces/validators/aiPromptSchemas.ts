import { z } from 'zod';
import { AI_PROMPT_SLUGS } from '../../domain/AiPromptSlug';

/**
 * aiPromptSchemas — a borda dos endpoints de prompts de IA editáveis (spec 029, contrato
 * `contracts/admin-ai-prompts.md`). O `slug` reusa a união fechada de `AiPromptSlug.ts` via
 * `z.enum` — nunca redigitada aqui (mesmo padrão de `THERAPEUTIC_MODALITIES` em
 * `therapeuticProjectSchemas.ts`, D294). Zod valida só FORMA; o 404 de slug desconhecido e o 409
 * de `version` divergente são do controlador/caso de uso, não daqui.
 */

/** Params de rota: `/api/admin/ai-prompts/{slug}` e as sub-rotas de undo/restore/preview/history. */
export const aiPromptSlugParamsSchema = z.object({
  slug: z.enum(AI_PROMPT_SLUGS),
});
export type AiPromptSlugParams = z.infer<typeof aiPromptSlugParamsSchema>;

/**
 * `PUT /api/admin/ai-prompts/{slug}` — grava conteúdo novo. `body` vazio ou só espaços é 400
 * (`.trim().min(1)`, mesmo padrão de `generalObjective`/`clinicalContext` em
 * `therapeuticProjectSchemas.ts`); `version` é a que o cliente leu, exigida como inteiro — o lock
 * otimista (409) é conferido no caso de uso, nunca aqui.
 */
export const updateAiPromptBodySchema = z
  .object({
    body: z.string().trim().min(1, { message: 'body must not be empty or whitespace' }),
    version: z.number().int({ message: 'version must be an integer' }),
  })
  .strict();
export type UpdateAiPromptBody = z.infer<typeof updateAiPromptBodySchema>;

/** `POST /api/admin/ai-prompts/{slug}/undo` — desfaz a última alteração; não recebe alvo. */
export const undoAiPromptBodySchema = z
  .object({
    version: z.number().int({ message: 'version must be an integer' }),
  })
  .strict();
export type UndoAiPromptBody = z.infer<typeof undoAiPromptBodySchema>;

/** `POST /api/admin/ai-prompts/{slug}/restore` — restaura um evento arbitrário do histórico. */
export const restoreAiPromptBodySchema = z
  .object({
    auditId: z.string().uuid(),
    version: z.number().int({ message: 'version must be an integer' }),
  })
  .strict();
export type RestoreAiPromptBody = z.infer<typeof restoreAiPromptBodySchema>;

/**
 * `POST /api/admin/ai-prompts/{slug}/preview` — gera exemplo sem salvar. `scenarioId` é um dos
 * cenários fictícios versionados no código (fora do escopo desta tarefa validar contra a lista;
 * T011 cobre só o schema de FORMA — conferir a lista fechada é do controlador/caso de uso).
 */
export const previewAiPromptBodySchema = z
  .object({
    body: z.string().trim().min(1, { message: 'body must not be empty or whitespace' }),
    scenarioId: z.string().min(1, { message: 'scenarioId must not be empty' }),
  })
  .strict();
export type PreviewAiPromptBody = z.infer<typeof previewAiPromptBodySchema>;
