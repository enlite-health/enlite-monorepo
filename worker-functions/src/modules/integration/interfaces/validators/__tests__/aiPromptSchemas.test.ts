import {
  aiPromptSlugParamsSchema,
  updateAiPromptBodySchema,
  undoAiPromptBodySchema,
  restoreAiPromptBodySchema,
  previewAiPromptBodySchema,
} from '../aiPromptSchemas';
import { AI_PROMPT_SLUGS } from '../../../domain/AiPromptSlug';

const UUID = '11111111-1111-4111-8111-111111111111';

describe('aiPromptSchemas — a borda (spec 029)', () => {
  it('slug: aceita os três valores fechados de AI_PROMPT_SLUGS e recusa qualquer outro', () => {
    for (const slug of AI_PROMPT_SLUGS) {
      expect(aiPromptSlugParamsSchema.safeParse({ slug }).success).toBe(true);
    }
    expect(aiPromptSlugParamsSchema.safeParse({ slug: 'OUTRO_PROMPT' }).success).toBe(false);
    expect(aiPromptSlugParamsSchema.safeParse({ slug: '' }).success).toBe(false);
    expect(aiPromptSlugParamsSchema.safeParse({}).success).toBe(false);
  });

  it('🔒 PUT body: recusa vazio e só espaços em branco', () => {
    expect(updateAiPromptBodySchema.safeParse({ body: 'texto do prompt', version: 7 }).success).toBe(true);
    expect(updateAiPromptBodySchema.safeParse({ body: '', version: 7 }).success).toBe(false);
    expect(updateAiPromptBodySchema.safeParse({ body: '   ', version: 7 }).success).toBe(false);
    expect(updateAiPromptBodySchema.safeParse({ version: 7 }).success).toBe(false);
  });

  it('PUT version: exige inteiro; recusa decimal e string não numérica', () => {
    expect(updateAiPromptBodySchema.safeParse({ body: 'x', version: 7 }).success).toBe(true);
    expect(updateAiPromptBodySchema.safeParse({ body: 'x', version: 7.5 }).success).toBe(false);
    expect(updateAiPromptBodySchema.safeParse({ body: 'x', version: '7' }).success).toBe(false);
    expect(updateAiPromptBodySchema.safeParse({ body: 'x', version: 'sete' }).success).toBe(false);
    expect(updateAiPromptBodySchema.safeParse({ body: 'x' }).success).toBe(false);
  });

  it('PUT body: campo extra é recusado (.strict())', () => {
    expect(updateAiPromptBodySchema.safeParse({ body: 'x', version: 7, slug: 'VACANCY_DESCRIPTION' }).success).toBe(false);
  });

  it('undo: exige version inteiro; sem alvo (só version no corpo)', () => {
    expect(undoAiPromptBodySchema.safeParse({ version: 7 }).success).toBe(true);
    expect(undoAiPromptBodySchema.safeParse({ version: 7.5 }).success).toBe(false);
    expect(undoAiPromptBodySchema.safeParse({ version: '7' }).success).toBe(false);
    expect(undoAiPromptBodySchema.safeParse({}).success).toBe(false);
    expect(undoAiPromptBodySchema.safeParse({ version: 7, auditId: UUID }).success).toBe(false);
  });

  it('restore: exige auditId (uuid) e version inteiro', () => {
    expect(restoreAiPromptBodySchema.safeParse({ auditId: UUID, version: 7 }).success).toBe(true);
    expect(restoreAiPromptBodySchema.safeParse({ auditId: 'não-uuid', version: 7 }).success).toBe(false);
    expect(restoreAiPromptBodySchema.safeParse({ version: 7 }).success).toBe(false);
    expect(restoreAiPromptBodySchema.safeParse({ auditId: UUID, version: 7.5 }).success).toBe(false);
  });

  it('🔒 preview body: recusa vazio e só espaços; exige jobPostingId UUID (caso real, não scenarioId)', () => {
    const uuid = '3f2b1c9e-8d4a-4e6b-9a1f-0c5d7e2a4b61';
    expect(previewAiPromptBodySchema.safeParse({ body: 'texto em edição', jobPostingId: uuid }).success).toBe(true);
    expect(previewAiPromptBodySchema.safeParse({ body: '   ', jobPostingId: uuid }).success).toBe(false);
    expect(previewAiPromptBodySchema.safeParse({ body: '', jobPostingId: uuid }).success).toBe(false);
    expect(previewAiPromptBodySchema.safeParse({ body: 'x', jobPostingId: 'nao-e-uuid' }).success).toBe(false);
    expect(previewAiPromptBodySchema.safeParse({ body: 'x' }).success).toBe(false);
    expect(previewAiPromptBodySchema.safeParse({ body: 'x', scenarioId: 'AT_NIGHT_SHIFT' }).success).toBe(false);
  });
});
