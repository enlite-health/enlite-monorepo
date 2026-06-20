/**
 * captureVacancyDiff.test.ts
 *
 * Testes unitários da função pura captureVacancyDiff.
 *
 * Cenários:
 * 1. Campo mudou (string simples) → retorna diff
 * 2. Campo não mudou → omitido
 * 3. null → valor → retorna diff
 * 4. valor → null → retorna diff
 * 5. Campo fora da whitelist é ignorado
 * 6. Objeto/array muda por valor (JSON.stringify) → retorna diff
 * 7. Objeto/array idêntico por valor → omitido
 * 8. Lista de campos vazia → retorna []
 * 9. Múltiplos campos — só os que mudaram são retornados
 * 10. Campos ausentes em before/after tratados como undefined
 */

import { captureVacancyDiff, FULL_ALLOWED_UPDATE_FIELDS } from '../vacancyCrudHelpers';

const ALLOWED = ['status', 'title', 'schedule', 'patient_id', 'providers_needed'] as const;

describe('captureVacancyDiff', () => {
  it('retorna diff quando campo string mudou', () => {
    const result = captureVacancyDiff(
      { status: 'SEARCHING' },
      { status: 'ACTIVE' },
      ALLOWED,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ field: 'status', before: 'SEARCHING', after: 'ACTIVE' });
  });

  it('omite campo que não mudou', () => {
    const result = captureVacancyDiff(
      { status: 'SEARCHING', title: 'CASO 100-1' },
      { status: 'SEARCHING', title: 'CASO 100-1' },
      ALLOWED,
    );
    expect(result).toHaveLength(0);
  });

  it('retorna diff quando null → valor', () => {
    const result = captureVacancyDiff(
      { title: null },
      { title: 'CASO 100-1' },
      ALLOWED,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ field: 'title', before: null, after: 'CASO 100-1' });
  });

  it('retorna diff quando valor → null', () => {
    const result = captureVacancyDiff(
      { providers_needed: '2' },
      { providers_needed: null },
      ALLOWED,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ field: 'providers_needed', before: '2', after: null });
  });

  it('ignora campo fora da whitelist', () => {
    const result = captureVacancyDiff(
      { status: 'SEARCHING', country: 'AR' },
      { status: 'SEARCHING', country: 'BR' },
      ALLOWED,
    );
    // country não está em ALLOWED → ignorado
    expect(result).toHaveLength(0);
  });

  it('detecta mudança em objeto (schedule JSONB) por valor', () => {
    const before = { schedule: { days: [1, 2], startTime: '08:00', endTime: '12:00' } };
    const after  = { schedule: { days: [1, 2, 3], startTime: '08:00', endTime: '12:00' } };
    const result = captureVacancyDiff(before, after, ALLOWED);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe('schedule');
    expect(result[0].before).toEqual(before.schedule);
    expect(result[0].after).toEqual(after.schedule);
  });

  it('omite objeto idêntico por valor (mesma referência ou deep-equal)', () => {
    const schedule = { days: [1, 2], startTime: '08:00', endTime: '12:00' };
    const result = captureVacancyDiff(
      { schedule: { ...schedule } },
      { schedule: { ...schedule } },
      ALLOWED,
    );
    expect(result).toHaveLength(0);
  });

  it('retorna array vazio quando lista de campos permitidos é vazia', () => {
    const result = captureVacancyDiff(
      { status: 'SEARCHING' },
      { status: 'ACTIVE' },
      [],
    );
    expect(result).toHaveLength(0);
  });

  it('retorna apenas campos que mudaram quando múltiplos presentes', () => {
    const result = captureVacancyDiff(
      { status: 'SEARCHING', title: 'CASO 1-1', patient_id: 'abc' },
      { status: 'ACTIVE',    title: 'CASO 1-1', patient_id: 'xyz' },
      ALLOWED,
    );
    expect(result).toHaveLength(2);
    const fields = result.map(d => d.field);
    expect(fields).toContain('status');
    expect(fields).toContain('patient_id');
    expect(fields).not.toContain('title');
  });

  it('trata campo ausente em before como undefined', () => {
    const result = captureVacancyDiff(
      {},
      { status: 'SEARCHING' },
      ALLOWED,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ field: 'status', before: undefined, after: 'SEARCHING' });
  });

  it('trata campo ausente em after como undefined', () => {
    const result = captureVacancyDiff(
      { title: 'CASO 1-1' },
      {},
      ALLOWED,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ field: 'title', before: 'CASO 1-1', after: undefined });
  });

  it('funciona com FULL_ALLOWED_UPDATE_FIELDS (smoke test — sem crash)', () => {
    const before: Record<string, unknown> = { status: 'SEARCHING', title: 'CASO 1-1' };
    const after: Record<string, unknown>  = { status: 'ACTIVE',    title: 'CASO 1-1' };
    const result = captureVacancyDiff(before, after, FULL_ALLOWED_UPDATE_FIELDS);
    expect(result).toHaveLength(1);
    expect(result[0].field).toBe('status');
  });
});
