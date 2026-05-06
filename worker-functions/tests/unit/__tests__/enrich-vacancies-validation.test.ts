/**
 * enrich-vacancies-validation.test.ts
 *
 * Unit tests for the pure validator/helper functions in
 * scripts/enrich-vacancies-helpers.ts.
 *
 * No DB, no Gemini API — all functions are pure.
 */

import {
  validateSchedule,
  validateRequiredSex,
  validateAge,
  validateProfessions,
  buildInputText,
  inferWorkerType,
  ValidationCounters,
  JobPostingRow,
} from '../../../scripts/enrich-vacancies-helpers';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCounters(): ValidationCounters {
  return {
    invalid_schedule: 0,
    invalid_required_sex: 0,
    invalid_age_range: 0,
    invalid_professions: 0,
    invalid_fields_skipped: 0,
  };
}

function makeRow(overrides: Partial<JobPostingRow> = {}): JobPostingRow {
  // service_address_raw, pathology_types, dependency_level, service_device_types
  // were dropped in migration 152 and removed from JobPostingRow.
  return {
    id: 'test-id',
    title: null,
    worker_profile_sought: null,
    schedule_days_hours: null,
    daily_obs: null,
    required_professions: null,
    schedule: null,
    required_sex: null,
    age_range_min: null,
    age_range_max: null,
    required_experience: null,
    worker_attributes: null,
    salary_text: null,
    payment_day: null,
    enriched_at: null,
    ...overrides,
  };
}

// ── validateSchedule ───────────────────────────────────────────────────────────

describe('validateSchedule()', () => {
  it('returns valid entries for a well-formed schedule', () => {
    const c = makeCounters();
    const result = validateSchedule(
      [{ dayOfWeek: 1, startTime: '08:00', endTime: '17:00' }],
      c,
    );
    expect(result).toEqual([{ dayOfWeek: 1, startTime: '08:00', endTime: '17:00' }]);
    expect(c.invalid_fields_skipped).toBe(0);
  });

  it('accepts HH:MM:SS time format', () => {
    const c = makeCounters();
    const result = validateSchedule(
      [{ dayOfWeek: 3, startTime: '09:00:00', endTime: '18:30:00' }],
      c,
    );
    expect(result).not.toBeNull();
    expect(c.invalid_schedule).toBe(0);
  });

  it('accepts dayOfWeek=0 (Sunday)', () => {
    const c = makeCounters();
    const result = validateSchedule(
      [{ dayOfWeek: 0, startTime: '10:00', endTime: '14:00' }],
      c,
    );
    expect(result).not.toBeNull();
  });

  it('accepts dayOfWeek=6 (Saturday)', () => {
    const c = makeCounters();
    const result = validateSchedule(
      [{ dayOfWeek: 6, startTime: '10:00', endTime: '14:00' }],
      c,
    );
    expect(result).not.toBeNull();
  });

  it('returns null and increments counters for dayOfWeek=7 (out of range)', () => {
    const c = makeCounters();
    const result = validateSchedule(
      [{ dayOfWeek: 7, startTime: '08:00', endTime: '17:00' }],
      c,
    );
    expect(result).toBeNull();
    expect(c.invalid_schedule).toBe(1);
    expect(c.invalid_fields_skipped).toBe(1);
  });

  it('returns null for dayOfWeek=-1 (negative)', () => {
    const c = makeCounters();
    const result = validateSchedule(
      [{ dayOfWeek: -1, startTime: '08:00', endTime: '17:00' }],
      c,
    );
    expect(result).toBeNull();
    expect(c.invalid_schedule).toBe(1);
  });

  it('returns null for invalid startTime (hour=25)', () => {
    const c = makeCounters();
    const result = validateSchedule(
      [{ dayOfWeek: 1, startTime: '25:00', endTime: '17:00' }],
      c,
    );
    expect(result).toBeNull();
    expect(c.invalid_schedule).toBe(1);
  });

  it('returns null for invalid endTime (minutes=60)', () => {
    const c = makeCounters();
    const result = validateSchedule(
      [{ dayOfWeek: 1, startTime: '08:00', endTime: '09:60' }],
      c,
    );
    expect(result).toBeNull();
  });

  it('returns null for non-array input', () => {
    const c = makeCounters();
    expect(validateSchedule('08:00-17:00', c)).toBeNull();
    expect(c.invalid_fields_skipped).toBe(0); // non-array returns null silently
  });

  it('returns null for empty array', () => {
    const c = makeCounters();
    expect(validateSchedule([], c)).toBeNull();
    expect(c.invalid_fields_skipped).toBe(0);
  });

  it('returns null if ANY entry is invalid (all-or-nothing)', () => {
    const c = makeCounters();
    const result = validateSchedule(
      [
        { dayOfWeek: 1, startTime: '08:00', endTime: '17:00' }, // valid
        { dayOfWeek: 7, startTime: '08:00', endTime: '17:00' }, // invalid
      ],
      c,
    );
    expect(result).toBeNull();
    expect(c.invalid_schedule).toBe(1);
  });

  it('accepts multiple valid entries', () => {
    const c = makeCounters();
    const entries = [
      { dayOfWeek: 1, startTime: '08:00', endTime: '17:00' },
      { dayOfWeek: 2, startTime: '08:00', endTime: '17:00' },
      { dayOfWeek: 5, startTime: '09:00', endTime: '13:00' },
    ];
    const result = validateSchedule(entries, c);
    expect(result).toHaveLength(3);
    expect(c.invalid_schedule).toBe(0);
  });
});

