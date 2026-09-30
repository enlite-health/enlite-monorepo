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
 * `POST /api/admin/ai-prompts/{slug}/preview` — gera exemplo sem salvar, para um CASO REAL
 * (decisão de 30/09: `jobPostingId`, não mais `scenarioId` fictício). Zod valida só FORMA; que o
 * caso exista (404) é do caso de uso.
 */
export const previewAiPromptBodySchema = z
  .object({
    body: z.string().trim().min(1, { message: 'body must not be empty or whitespace' }),
    jobPostingId: z.string().uuid({ message: 'jobPostingId must be a UUID' }),
  })
  .strict();
export type PreviewAiPromptBody = z.infer<typeof previewAiPromptBodySchema>;
