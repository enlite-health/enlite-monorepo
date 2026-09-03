import { describe, it, expect } from 'vitest';
import ptBR from '@infrastructure/i18n/locales/pt-BR.json';
import es from '@infrastructure/i18n/locales/es.json';

// ── Helpers ────────────────────────────────────────────────────────────────

function getNestedValue(obj: Record<string, any>, path: string): any {
  return path.split('.').reduce((acc, key) => acc?.[key], obj);
}

function flattenKeys(obj: Record<string, any>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return typeof v === 'object' && v !== null ? flattenKeys(v, path) : [path];
  });
}

// ── Extract patients keys from locale files ────────────────────────────────

const ptBRPatients = (ptBR as Record<string, any>).admin.patients;
const esPatients = (es as Record<string, any>).admin.patients;

const ptBRAllKeys = flattenKeys(ptBRPatients);
const esAllKeys = flattenKeys(esPatients);

// ── All i18n keys used in AdminPatients components ─────────────────────────

const REQUIRED_KEYS = [
  // AdminPatientsPage
  'title',
  'listTitle',
  'errorLoading',
  'noPatients',
  'searchLabel',
  'searchPlaceholder',
  'attentionLabel',
  'reasonLabel',
  'specialtyLabel',
  'dependencyLabel',
  'clearFilters',
  'pagination',
  'previousPage',
  'nextPage',
  // Attention options
  'attentionOptions.all',
  'attentionOptions.complete',
  'attentionOptions.needsAttention',
  // Reason options
  'reasonOptions.all',
  'reasonOptions.MISSING_INFO',
  // Specialty options
  'specialtyOptions.all',
  'specialtyOptions.INTELLECTUAL_DISABILITY',
  'specialtyOptions.NEUROLOGICAL',
  'specialtyOptions.MOTOR_LIMITATIONS',
  'specialtyOptions.ASD',
  'specialtyOptions.PSYCHIATRIC',
  'specialtyOptions.SOCIAL_VULNERABILITY',
  'specialtyOptions.GERIATRIC',
  'specialtyOptions.SPECIFIC_PATHOLOGY',
  'specialtyOptions.CUSTOM',
  // Dependency options
  'dependencyOptions.all',
  'dependencyOptions.SEVERE',
  'dependencyOptions.VERY_SEVERE',
  'dependencyOptions.MODERATE',
  'dependencyOptions.MILD',
  // Table headers
  'table.name',
  'table.document',
  'table.dependency',
  'table.specialty',
  'table.service',
  'table.status',
  'table.registeredAt',
  'table.view',
  // Status badge
  'statusBadge.complete',
  'statusBadge.needsAttention',
  // Stats cards
  'stats.total',
  'stats.complete',
  'stats.needsAttention',
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AdminPatients i18n — key completeness', () => {
  it.each(REQUIRED_KEYS)(
    'pt-BR has translation for key "%s"',
    (key) => {
      const value = getNestedValue(ptBRPatients, key);
      expect(value).toBeDefined();
      expect(String(value).trim().length).toBeGreaterThan(0);
    },
  );

  it.each(REQUIRED_KEYS)(
    'es has translation for key "%s"',
    (key) => {
      const value = getNestedValue(esPatients, key);
      expect(value).toBeDefined();
      expect(String(value).trim().length).toBeGreaterThan(0);
    },
  );
});

describe('AdminPatients i18n — locale parity', () => {
  it('pt-BR and es have the same set of patients keys', () => {
    const ptBRSet = new Set(ptBRAllKeys);
    const esSet = new Set(esAllKeys);

    const missingInEs = ptBRAllKeys.filter((k) => !esSet.has(k));
    const missingInPtBR = esAllKeys.filter((k) => !ptBRSet.has(k));

    expect(missingInEs).toEqual([]);
    expect(missingInPtBR).toEqual([]);
  });
});

describe('AdminPatients i18n — translations are user-friendly', () => {
  it.each(REQUIRED_KEYS)(
    'pt-BR translation for "%s" is not the raw key',
    (key) => {
      const value = getNestedValue(ptBRPatients, key);
      expect(value).not.toBe(key);
      expect(value).not.toBe(`admin.patients.${key}`);
    },
  );

  it.each(REQUIRED_KEYS)(
    'es translation for "%s" is not the raw key',
    (key) => {
      const value = getNestedValue(esPatients, key);
      expect(value).not.toBe(key);
      expect(value).not.toBe(`admin.patients.${key}`);
    },
  );

  it('pt-BR translations contain Portuguese-language labels', () => {
    expect(ptBRPatients.title).toBe('Pacientes');
    expect(ptBRPatients.listTitle).toBe('Lista de Pacientes');
    expect(ptBRPatients.noPatients).toBe('Nenhum paciente encontrado');
    expect(ptBRPatients.table.name).toBe('Nome');
    expect(ptBRPatients.dependencyOptions.SEVERE).toBe('Grave');
    expect(ptBRPatients.dependencyOptions.VERY_SEVERE).toBe('Muito grave');
    expect(ptBRPatients.specialtyOptions.INTELLECTUAL_DISABILITY).toBe('Deficiência Intelectual');
    expect(ptBRPatients.specialtyOptions.ASD).toBe('TEA');
  });

  it('es translations contain Spanish-language labels', () => {
    expect(esPatients.title).toBe('Pacientes');
    expect(esPatients.listTitle).toBe('Lista de Pacientes');
    expect(esPatients.noPatients).toBe('No se encontraron pacientes');
    expect(esPatients.table.name).toBe('Nombre');
    expect(esPatients.dependencyOptions.SEVERE).toBe('Grave');
    expect(esPatients.dependencyOptions.VERY_SEVERE).toBe('Muy grave');
    expect(esPatients.specialtyOptions.INTELLECTUAL_DISABILITY).toBe('Discapacidad Intelectual');
    expect(esPatients.specialtyOptions.ASD).toBe('TEA');
  });
});

// ── Guard: nav key exists in both locales ─────────────────────────────────

const esNav = (es as Record<string, any>).admin.nav;
const ptBRNav = (ptBR as Record<string, any>).admin.nav;

describe('AdminPatients i18n — nav key guard', () => {
  it('es admin.nav.patients is "Pacientes"', () => {
    expect(esNav.patients).toBe('Pacientes');
  });

  it('pt-BR admin.nav.patients is "Pacientes"', () => {
    expect(ptBRNav.patients).toBe('Pacientes');
  });
});