// ── validateRequiredSex ────────────────────────────────────────────────────────

describe('validateRequiredSex()', () => {
  it('accepts "M"', () => {
    const c = makeCounters();
    expect(validateRequiredSex('M', c)).toBe('M');
    expect(c.invalid_fields_skipped).toBe(0);
  });

  it('accepts "F"', () => {
    const c = makeCounters();
    expect(validateRequiredSex('F', c)).toBe('F');
    expect(c.invalid_fields_skipped).toBe(0);
  });

  it('normalises "MALE" → "M"', () => {
    const c = makeCounters();
    expect(validateRequiredSex('MALE', c)).toBe('M');
    expect(c.invalid_fields_skipped).toBe(0);
  });

  it('normalises "FEMALE" → "F"', () => {
    const c = makeCounters();
    expect(validateRequiredSex('FEMALE', c)).toBe('F');
  });

  it('normalises "MASCULINO" → "M"', () => {
    const c = makeCounters();
    expect(validateRequiredSex('MASCULINO', c)).toBe('M');
  });

  it('normalises "FEMENINO" → "F"', () => {
    const c = makeCounters();
    expect(validateRequiredSex('FEMENINO', c)).toBe('F');
  });

  it('returns null and increments for "X"', () => {
    const c = makeCounters();
    expect(validateRequiredSex('X', c)).toBeNull();
    expect(c.invalid_required_sex).toBe(1);
    expect(c.invalid_fields_skipped).toBe(1);
  });

  it('returns null and increments for "BOTH"', () => {
    const c = makeCounters();
    expect(validateRequiredSex('BOTH', c)).toBeNull();
    expect(c.invalid_required_sex).toBe(1);
  });

  it('returns null (no counter) for null input', () => {
    const c = makeCounters();
    expect(validateRequiredSex(null, c)).toBeNull();
    expect(c.invalid_fields_skipped).toBe(0);
  });

  it('returns null (no counter) for undefined input', () => {
    const c = makeCounters();
    expect(validateRequiredSex(undefined, c)).toBeNull();
    expect(c.invalid_fields_skipped).toBe(0);
  });

  it('returns null and increments for non-string input', () => {
    const c = makeCounters();
    expect(validateRequiredSex(123, c)).toBeNull();
    expect(c.invalid_required_sex).toBe(1);
  });
});

// ── validateAge ────────────────────────────────────────────────────────────────

describe('validateAge()', () => {
  it('accepts valid integer ages', () => {
    const c = makeCounters();
    expect(validateAge(25, c)).toBe(25);
    expect(validateAge(0, c)).toBe(0);
    expect(c.invalid_fields_skipped).toBe(0);
  });

  it('returns null for null', () => {
    const c = makeCounters();
    expect(validateAge(null, c)).toBeNull();
    expect(c.invalid_fields_skipped).toBe(0);
  });

  it('returns null for undefined', () => {
    const c = makeCounters();
    expect(validateAge(undefined, c)).toBeNull();
    expect(c.invalid_fields_skipped).toBe(0);
  });

  it('returns null and increments for negative integer', () => {
    const c = makeCounters();
    expect(validateAge(-1, c)).toBeNull();
    expect(c.invalid_age_range).toBe(1);
    expect(c.invalid_fields_skipped).toBe(1);
  });

  it('returns null and increments for float', () => {
    const c = makeCounters();
    expect(validateAge(25.5, c)).toBeNull();
    expect(c.invalid_age_range).toBe(1);
  });

  it('returns null and increments for string', () => {
    const c = makeCounters();
    expect(validateAge('25', c)).toBeNull();
    expect(c.invalid_age_range).toBe(1);
  });
});

// ── validateProfessions ────────────────────────────────────────────────────────

