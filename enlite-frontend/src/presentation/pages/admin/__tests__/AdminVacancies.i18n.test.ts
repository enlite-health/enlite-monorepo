/**
 * AdminVacancies.i18n.test.ts
 *
 * Garante que TODAS as chaves i18n usadas nos componentes de vacantes
 * existem em ambos os locales (es e pt-BR), têm valores não-vazios,
 * e NÃO estão em CAIXA ALTA (devem usar capitalização normal).
 */

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

// ── Extract vacancies keys from locale files ──────────────────────────────

const ptBRVacancies = (ptBR as Record<string, any>).admin.vacancies;
const esVacancies = (es as Record<string, any>).admin.vacancies;

const ptBRAllKeys = flattenKeys(ptBRVacancies);
const esAllKeys = flattenKeys(esVacancies);

// ── All i18n keys used in AdminVacancies components ───────────────────────

const REQUIRED_KEYS = [
  // AdminVacanciesPage
  'title',
  'vacanciesTitle',
  'new',
  'pagination',
  'previousPage',
  'nextPage',
  'errorLoading',
  'searchPlaceholder',
  'noVacancies',
  // Filter labels
  'statusLabel',
  'priorityLabel',
  // Table headers
  'table.case',
  'table.status',
  'table.priority',
  'table.invited',
  'table.applicants',
  'table.selected',
  'table.missing',
  'table.view',
  'table.edit',
  // Status options — 8 valores canônicos do banco
  'statusOptions.all',
  'statusOptions.searching',
  'statusOptions.searchingReplacement',
  'statusOptions.rapidResponse',
  'statusOptions.pendingActivation',
  'statusOptions.active',
  'statusOptions.onHold',
  'statusOptions.suspended',
  'statusOptions.closed',
  // Priority options
  'priorityOptions.all',
  'priorityOptions.urgent',
  'priorityOptions.high',
  'priorityOptions.normal',
  'priorityOptions.low',
  // Stats
  'stats.moreThan7Days',
  'stats.moreThan24Days',
  'stats.inSelection',
  'stats.totalVacancies',
];

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AdminVacancies i18n — key completeness', () => {
  it.each(REQUIRED_KEYS)(
    'es has translation for key "%s"',
    (key) => {
      const value = getNestedValue(esVacancies, key);
      expect(value).toBeDefined();
      expect(String(value).trim().length).toBeGreaterThan(0);
    },
  );

  it.each(REQUIRED_KEYS)(
    'pt-BR has translation for key "%s"',
    (key) => {
      const value = getNestedValue(ptBRVacancies, key);
      expect(value).toBeDefined();
      expect(String(value).trim().length).toBeGreaterThan(0);
    },
  );
});

describe('AdminVacancies i18n — locale parity', () => {
  it('pt-BR and es have the same set of vacancies keys', () => {
    const ptBRSet = new Set(ptBRAllKeys);
    const esSet = new Set(esAllKeys);

    const missingInEs = ptBRAllKeys.filter((k) => !esSet.has(k));
    const missingInPtBR = esAllKeys.filter((k) => !ptBRSet.has(k));

    expect(missingInEs).toEqual([]);
    expect(missingInPtBR).toEqual([]);
  });

  it('keys for the removed Clientes filter are gone from both locales', () => {
    expect(esVacancies.clients).toBeUndefined();
    expect(esVacancies.clientPlaceholder).toBeUndefined();
    expect(esVacancies.clientOptions).toBeUndefined();
    expect(ptBRVacancies.clients).toBeUndefined();
    expect(ptBRVacancies.clientPlaceholder).toBeUndefined();
    expect(ptBRVacancies.clientOptions).toBeUndefined();
  });

  it('removed dependencyLevel column label is gone from table keys', () => {
    expect(esVacancies.table.dependencyLevel).toBeUndefined();
    expect(ptBRVacancies.table.dependencyLevel).toBeUndefined();
  });
});

describe('AdminVacancies i18n — translations are user-friendly', () => {
  it.each(REQUIRED_KEYS)(
    'es translation for "%s" is not the raw key',
    (key) => {
      const value = getNestedValue(esVacancies, key);
      expect(value).not.toBe(key);
      expect(value).not.toBe(`admin.vacancies.${key}`);
    },
  );

  it.each(REQUIRED_KEYS)(
    'pt-BR translation for "%s" is not the raw key',
    (key) => {
      const value = getNestedValue(ptBRVacancies, key);
      expect(value).not.toBe(key);
      expect(value).not.toBe(`admin.vacancies.${key}`);
    },
  );
});

// ── GARANTIA VISUAL: table headers NÃO estão em CAIXA ALTA ───────────────

const TABLE_HEADER_KEYS = [
  'table.case',
  'table.status',
  'table.priority',
  'table.invited',
  'table.applicants',
  'table.selected',
  'table.missing',
];

describe('AdminVacancies i18n — table headers must NOT be ALL CAPS', () => {
  it.each(TABLE_HEADER_KEYS)(
    'es table header "%s" is not ALL CAPS',
    (key) => {
      const value = getNestedValue(esVacancies, key) as string;
      expect(value).not.toBe(value.toUpperCase());
    },
  );

  it.each(TABLE_HEADER_KEYS)(
    'pt-BR table header "%s" is not ALL CAPS',
    (key) => {
      const value = getNestedValue(ptBRVacancies, key) as string;
      expect(value).not.toBe(value.toUpperCase());
    },
  );
});

// ── GARANTIA: es translations contain Spanish-language labels ─────────────

describe('AdminVacancies i18n — language-specific content', () => {
  it('es translations contain correct Spanish labels', () => {
    expect(esVacancies.title).toBe('Vacantes - Solicitudes');
    expect(esVacancies.vacanciesTitle).toBe('Vacantes');
    expect(esVacancies.new).toBe('Nueva');
    expect(esVacancies.noVacancies).toBe('No se encontraron vacantes');
    expect(esVacancies.errorLoading).toBe('Error al cargar vacantes');
    expect(esVacancies.previousPage).toBe('Página anterior');
    expect(esVacancies.nextPage).toBe('Página siguiente');
    expect(esVacancies.table.case).toBe('Caso - Vacante');
    expect(esVacancies.table.status).toBe('Estado');
    expect(esVacancies.table.priority).toBe('Prioridad');
  });

  it('pt-BR translations contain correct Portuguese labels', () => {
    expect(ptBRVacancies.title).toBe('Vagas - Solicitações');
    expect(ptBRVacancies.vacanciesTitle).toBe('Vagas');
    expect(ptBRVacancies.new).toBe('Nova');
    expect(ptBRVacancies.noVacancies).toBe('Nenhuma vaga encontrada');
    expect(ptBRVacancies.errorLoading).toBe('Erro ao carregar vagas');
    expect(ptBRVacancies.previousPage).toBe('Página anterior');
    expect(ptBRVacancies.nextPage).toBe('Próxima página');
    expect(ptBRVacancies.table.case).toBe('Caso');
    expect(ptBRVacancies.table.status).toBe('Status');
    expect(ptBRVacancies.table.priority).toBe('Prioridade');
  });
});
