/**
 * vacancy-form-schema.test.ts
 *
 * Contrato de valores canônicos de STATUS_OPTIONS, DEFAULT_FORM_VALUES e
 * buildVacancyPayload — garante que ninguém reverta para valores legados que
 * violam o CHECK constraint job_postings_status_check (migration 148).
 */

import { describe, it, expect } from 'vitest';
import {
  STATUS_OPTIONS,
  DEFAULT_FORM_VALUES,
  buildVacancyPayload,
  type VacancyFormData,
} from '../vacancy-form-schema';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANONICAL_VALUES = [
  'SEARCHING',
  'SEARCHING_REPLACEMENT',
  'RAPID_RESPONSE',
  'PENDING_ACTIVATION',
  'ACTIVE',
  'SUSPENDED',
  'CLOSED',
] as const;

const CANONICAL = new Set<string>(CANONICAL_VALUES);

const LEGACY_VALUES = [
  'BUSQUEDA',
  'REEMPLAZO',
  'CUBIERTO',
  'CANCELADO',
  'draft',
  'paused',
  'ACTIVO',
  'rta_rapida',
  'searching',
  'replacement',
];

const minimalFormData: VacancyFormData = {
  title: 'Test',
  required_professions: ['AT'],
  providers_needed: 1,
  schedule: [{ days: ['lun'], timeFrom: '08:00', timeTo: '16:00' }],
  status: 'SEARCHING',
  meet_links: ['https://meet.google.com/abc-defg-hij', undefined, undefined],
};

// ---------------------------------------------------------------------------
// STATUS_OPTIONS — canonical values contract
// ---------------------------------------------------------------------------

describe('STATUS_OPTIONS — canonical values contract', () => {
  it('contains only the 7 canonical DB values (no legacy values allowed)', () => {
    expect(STATUS_OPTIONS).toHaveLength(7);
    expect(STATUS_OPTIONS).toEqual(
      expect.arrayContaining([
        'SEARCHING',
        'SEARCHING_REPLACEMENT',
        'RAPID_RESPONSE',
        'PENDING_ACTIVATION',
        'ACTIVE',
        'SUSPENDED',
        'CLOSED',
      ]),
    );
  });

  it('does not contain any legacy value that violates job_postings_status_check', () => {
    for (const legacy of LEGACY_VALUES) {
      expect(STATUS_OPTIONS).not.toContain(legacy);
    }
  });

  it('every element passes the canonical set check', () => {
    for (const value of STATUS_OPTIONS) {
      expect(CANONICAL.has(value)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_FORM_VALUES — default status is canonical
// ---------------------------------------------------------------------------

describe('DEFAULT_FORM_VALUES — default status is canonical', () => {
  it('status default is SEARCHING', () => {
    expect(DEFAULT_FORM_VALUES.status).toBe('SEARCHING');
  });

  it('status default is in STATUS_OPTIONS', () => {
    expect(STATUS_OPTIONS.includes(DEFAULT_FORM_VALUES.status as (typeof STATUS_OPTIONS)[number])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildVacancyPayload — status in output is canonical
// ---------------------------------------------------------------------------

describe('buildVacancyPayload — status in output is canonical', () => {
  it('passes status from form data through to payload', () => {
    const result = buildVacancyPayload(minimalFormData, null);
    expect(result.status).toBe('SEARCHING');
  });

  it('does not hardcode any legacy status value in output', () => {
    for (const value of STATUS_OPTIONS) {
      const data: VacancyFormData = { ...minimalFormData, status: value };
      const result = buildVacancyPayload(data, null);
      expect(result.status).toBe(value);
    }
  });
});
