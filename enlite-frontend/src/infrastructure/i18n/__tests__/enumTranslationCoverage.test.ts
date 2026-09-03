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
import {
  PATIENT_STATUSES, ON_HOLD_REASONS, ADMISSION_STATUSES, DEVICE_TYPE_CODES, RELATIONSHIP_CODES, INSURANCE_PROVIDER_CODES,
} from '@domain/entities/patientEnums';

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
  // Public vacancy page (`vacancy.service_type`) — same full profession
  // vocabulary; a raw leak here is public-facing (see BLOCKER fix for
  // PSYCHOLOGIST/NURSE/KINESIOLOGIST leaking on the public page).
  'publicVacancy.serviceTypeLabels',
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

// ── Spec 012 (bloco B da admissão): os vocabulários do paciente que a tela traduz ─────────────
const PATIENT_ENUM_GROUPS: Array<[string, readonly string[]]> = [
  ['admin.patients.statusOptions', PATIENT_STATUSES],
  ['admin.patients.onHoldReasonOptions', ON_HOLD_REASONS],
  ['admin.patients.kanban.columns', ADMISSION_STATUSES],
  ['admin.patients.deviceTypeOptions', DEVICE_TYPE_CODES],
  ['admin.patients.detail.relationshipOptions', RELATIONSHIP_CODES],
  ['admin.patients.insuranceProviderOptions', INSURANCE_PROVIDER_CODES],
  // QA 🟡4: o mapa tinha vocabulário PRÓPRIO (mapPageConfig.ts), desincronizado do estado v2 —
  // faltavam ON_HOLD/SEARCHING/REPLACEMENT e sobrava DISCONTINUED (saiu do vocabulário, migration
  // 314). A fonte viva é a mesma PATIENT_STATUSES do resto da ficha, não uma lista própria do mapa.
  ['admin.map.patientStatus', PATIENT_STATUSES],
];

describe.each([
  ['es', esJson as Locale],
  ['pt-BR', ptBRJson as Locale],
])('patient enum translation coverage — spec 012 (%s)', (_lng, locale) => {
  it.each(PATIENT_ENUM_GROUPS)('%s cobre todos os valores do enum', (group, values) => {
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      const label = get(locale, `${group}.${value}`);
      expect(label, `missing ${group}.${value}`).toBeTypeOf('string');
      expect(label).not.toBe('');
    }
  });

  it('estado, motivo, dispositivo e parentesco são traduções, não o enum ecoado', () => {
    for (const [group, values] of PATIENT_ENUM_GROUPS.slice(0, 5)) {
      for (const value of values) {
        expect(get(locale, `${group}.${value}`), `${group}.${value} echoes the raw enum`).not.toBe(value);
      }
    }
  });
});
