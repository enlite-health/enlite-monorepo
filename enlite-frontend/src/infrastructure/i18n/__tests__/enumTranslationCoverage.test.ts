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
import { PAYER_KINDS } from '@domain/entities/InsuranceContract';
import { COVERAGE_MATCH_STATES } from '@domain/entities/PatientContractedService';
import {
  PATIENT_STATUSES, ON_HOLD_REASONS, ADMISSION_STATUSES, DEVICE_TYPE_CODES, RELATIONSHIP_CODES,
  PATIENT_PROFESSIONAL_SPECIALTY_CODES,
  EXTERNAL_CONTACT_RELATION_CODES,
  PATIENT_GENDERS,
  PATIENT_LANGUAGES,
  SUSPENSION_EXIT_REASONS,
} from '@domain/entities/patientEnums';
import {
  SERVICE_CODES,
  CARE_LOCATIONS,
  SUPERVISION_FREQUENCIES,
  GUARD_SHIFTS,
  PROVIDER_AGE_BANDS,
} from '@domain/entities/PatientContractedService';

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
  ['admin.patients.detail.treatingTeamCard.specialtyOptions', PATIENT_PROFESSIONAL_SPECIALTY_CODES],
  // Spec 018, PR-2 (`lex` #4): contatos externos sem vínculo familiar (migration 422, SUP-15).
  ['admin.patients.detail.externalContactRelationOptions', EXTERNAL_CONTACT_RELATION_CODES],
  // QA 🟡4: o mapa tinha vocabulário PRÓPRIO (mapPageConfig.ts), desincronizado do estado v2 —
  // faltavam ON_HOLD/SEARCHING/REPLACEMENT e sobrava DISCONTINUED (saiu do vocabulário, migration
  // 314). A fonte viva é a mesma PATIENT_STATUSES do resto da ficha, não uma lista própria do mapa.
  ['admin.map.patientStatus', PATIENT_STATUSES],
  // Decisão do Gabriel 29/09/2026 (migration 486): motivo de saída de SUSPENDED. Vai no FIM do
  // array, de propósito — o teste de "eco do enum cru" abaixo usa `.slice(0, 5)` sobre ESTE
  // array; inserir mais cedo deslocaria a janela e tiraria `relationshipOptions` do check sem
  // ninguém notar.
  ['admin.patients.suspensionExitReasonOptions', SUSPENSION_EXIT_REASONS],
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

// ── Spec 018 PR-3 (Emenda 13/09, migration 425): gênero e idiomas do paciente ──────────────────
const PR3_ENUM_GROUPS: Array<[string, readonly string[]]> = [
  ['admin.patients.detail.generalInfoCard.genderOptions', PATIENT_GENDERS],
  ['admin.patients.detail.generalInfoCard.languageOptions', PATIENT_LANGUAGES],
];

describe.each([
  ['es', esJson as Locale],
  ['pt-BR', ptBRJson as Locale],
])('patient gender/languages enum translation coverage — spec 018 PR-3 (%s)', (_lng, locale) => {
  it.each(PR3_ENUM_GROUPS)('%s cobre todos os valores do enum', (group, values) => {
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      const label = get(locale, `${group}.${value}`);
      expect(label, `missing ${group}.${value}`).toBeTypeOf('string');
      expect(label).not.toBe('');
    }
  });

  it('gênero/idiomas são traduções, não o enum ecoado', () => {
    for (const [group, values] of PR3_ENUM_GROUPS) {
      for (const value of values) {
        expect(get(locale, `${group}.${value}`), `${group}.${value} echoes the raw enum`).not.toBe(value);
      }
    }
  });
});

// ── Spec 013 (bloco C da admissão): vocabulários do serviço contratado ─────────────────────────
const CONTRACTED_SERVICE_ENUM_GROUPS: Array<[string, readonly string[]]> = [
  ['admin.patients.detail.contractedServicesCard.serviceTypes', SERVICE_CODES],
  ['admin.patients.detail.contractedServicesCard.careLocationOptions', CARE_LOCATIONS],
  // Spec 058: o tipo do pagador (`payer_kind`) substituiu o `contract_type`; a condição de IVA saiu (o imposto vem do termo).
  ['admin.patients.detail.contractedServicesCard.payerKindOptions', PAYER_KINDS],
  // Spec 058: os 6 estados da divergência pagador × cobertura + `REDACTED` (sem a célula `coverage`), e o preço sem valor.
  ['admin.patients.detail.contractedServicesCard.coverageMatch', COVERAGE_MATCH_STATES],
  ['admin.patients.detail.contractedServicesCard.priceState', ['NO_CONTRACT', 'NO_TERM', 'REDACTED']],
  ['admin.patients.detail.contractedServicesCard.supervisionFrequencyOptions', SUPERVISION_FREQUENCIES],
  ['admin.patients.detail.contractedServicesCard.guardShiftOptions', GUARD_SHIFTS],
  // Spec 015 (US-A6.1): franja etária solicitada do prestador.
  ['admin.patients.detail.contractedServicesCard.providerAgeBandOptions', PROVIDER_AGE_BANDS],
];

