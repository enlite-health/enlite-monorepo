import { describe, expect, it } from 'vitest';
import { VACANCY_FUNNEL_COLUMNS, FUNNEL_TABS, columnItems, columnCount } from '../funnelTabsConfig';

describe('funnelTabsConfig', () => {
  it('VACANCY_FUNNEL_COLUMNS segue a ordem literal do quadro B (D433)', () => {
    expect(VACANCY_FUNNEL_COLUMNS.map((c) => c.id)).toEqual([
      'INVITED',
      'INICIADO',
      'PRE_SCREENING',
      'COMPLETED',
      'CONFIRMED',
      'SELECTED',
      'REJECTED',
    ]);
  });

  it('columnCount soma PRE_SCREENING + IN_PROGRESS', () => {
    const preScreening = VACANCY_FUNNEL_COLUMNS.find((c) => c.id === 'PRE_SCREENING')!;
    expect(columnCount(preScreening, { PRE_SCREENING: 1, IN_PROGRESS: 1 })).toBe(2);
  });

  it('columnItems concatena as duas fontes', () => {
    const preScreening = VACANCY_FUNNEL_COLUMNS.find((c) => c.id === 'PRE_SCREENING')!;
    const items = columnItems(preScreening, { PRE_SCREENING: ['a'], IN_PROGRESS: ['b'] });
    expect(items).toEqual(['a', 'b']);
  });

  it('FUNNEL_TABS segue a ordem da DX-2.6', () => {
    expect(FUNNEL_TABS.map((t) => t.key)).toEqual([
      'ALL',
      'INVITED',
      'INICIADO',
      'PRE_SCREENING',
      'COMPLETED',
      'CONFIRMED',
      'SELECTED',
      'REJECTED',
      'POSTULATED',
      'PRE_SELECTED',
      'WITHDREW',
    ]);
  });

  it('nenhum id de coluna é BLOQUEADO nem IN_PROGRESS', () => {
    const ids = VACANCY_FUNNEL_COLUMNS.map((c) => c.id);
    expect(ids).not.toContain('BLOQUEADO');
    expect(ids).not.toContain('IN_PROGRESS');
    const tabKeys = FUNNEL_TABS.map((t) => t.key);
    expect(tabKeys).not.toContain('BLOQUEADO');
    expect(tabKeys).not.toContain('IN_PROGRESS');
  });
});
