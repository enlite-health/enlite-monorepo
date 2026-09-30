/**
 * AiPromptSlug — o conjunto fechado dos três identificadores (spec 029, T006).
 */
import { AI_PROMPT_SLUGS, isAiPromptSlug } from '../AiPromptSlug';

describe('isAiPromptSlug', () => {
  it.each(AI_PROMPT_SLUGS)('aceita o identificador %s', (slug) => {
    expect(isAiPromptSlug(slug)).toBe(true);
  });

  it('recusa um valor desconhecido', () => {
    expect(isAiPromptSlug('VACANCY_TITLE')).toBe(false);
    expect(isAiPromptSlug('')).toBe(false);
  });

  it('recusa valor que difere só por caixa', () => {
    expect(isAiPromptSlug('vacancy_description')).toBe(false);
  });

  it('recusa valor que difere só por espaço', () => {
    expect(isAiPromptSlug('VACANCY_DESCRIPTION ')).toBe(false);
    expect(isAiPromptSlug(' PRESCREENING_AT')).toBe(false);
  });

  it('recusa tipos que não são string', () => {
    expect(isAiPromptSlug(null)).toBe(false);
    expect(isAiPromptSlug(undefined)).toBe(false);
    expect(isAiPromptSlug(42)).toBe(false);
  });

  it('AI_PROMPT_SLUGS tem exatamente os três identificadores da spec', () => {
    expect(AI_PROMPT_SLUGS).toEqual(['VACANCY_DESCRIPTION', 'PRESCREENING_AT', 'PRESCREENING_CAREGIVER']);
  });
});
