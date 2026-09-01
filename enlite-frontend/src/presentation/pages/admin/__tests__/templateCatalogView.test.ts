/**
 * A lógica da faixa de filtros e do indicador de sincronização, fora do
 * componente — pages só orquestram (CLAUDE.md do frontend).
 *
 * O agrupamento é a decisão que importa: PAUSED e DISABLED viram UM grupo
 * ("a Meta desligou algo que estava no ar"), separado de PENDING. São coisas
 * diferentes e a faixa não pode fundi-las.
 */
import { describe, it, expect } from 'vitest';
import { groupOf, countByGroup, filterByGroup, lastCheckedAt, relativeFrom } from '../templateCatalogView';
import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';

const row = (over: Partial<TemplateCatalogRow> = {}): TemplateCatalogRow => ({
  slug: 's', name: 's', bodyTwilio: 'x', category: 'UTILITY', isActive: true,
  contentSid: 'HX', metaStatus: 'APPROVED', metaReason: null, metaDetail: null,
  metaCheckedAt: null, eligible: true, ineligibleReason: null, placeholders: [], usedInStages: [], ...over,
});

describe('groupOf', () => {
  it.each([['APPROVED', 'approved'], ['PENDING', 'pending'], ['IN_APPEAL', 'pending'],
           ['REJECTED', 'rejected'], ['PAUSED', 'off'], ['DISABLED', 'off'], ['LIMIT_EXCEEDED', 'off']])(
    '%s -> %s', (status, esperado) => expect(groupOf(status)).toBe(esperado));

  it('nunca verificado e grupo proprio, nao "pendente"', () => {
    expect(groupOf(null)).toBe('unchecked');
    expect(groupOf(null)).not.toBe('pending');
  });

  it('PAUSED e PENDING NAO caem no mesmo grupo', () => {
    expect(groupOf('PAUSED')).not.toBe(groupOf('PENDING'));
  });

  it('estado que a Meta invente vai para "other" — visivel, nunca somido', () => {
    expect(groupOf('ALGO_NOVO')).toBe('other');
  });
});

describe('countByGroup', () => {
  it('conta por grupo e o total', () => {
    const c = countByGroup([row(), row({ metaStatus: 'PAUSED' }), row({ metaStatus: 'PAUSED' }), row({ metaStatus: null })]);
    expect(c).toMatchObject({ all: 4, approved: 1, off: 2, unchecked: 1 });
  });

  it('lista vazia da zero em tudo, sem quebrar', () => {
    expect(countByGroup([]).all).toBe(0);
  });
});

describe('filterByGroup', () => {
  const rows = [row(), row({ slug: 'p', metaStatus: 'PAUSED' }), row({ slug: 'n', metaStatus: null })];

  it('"all" devolve tudo', () => expect(filterByGroup(rows, 'all')).toHaveLength(3));
  it('filtra pelo grupo', () => expect(filterByGroup(rows, 'off').map((r) => r.slug)).toEqual(['p']));
  it('grupo sem ninguem devolve vazio, nao tudo', () => expect(filterByGroup(rows, 'rejected')).toEqual([]));
});

describe('lastCheckedAt', () => {
  it('devolve a verificacao MAIS RECENTE', () => {
    expect(lastCheckedAt([row({ metaCheckedAt: '2026-08-30T10:00:00Z' }), row({ metaCheckedAt: '2026-08-31T10:00:00Z' })]))
      .toBe('2026-08-31T10:00:00Z');
  });

  it('ignora quem nunca foi verificado', () => {
    expect(lastCheckedAt([row({ metaCheckedAt: null }), row({ metaCheckedAt: '2026-08-31T10:00:00Z' })])).toBe('2026-08-31T10:00:00Z');
  });

  it('data invalida no meio nao vira a "mais recente"', () => {
    expect(lastCheckedAt([row({ metaCheckedAt: 'lixo' }), row({ metaCheckedAt: '2026-08-31T10:00:00Z' })])).toBe('2026-08-31T10:00:00Z');
  });

  it('so datas invalidas devolve null', () => {
    expect(lastCheckedAt([row({ metaCheckedAt: 'lixo' })])).toBeNull();
  });

  it('ninguem verificado devolve null — nao inventa data', () => {
    expect(lastCheckedAt([row({ metaCheckedAt: null })])).toBeNull();
    expect(lastCheckedAt([])).toBeNull();
  });
});

describe('relativeFrom — recebe o "agora", nao le do relogio', () => {
  const agora = new Date('2026-08-31T12:00:00Z');

  it.each([
    ['2026-08-31T11:59:30Z', { unidade: 'now' }],
    ['2026-08-31T11:56:00Z', { unidade: 'min', valor: 4 }],
    ['2026-08-31T09:00:00Z', { unidade: 'hour', valor: 3 }],
    ['2026-08-29T12:00:00Z', { unidade: 'day', valor: 2 }],
  ])('%s -> %o', (iso, esperado) => expect(relativeFrom(iso, agora)).toMatchObject(esperado));

  it('data no futuro nao vira numero negativo na tela', () => {
    expect(relativeFrom('2026-08-31T13:00:00Z', agora)).toMatchObject({ unidade: 'now' });
  });

  it('data invalida devolve null em vez de "Invalid Date"', () => {
    expect(relativeFrom('nao e data', agora)).toBeNull();
  });
});
