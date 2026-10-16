import { describe, it, expect } from 'vitest';
import type { FunnelTableRow } from '@domain/entities/Funnel';
import { filterFunnelRows, hasActiveFilters } from './funnelRowFilter';

function row(id: string, over: Partial<FunnelTableRow> = {}): FunnelTableRow {
  return {
    id,
    workerId: `w-${id}`,
    workerName: `Nome ${id}`,
    workerEmail: null,
    workerPhone: null,
    workerAvatarUrl: null,
    invitedAt: '2026-01-15T00:00:00.000Z',
    funnelStage: 'INVITED',
    whatsappStatus: null,
    whatsappLastDispatchedAt: null,
    accepted: null,
    interviewResponse: null,
    registrationComplete: true,
    contactNotesCount: 0,
    kanbanColumn: 'INVITED',
    isBlocked: false,
    ...over,
  };
}

const ids = (rows: FunnelTableRow[]) => rows.map((r) => r.id);
const all = { registration: 'ALL' as const };

describe('filterFunnelRows — nome', () => {
  const rows = [
    row('maria', { workerName: 'María López' }),
    row('marcos', { workerName: 'MARCOS Díaz' }),
    row('juan', { workerName: 'Juan Pérez' }),
  ];

  it('"mar" acha María e MARCOS (sem diferenciar caixa nem acento)', () => {
    expect(ids(filterFunnelRows(rows, { ...all, query: 'mar' }))).toEqual(['maria', 'marcos']);
  });

  it('"maria" (sem acento) acha María', () => {
    expect(ids(filterFunnelRows(rows, { ...all, query: 'maria' }))).toEqual(['maria']);
  });

  it('"PEREZ" acha Pérez (caixa e acento nos dois lados)', () => {
    expect(ids(filterFunnelRows(rows, { ...all, query: 'PEREZ' }))).toEqual(['juan']);
  });

  it('nome nulo não casa e não quebra', () => {
    expect(filterFunnelRows([row('x', { workerName: null })], { ...all, query: 'mar' })).toEqual([]);
  });

  it('query vazia ou só espaços não filtra', () => {
    expect(filterFunnelRows(rows, { ...all, query: '' })).toHaveLength(3);
    expect(filterFunnelRows(rows, { ...all, query: '   ' })).toHaveLength(3);
  });
});

describe('filterFunnelRows — telefone (só dígitos)', () => {
  const rows = [
    row('a', { workerName: 'Ana', workerPhone: '+54 9 11 1234-5678' }),
    row('b', { workerName: 'Beto', workerPhone: '+54 9 351 999-0000' }),
    row('c', { workerName: 'Caio', workerPhone: null }),
  ];

  it.each(['1234', '+54 9 11', '11 1234', '54-9', '5678', '(11) 1234'])(
    'a busca "%s" acha a linha pelo telefone, com ou sem +, espaço ou hífen',
    (query) => {
      expect(ids(filterFunnelRows(rows, { ...all, query }))).toContain('a');
    },
  );

  it('um trecho que só existe no outro telefone não acha a linha errada', () => {
    expect(ids(filterFunnelRows(rows, { ...all, query: '999-0000' }))).toEqual(['b']);
  });

  it('texto sem dígito não casa pelo telefone', () => {
    // "-" e "+" existem no telefone cru; sem dígito na busca, o telefone nem é consultado.
    expect(filterFunnelRows(rows, { ...all, query: '-' })).toEqual([]);
    expect(filterFunnelRows(rows, { ...all, query: '+' })).toEqual([]);
  });

  it('telefone nulo não casa quando a busca tem dígitos', () => {
    expect(ids(filterFunnelRows(rows, { ...all, query: '1234' }))).not.toContain('c');
  });
});

describe('filterFunnelRows — registro e combinação', () => {
  const rows = [
    row('ok1', { workerName: 'Marta', registrationComplete: true }),
    row('ok2', { workerName: 'Pedro', registrationComplete: true }),
    row('no1', { workerName: 'Marcelo', registrationComplete: false }),
    row('no2', { workerName: 'Lucía', registrationComplete: false }),
  ];

  it('Completo mostra só registrationComplete = true', () => {
    expect(ids(filterFunnelRows(rows, { query: '', registration: 'COMPLETE' }))).toEqual(['ok1', 'ok2']);
  });

  it('Incompleto mostra só registrationComplete = false', () => {
    expect(ids(filterFunnelRows(rows, { query: '', registration: 'INCOMPLETE' }))).toEqual(['no1', 'no2']);
  });

  it('Todos não filtra', () => {
    expect(filterFunnelRows(rows, { query: '', registration: 'ALL' })).toHaveLength(4);
  });

  it('busca + registro valem juntos (E)', () => {
    expect(ids(filterFunnelRows(rows, { query: 'mar', registration: 'COMPLETE' }))).toEqual(['ok1']);
    expect(ids(filterFunnelRows(rows, { query: 'mar', registration: 'INCOMPLETE' }))).toEqual(['no1']);
  });
});

describe('hasActiveFilters', () => {
  it('só é falso no padrão (busca vazia/espaços e Todos)', () => {
    expect(hasActiveFilters({ query: '', registration: 'ALL' })).toBe(false);
    expect(hasActiveFilters({ query: '  ', registration: 'ALL' })).toBe(false);
    expect(hasActiveFilters({ query: 'a', registration: 'ALL' })).toBe(true);
    expect(hasActiveFilters({ query: '', registration: 'COMPLETE' })).toBe(true);
  });
});