describe('validateProfessions()', () => {
  it('returns only known professions', () => {
    const c = makeCounters();
    const result = validateProfessions(['AT', 'CAREGIVER'], c);
    expect(result).toEqual(['AT', 'CAREGIVER']);
    expect(c.invalid_fields_skipped).toBe(0);
  });

  it('filters out unknown strings', () => {
    const c = makeCounters();
    const result = validateProfessions(['AT', 'INVALID', 'CAREGIVER'], c);
    expect(result).toEqual(['AT', 'CAREGIVER']);
    expect(c.invalid_professions).toBe(1);
    expect(c.invalid_fields_skipped).toBe(1);
  });

  it('accepts all canonical Profession values', () => {
    const c = makeCounters();
    const all = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'];
    expect(validateProfessions(all, c)).toEqual(all);
  });

  it('returns empty array for non-array input', () => {
    const c = makeCounters();
    expect(validateProfessions('AT', c)).toEqual([]);
  });

  it('returns empty array for empty array input', () => {
    const c = makeCounters();
    expect(validateProfessions([], c)).toEqual([]);
    expect(c.invalid_professions).toBe(0);
  });

  it('filters lowercase "at" (case-sensitive canonical check)', () => {
    const c = makeCounters();
    const result = validateProfessions(['at', 'AT'], c);
    expect(result).toEqual(['AT']);
    expect(c.invalid_professions).toBe(1);
  });
});

// ── buildInputText ─────────────────────────────────────────────────────────────

describe('buildInputText()', () => {
  it('includes all available fields', () => {
    // service_address_raw dropped in migration 152 — address via patient_addresses FK.
    const row = makeRow({
      title: 'CASO 100',
      worker_profile_sought: 'AT con experiencia en TEA',
      schedule_days_hours: 'Lunes a viernes 8-17hs',
      daily_obs: 'Paciente con comportamientos desafiantes',
    });
    const text = buildInputText(row);
    expect(text).toContain('Título: CASO 100');
    expect(text).toContain('Perfil buscado: AT con experiencia en TEA');
    expect(text).toContain('Horários: Lunes a viernes 8-17hs');
    expect(text).toContain('Observações: Paciente con comportamientos desafiantes');
    expect(text).not.toContain('Endereço:'); // address field no longer in enrichment input
  });

  it('omits sections where field is null', () => {
    const row = makeRow({ title: 'CASO 200', schedule_days_hours: 'Martes y jueves' });
    const text = buildInputText(row);
    expect(text).toContain('Título: CASO 200');
    expect(text).toContain('Horários: Martes y jueves');
    expect(text).not.toContain('Perfil buscado');
    expect(text).not.toContain('Observações');
    expect(text).not.toContain('Endereço');
  });

  it('returns empty string when all fields are null', () => {
    const row = makeRow();
    expect(buildInputText(row)).toBe('');
  });

  it('joins sections with newline', () => {
    const row = makeRow({ title: 'CASO 1', worker_profile_sought: 'AT' });
    expect(buildInputText(row)).toBe('Título: CASO 1\nPerfil buscado: AT');
  });
});

// ── inferWorkerType ────────────────────────────────────────────────────────────

describe('inferWorkerType()', () => {
  it('returns CUIDADOR when required_professions has CAREGIVER', () => {
    const row = makeRow({ required_professions: ['CAREGIVER'] });
    expect(inferWorkerType(row)).toBe('CUIDADOR');
  });

  it('returns AT when required_professions has AT', () => {
    const row = makeRow({ required_professions: ['AT'] });
    expect(inferWorkerType(row)).toBe('AT');
  });

  it('returns AT for NURSE profession (AT workflow)', () => {
    const row = makeRow({ required_professions: ['NURSE'] });
    expect(inferWorkerType(row)).toBe('AT');
  });

  it('returns CUIDADOR when title contains "cuidador"', () => {
    const row = makeRow({ title: 'Búsqueda de cuidador adulto mayor' });
    expect(inferWorkerType(row)).toBe('CUIDADOR');
  });

  it('returns CUIDADOR when worker_profile_sought contains "caregiver"', () => {
    const row = makeRow({ worker_profile_sought: 'Experienced caregiver needed' });
    expect(inferWorkerType(row)).toBe('CUIDADOR');
  });

  it('defaults to AT when no professions and no cuidador text', () => {
    const row = makeRow({ title: 'CASO 999', worker_profile_sought: 'AT con experiencia en TEA' });
    expect(inferWorkerType(row)).toBe('AT');
  });

  it('defaults to AT when all fields are null', () => {
    const row = makeRow();
    expect(inferWorkerType(row)).toBe('AT');
  });

  it('uses required_professions over text heuristic', () => {
    // title says "cuidador" but professions say AT → AT wins
    const row = makeRow({
      required_professions: ['AT'],
      title: 'Busco cuidador urgente',
    });
    expect(inferWorkerType(row)).toBe('AT');
  });
});
