import { describe, it, expect } from 'vitest';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { AI_PROMPT_TABS, AI_PROMPT_TAB_I18N_KEYS, type AiPromptTab } from '../aiPromptTabs';

/** Desce um objeto por uma chave pontuada (`a.b.c`), igual à resolução do i18next. */
function resolveKey(obj: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, obj);
}

describe('aiPromptTabs — lista das 3 abas fechadas + mapa de chaves i18n', () => {
  it('tem exatamente os três identificadores fechados do backend, nesta ordem', () => {
    expect(AI_PROMPT_TABS).toEqual(['VACANCY_DESCRIPTION', 'PRESCREENING_AT', 'PRESCREENING_CAREGIVER']);
  });

  it('não tem abas duplicadas', () => {
    expect(new Set(AI_PROMPT_TABS).size).toBe(AI_PROMPT_TABS.length);
  });

  it('todas as abas de AI_PROMPT_TABS têm entrada em AI_PROMPT_TAB_I18N_KEYS', () => {
    for (const tab of AI_PROMPT_TABS) {
      expect(AI_PROMPT_TAB_I18N_KEYS[tab]).toBeTruthy();
    }
  });

  it('o mapa não tem chave sobrando além das três abas', () => {
    expect(Object.keys(AI_PROMPT_TAB_I18N_KEYS).sort()).toEqual([...AI_PROMPT_TABS].sort());
  });

  it.each(AI_PROMPT_TABS)('a chave i18n de %s começa em admin.aiPrompts.tabs.', (tab: AiPromptTab) => {
    expect(AI_PROMPT_TAB_I18N_KEYS[tab].startsWith('admin.aiPrompts.tabs.')).toBe(true);
  });

  it.each(AI_PROMPT_TABS)('a chave de %s resolve para um texto não vazio em es.json', (tab: AiPromptTab) => {
    const value = resolveKey(esJson, AI_PROMPT_TAB_I18N_KEYS[tab]);
    expect(typeof value).toBe('string');
    expect((value as string).length).toBeGreaterThan(0);
  });

  it.each(AI_PROMPT_TABS)('a chave de %s resolve para um texto não vazio em pt-BR.json', (tab: AiPromptTab) => {
    const value = resolveKey(ptBRJson, AI_PROMPT_TAB_I18N_KEYS[tab]);
    expect(typeof value).toBe('string');
    expect((value as string).length).toBeGreaterThan(0);
  });
});
