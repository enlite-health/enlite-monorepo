/**
 * AiPromptSlug — os três identificadores fechados de prompt de IA editável (spec 029).
 *
 * Fechado nos DOIS lados, como manda `data-model.md`: esta união de tipos no domínio e o
 * `CHECK (slug IN (...))` da tabela `ai_prompts` (migration 485). Tipo novo = migration que
 * alarga o `CHECK` + alarga esta união — nunca um dos dois sozinho (mesmo padrão de
 * `AccountType.ACCOUNT_TYPES`/D294).
 */
export const AI_PROMPT_SLUGS = ['VACANCY_DESCRIPTION', 'PRESCREENING_AT', 'PRESCREENING_CAREGIVER'] as const;

export type AiPromptSlug = (typeof AI_PROMPT_SLUGS)[number];

export function isAiPromptSlug(value: unknown): value is AiPromptSlug {
  return typeof value === 'string' && (AI_PROMPT_SLUGS as readonly string[]).includes(value);
}
