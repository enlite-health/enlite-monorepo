/**
 * vacanciesData.test.ts
 *
 * GARANTIA: As opções dos selects de vacantes:
 *  - Não contêm opção duplicada com value="" (o Select já adiciona placeholder)
 *  - Usam os valores canônicos do banco para status (8 valores) e priority (4 valores)
 *  - Usam i18n keys, nunca strings hardcoded
 */

import { describe, it, expect } from 'vitest';
import { getStatusOptions, getPriorityOptions } from '../vacanciesData';

// Mock i18n t function — retorna a chave como string
const t = ((key: string) => key) as any;

describe('vacanciesData — no duplicate empty-value options', () => {
  it('CRITICAL: getStatusOptions does NOT include value="" option', () => {
    const options = getStatusOptions(t);
    const emptyOptions = options.filter((o) => o.value === '');
    expect(emptyOptions).toHaveLength(0);
  });

  it('CRITICAL: getPriorityOptions does NOT include value="" option', () => {
    const options = getPriorityOptions(t);
    const emptyOptions = options.filter((o) => o.value === '');
    expect(emptyOptions).toHaveLength(0);
  });
});

describe('vacanciesData — status options match the 8 canonical DB values', () => {
  it('contains exactly the 8 canonical job_postings.status values', () => {
    const options = getStatusOptions(t);
    const values = options.map((o) => o.value).sort();
    expect(values).toEqual(
      [
        'ACTIVE',
        'CLOSED',
        'ON_HOLD',
        'PENDING_ACTIVATION',
        'RAPID_RESPONSE',
        'SEARCHING',
        'SEARCHING_REPLACEMENT',
        'SUSPENDED',
      ].sort(),
    );
  });
});

describe('vacanciesData — priority options match the 4 canonical DB values', () => {
  it('priority options contain URGENT, HIGH, NORMAL, LOW', () => {
    const options = getPriorityOptions(t);
    const values = options.map((o) => o.value);
    expect(values).toEqual(['URGENT', 'HIGH', 'NORMAL', 'LOW']);
  });
});

describe('vacanciesData — all options use i18n keys', () => {
  it('status option labels are i18n keys', () => {
    const options = getStatusOptions(t);
    options.forEach((o) => {
      expect(o.label).toMatch(/^admin\.vacancies\./);
    });
  });

  it('priority option labels are i18n keys', () => {
    const options = getPriorityOptions(t);
    options.forEach((o) => {
      expect(o.label).toMatch(/^admin\.vacancies\./);
    });
  });
});
