/**
 * PublicJobMapper.test.ts
 *
 * Scenarios:
 *   1. sanitizeDescription — returns empty string for generic "Caso operacional importado" prefix
 *   2. sanitizeDescription — returns empty string for "Caso operacional" prefix
 *   3. sanitizeDescription — returns sanitized string for real description
 *   4. sanitizeDescription — returns empty string for null
 *   5. sanitizeDescription — trims whitespace
 *   6. mapPublicJobRow — maps all fields correctly (including 5 new fields)
 *   7. mapPublicJobRow — description is sanitized in the output
 *   8. mapPublicJobRow — state_city empty string normalised to null
 *   9. mapPublicJobRow — state_city whitespace-only normalised to null
 *  10. mapPublicJobRow — worker_type empty array normalised to null
 *  11. mapPublicJobRow — new fields pass-through when populated
 *  12. mapPublicJobRow — new fields pass-through as null when absent
 */

import { sanitizeDescription, mapPublicJobRow } from '../PublicJobMapper';
import type { PublicJobRow } from '../../domain/PublicJobDto';

describe('sanitizeDescription', () => {
  it('returns empty string for generic "Caso operacional importado" prefix', () => {
    expect(sanitizeDescription('Caso operacional importado. Case #42')).toBe('');
  });

  it('returns empty string for "caso operacional" prefix (case-insensitive)', () => {
    expect(sanitizeDescription('CASO OPERACIONAL importado do ClickUp. Nº 100')).toBe('');
  });

  it('returns empty string for exact "Caso operacional" prefix', () => {
    expect(sanitizeDescription('Caso operacional')).toBe('');
  });

  it('returns description unchanged for real content', () => {
    const real = 'Buscamos AT con experiencia en TEA para trabajo en CABA.';
    expect(sanitizeDescription(real)).toBe(real);
  });

  it('returns empty string for null input', () => {
    expect(sanitizeDescription(null)).toBe('');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeDescription('  Descripción real con contenido  ')).toBe(
      'Descripción real con contenido',
    );
  });

  it('returns empty string for empty string input', () => {
    expect(sanitizeDescription('')).toBe('');
  });
});

describe('mapPublicJobRow', () => {
  function makeRow(overrides: Partial<PublicJobRow> = {}): PublicJobRow {
    return {
      id: 'uuid-1',
      case_number: 42,
      vacancy_number: 7,
      title: 'CASO 42-7',
      status: 'SEARCHING',
      description: 'Buscamos AT con experiencia.',
      schedule_days_hours: 'Lunes a Viernes 9-17',
      worker_profile_sought: 'Con experiencia en TEA',
      service: 'DOMICILIO',
      pathologies: 'TEA',
      state: 'Buenos Aires',
      city: 'Palermo',
      detail_link: 'https://srt.io/abc',
      worker_type: ['AT'],
      worker_sex: 'FEMALE',
      job_zone: 'NORTE',
      neighborhood: 'Palermo Soho',
      state_city: 'Buenos Aires / CABA',
      ...overrides,
    };
  }

  it('maps all fields from row to DTO (including 5 new fields)', () => {
    const row = makeRow();
    const dto = mapPublicJobRow(row);

    expect(dto.id).toBe('uuid-1');
    expect(dto.case_number).toBe(42);
    expect(dto.vacancy_number).toBe(7);
    expect(dto.title).toBe('CASO 42-7');
    expect(dto.status).toBe('SEARCHING');
    expect(dto.description).toBe('Buscamos AT con experiencia.');
    expect(dto.schedule_days_hours).toBe('Lunes a Viernes 9-17');
    expect(dto.worker_profile_sought).toBe('Con experiencia en TEA');
    expect(dto.service).toBe('DOMICILIO');
    expect(dto.pathologies).toBe('TEA');
    expect(dto.state).toBe('Buenos Aires');
    expect(dto.city).toBe('Palermo');
    expect(dto.detail_link).toBe('https://srt.io/abc');
    expect(dto.worker_type).toEqual(['AT']);
    expect(dto.worker_sex).toBe('FEMALE');
    expect(dto.job_zone).toBe('NORTE');
    expect(dto.neighborhood).toBe('Palermo Soho');
    expect(dto.state_city).toBe('Buenos Aires / CABA');
  });

  it('sanitizes generic description to empty string in DTO', () => {
    const row = makeRow({ description: 'Caso operacional importado. Case #42' });
    const dto = mapPublicJobRow(row);
    expect(dto.description).toBe('');
  });

  it('returns null fields as null', () => {
    const row = makeRow({
      schedule_days_hours: null,
      worker_profile_sought: null,
      service: null,
      pathologies: null,
      state: null,
      city: null,
    });
    const dto = mapPublicJobRow(row);

    expect(dto.schedule_days_hours).toBeNull();
    expect(dto.worker_profile_sought).toBeNull();
    expect(dto.service).toBeNull();
    expect(dto.pathologies).toBeNull();
    expect(dto.state).toBeNull();
    expect(dto.city).toBeNull();
  });

  it('normalises state_city empty string to null', () => {
    const dto = mapPublicJobRow(makeRow({ state_city: '' }));
    expect(dto.state_city).toBeNull();
  });

  it('normalises state_city whitespace-only string to null', () => {
    const dto = mapPublicJobRow(makeRow({ state_city: '   ' }));
    expect(dto.state_city).toBeNull();
  });

  it('normalises worker_type empty array to null', () => {
    const dto = mapPublicJobRow(makeRow({ worker_type: [] }));
    expect(dto.worker_type).toBeNull();
  });

  it('passes through populated new fields', () => {
    const dto = mapPublicJobRow(makeRow({
      worker_type: ['AT', 'PSICÓLOGO'],
      worker_sex: 'MALE',
      job_zone: 'SUR',
      neighborhood: 'Villa Lugano',
      state_city: 'Buenos Aires / Quilmes',
    }));
    expect(dto.worker_type).toEqual(['AT', 'PSICÓLOGO']);
    expect(dto.worker_sex).toBe('MALE');
    expect(dto.job_zone).toBe('SUR');
    expect(dto.neighborhood).toBe('Villa Lugano');
    expect(dto.state_city).toBe('Buenos Aires / Quilmes');
  });

  it('passes through null new fields as null', () => {
    const dto = mapPublicJobRow(makeRow({
      worker_type: null,
      worker_sex: null,
      job_zone: null,
      neighborhood: null,
      state_city: null,
    }));
    expect(dto.worker_type).toBeNull();
    expect(dto.worker_sex).toBeNull();
    expect(dto.job_zone).toBeNull();
    expect(dto.neighborhood).toBeNull();
    expect(dto.state_city).toBeNull();
  });
});
