/**
 * Coverage guard: every enum value the domain declares must have a real
 * translation in es.json (primary UI language). Without this, adding a new
 * enum value (e.g. a new profession) silently falls back to the raw English
 * token in the UI — the exact class of bug reported on the vacancy screen
 * ("CASO 798 - CAREGIVER - …").
 *
 * When this test fails: add the missing key to the relevant *Options group in
 * es.json (and pt-BR.json), don't loosen the assertion.
 */
import { describe, it, expect } from 'vitest';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { WORKER_PROFESSIONS } from '@domain/entities/Worker';

type Locale = Record<string, unknown>;

function get(obj: Locale, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, key) =>
      acc && typeof acc === 'object' ? (acc as Locale)[key] : undefined,
    obj,
  );
}

const PROFESSION_GROUPS = [
  'admin.vacancyDetail.vacancyForm.professionOptions',
  'admin.workerDetail.professionValue',
  'jobs.profession',
];

// Vacancy forms also allow the composite value on top of the worker professions.
const VACANCY_PROFESSION_VALUES = [...WORKER_PROFESSIONS, 'AT_AND_CAREGIVER'];

describe.each([
  ['es', esJson as Locale],
  ['pt-BR', ptBRJson as Locale],
])('profession enum translation coverage (%s)', (_lng, locale) => {
  it('vacancy professionOptions covers every profession value', () => {
    for (const value of VACANCY_PROFESSION_VALUES) {
      const label = get(
        locale,
        `admin.vacancyDetail.vacancyForm.professionOptions.${value}`,
      );
      expect(label, `missing professionOptions.${value}`).toBeTypeOf('string');
      expect(label).not.toBe('');
    }
  });

  it('every profession label group covers WORKER_PROFESSIONS', () => {
    for (const group of PROFESSION_GROUPS) {
      for (const value of WORKER_PROFESSIONS) {
        const label = get(locale, `${group}.${value}`);
        expect(label, `missing ${group}.${value}`).toBeTypeOf('string');
        expect(label).not.toBe('');
      }
    }
  });

  it('labels are translations, not the raw enum echoed back (except AT)', () => {
    for (const value of VACANCY_PROFESSION_VALUES) {
      if (value === 'AT') continue; // "AT" is the accepted human label
      const label = get(
        locale,
        `admin.vacancyDetail.vacancyForm.professionOptions.${value}`,
      );
      expect(label, `professionOptions.${value} echoes the raw enum`).not.toBe(
        value,
      );
    }
  });
});
