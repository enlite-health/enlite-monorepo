import { describe, it, expect } from 'vitest';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import es from '@infrastructure/i18n/locales/es.json';

const ptBRTabs = (ptBR as Record<string, any>).admin.vacancyDetail.tabs as Record<string, string>;
const esTabs = (es as Record<string, any>).admin.vacancyDetail.tabs as Record<string, string>;

const TAB_KEYS = ['encuadres', 'talentum', 'links', 'notes'];

// ── Key completeness ─────────────────────────────────────────────────────────

describe('VacancyDetail tabs i18n — key completeness', () => {
  it.each(TAB_KEYS)('es has translation for tabs.%s', (key) => {
    expect(esTabs[key]).toBeDefined();
    expect(esTabs[key].trim().length).toBeGreaterThan(0);
  });

  it.each(TAB_KEYS)('pt-BR has translation for tabs.%s', (key) => {
    expect(ptBRTabs[key]).toBeDefined();
    expect(ptBRTabs[key].trim().length).toBeGreaterThan(0);
  });
});

// ── Locale parity ────────────────────────────────────────────────────────────

describe('VacancyDetail tabs i18n — locale parity', () => {
  it('es and pt-BR have the same set of tab keys', () => {
    const esKeySet = new Set(Object.keys(esTabs));
    const ptBRKeySet = new Set(Object.keys(ptBRTabs));

    const missingInEs = TAB_KEYS.filter((k) => !esKeySet.has(k));
    const missingInPtBR = TAB_KEYS.filter((k) => !ptBRKeySet.has(k));

    expect(missingInEs).toEqual([]);
    expect(missingInPtBR).toEqual([]);
  });
});

// ── Values are user-friendly ─────────────────────────────────────────────────

describe('VacancyDetail tabs i18n — values are user-friendly', () => {
  it.each(TAB_KEYS)('es tabs.%s is not the raw i18n key', (key) => {
    const value = esTabs[key];
    expect(value).not.toBe(`admin.vacancyDetail.tabs.${key}`);
  });

  it.each(TAB_KEYS)('pt-BR tabs.%s is not the raw i18n key', (key) => {
    const value = ptBRTabs[key];
    expect(value).not.toBe(`admin.vacancyDetail.tabs.${key}`);
  });
});
