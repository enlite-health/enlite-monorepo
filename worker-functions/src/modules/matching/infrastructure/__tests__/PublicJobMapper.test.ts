/**
 * PublicJobMapper.test.ts
 *
 * Public `description` is sourced from job_postings.talentum_description (PII-free)
 * since migration 214 dropped the legacy raw `description` column. sanitizeDescription
 * is now a plain trim/null-guard — no more placeholder-prefix stripping.
 *
 * Scenarios:
 *   1. sanitizeDescription — returns description unchanged for real content
 *   2. sanitizeDescription — returns empty string for null
 *   3. sanitizeDescription — trims whitespace
 *   4. sanitizeDescription — returns empty string for empty string input
 *   5. mapPublicJobRow — maps all fields correctly (including 5 new fields + country + age_range + whatsapp_url)
 *   6. mapPublicJobRow — description (from talentum_description) passes through trimmed
 *   7. mapPublicJobRow — state_city empty string normalised to null
 *   8. mapPublicJobRow — state_city whitespace-only normalised to null
 *   9. mapPublicJobRow — worker_type empty array normalised to null
 *  10. mapPublicJobRow — new fields pass-through when populated
 *  11. mapPublicJobRow — new fields pass-through as null when absent
 *  12. mapPublicJobRow — country maps to dto.country
 *  13. mapPublicJobRow — country null maps to dto.country null
 */

import { sanitizeDescription, mapPublicJobRow } from '../PublicJobMapper';
import type { PublicJobRow } from '../../domain/PublicJobDto';

describe('sanitizeDescription', () => {
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
      schedule: null,
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
      country: 'AR',
      age_range_min: 5,
      age_range_max: 12,
      whatsapp_url: 'https://wa.me/5491112345678',
      ...overrides,
    };
  }

  it('maps all fields from row to DTO (including 5 new fields + country + age_range + whatsapp_url)', () => {
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
    expect(dto.country).toBe('AR');
    expect(dto.age_range_min).toBe(5);
    expect(dto.age_range_max).toBe(12);
    expect(dto.whatsapp_url).toBe('https://wa.me/5491112345678');
  });

  it('passes description (from talentum_description) through trimmed', () => {
    const row = makeRow({ description: '  AT para paciente con TEA en CABA.  ' });
    const dto = mapPublicJobRow(row);
    expect(dto.description).toBe('AT para paciente con TEA en CABA.');
  });

  it('maps null description to empty string', () => {
    const row = makeRow({ description: null });
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

  it('passes through age_range_min and age_range_max when populated', () => {
    const dto = mapPublicJobRow(makeRow({ age_range_min: 18, age_range_max: 35 }));
    expect(dto.age_range_min).toBe(18);
    expect(dto.age_range_max).toBe(35);
  });

  it('passes through age_range_min and age_range_max as null when absent', () => {
    const dto = mapPublicJobRow(makeRow({ age_range_min: null, age_range_max: null }));
    expect(dto.age_range_min).toBeNull();
    expect(dto.age_range_max).toBeNull();
  });

  it('passes through whatsapp_url when populated', () => {
    const dto = mapPublicJobRow(makeRow({ whatsapp_url: 'https://wa.me/5491199999999' }));
    expect(dto.whatsapp_url).toBe('https://wa.me/5491199999999');
  });

  it('passes through whatsapp_url as null when absent', () => {
    const dto = mapPublicJobRow(makeRow({ whatsapp_url: null }));
    expect(dto.whatsapp_url).toBeNull();
  });

  it('maps country to dto.country', () => {
    const dto = mapPublicJobRow(makeRow({ country: 'BR' }));
    expect(dto.country).toBe('BR');
  });

  it('maps country null to dto.country null', () => {
    const dto = mapPublicJobRow(makeRow({ country: null }));
    expect(dto.country).toBeNull();
  });

  // ── schedule_days_hours fallback (TD: schedule JSONB → texto derivado) ────

  it('derives schedule_days_hours from schedule JSONB when the legacy column is null', () => {
    const row = makeRow({
      schedule_days_hours: null,
      schedule: [
        { dayOfWeek: 1, startTime: '09:00', endTime: '12:00' },
        { dayOfWeek: 3, startTime: '09:00', endTime: '14:00' },
      ],
    });
    const dto = mapPublicJobRow(row);
    expect(dto.schedule_days_hours).toBe('Lunes 09:00-12:00, Miércoles 09:00-14:00');
  });

  it('keeps the legacy schedule_days_hours when present, even if schedule JSONB also has data', () => {
    const row = makeRow({
      schedule_days_hours: 'Lunes a Viernes 08-14',
      schedule: [{ dayOfWeek: 1, startTime: '09:00', endTime: '12:00' }],
    });
    const dto = mapPublicJobRow(row);
    expect(dto.schedule_days_hours).toBe('Lunes a Viernes 08-14');
  });

  it('returns null schedule_days_hours when both legacy column and schedule JSONB are empty', () => {
    const row = makeRow({ schedule_days_hours: null, schedule: null });
    const dto = mapPublicJobRow(row);
    expect(dto.schedule_days_hours).toBeNull();
  });

  it('treats an empty-string legacy schedule_days_hours as absent and falls back to schedule JSONB', () => {
    const row = makeRow({
      schedule_days_hours: '',
      schedule: [{ dayOfWeek: 6, startTime: '12:00', endTime: '16:00' }],
    });
    const dto = mapPublicJobRow(row);
    expect(dto.schedule_days_hours).toBe('Sábado 12:00-16:00');
  });
});