describe.each([
  ['es', esJson as Locale],
  ['pt-BR', ptBRJson as Locale],
])('contracted-service enum translation coverage — spec 013 (%s)', (_lng, locale) => {
  it.each(CONTRACTED_SERVICE_ENUM_GROUPS)('%s cobre todos os valores do enum', (group, values) => {
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      const label = get(locale, `${group}.${value}`);
      expect(label, `missing ${group}.${value}`).toBeTypeOf('string');
      expect(label).not.toBe('');
    }
  });

  it('care_location, contract_type, tax_condition, supervision_frequency e guard_shift são traduções, não o enum ecoado', () => {
    for (const [group, values] of CONTRACTED_SERVICE_ENUM_GROUPS.slice(1)) {
      for (const value of values) {
        expect(get(locale, `${group}.${value}`), `${group}.${value} echoes the raw enum`).not.toBe(value);
      }
    }
  });
});

// ── Spec 058: erros do mapa único do back (`insuranceErrorResponse.ts`) — todo código tem frase nos dois idiomas ───────────
const INSURANCE_ERROR_CODES = [
  // P0001 (funções de banco)
  'REQUIRES_NEW_SERVICE', 'USE_CORRECTION', 'TWO_PAYERS_OVERLAP', 'COUNTRY_MISMATCH', 'PAYER_KIND_REQUIRED', 'PAYER_KIND_CANNOT_UNSET', 'SERVICE_HAS_CONTRACT_LINK',
  // 422 do controller / escritor
  'SAME_START_USE_CORRECTION', 'TERM_RANGE_INVALID', 'LINK_RANGE_INVALID', 'NAME_NOT_CODIFIABLE', 'CODE_IMMUTABLE', 'IMMUTABLE_FIELD', 'VALIDATION_FAILED',
  'DOCUMENT_PAIR_INCOMPLETE', 'LEGACY_FIELD_REMOVED', 'UNPROCESSABLE',
  // 409
  'INSURANCE_PROVIDER_CODE_EXISTS', 'INSURANCE_PROVIDER_SORT_ORDER_TAKEN', 'INSURANCE_PROVIDER_NAME_EXISTS', 'INSURANCE_PROVIDER_TAX_ID_EXISTS',
  'INSURANCE_CONTRACT_NAME_EXISTS', 'RANGE_OVERLAP', 'CONCURRENCY_CONFLICT', 'TERM_ALREADY_SUPERSEDED', 'CONTACT_RETIRED',
  // 404 / 403
  'PROVIDER_NOT_FOUND', 'CONTRACT_NOT_FOUND', 'TERM_NOT_FOUND', 'SERVICE_NOT_FOUND', 'NO_LIVE_LINK', 'CONTACT_NOT_FOUND', 'COUNTRY_SCOPE_REQUIRED',
] as const;
const INSURANCE_CONSTRAINTS = [
  'insurance_providers_private_kind_chk', 'insurance_providers_other_unclassified_chk',
  'insurance_provider_contacts_document_pair_chk', 'insurance_contracts_country_check',
] as const;
const INSURANCE_OVERLAPS = ['insurance_contract_terms_sem_sobreposicao', 'contracted_service_contract_sem_sobreposicao'] as const;

describe.each([
  ['es', esJson as Locale],
  ['pt-BR', ptBRJson as Locale],
])('insurance error translation coverage — spec 058 (%s)', (_lng, locale) => {
  it.each([
    ['admin.insuranceErrors.codes', INSURANCE_ERROR_CODES],
    ['admin.insuranceErrors.constraints', INSURANCE_CONSTRAINTS],
    ['admin.insuranceErrors.rangeOverlap', INSURANCE_OVERLAPS],
    ['admin.insuranceErrors.byStatus', ['400', '403', '404', '409', '422']],
  ] as Array<[string, readonly string[]]>)('%s cobre todo código do mapa de erros', (group, values) => {
    for (const value of values) {
      const text = get(locale, `${group}.${value}`);
      expect(text, `missing ${group}.${value}`).toBeTypeOf('string');
      expect(text).not.toBe('');
      expect(text, `${group}.${value} echoes the raw code`).not.toBe(value);
    }
  });

  it('há uma frase genérica de último recurso', () => {
    expect(get(locale, 'admin.insuranceErrors.generic')).toBeTypeOf('string');
  });
});
