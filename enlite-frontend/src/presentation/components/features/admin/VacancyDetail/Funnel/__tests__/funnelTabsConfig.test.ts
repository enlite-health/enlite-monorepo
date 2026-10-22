import { describe, expect, it } from 'vitest';
import { VACANCY_FUNNEL_COLUMNS, columnItems, columnCount, stageColumnIdFor } from '../funnelTabsConfig';

describe('funnelTabsConfig', () => {
  it('VACANCY_FUNNEL_COLUMNS segue a ordem literal do quadro B (D433), Compatíveis (Fase 5) na frente', () => {
    expect(VACANCY_FUNNEL_COLUMNS.map((c) => c.id)).toEqual([
      'COMPATIBLE',
      'INVITED',
      'INICIADO',
      'PRE_SCREENING',
      'BLOQUEADO',
      'COMPLETED',
      'SELECTED',
      'QUICK_RESPONSE_TEAM',
      'REJECTED',
    ]);
  });

  it('QUICK_RESPONSE_TEAM (Fase 4, DX-4.12) é droppable e sem cor literal', () => {
    const quickResponseTeam = VACANCY_FUNNEL_COLUMNS.find((c) => c.id === 'QUICK_RESPONSE_TEAM')!;
    expect(quickResponseTeam.droppable).toBe(true);
    expect(quickResponseTeam.color).toBe('bg-teal-500');
  });

  it('COMPATIBLE (Fase 5, DX-5.9) é derivada do match, só leitura', () => {
    const compatible = VACANCY_FUNNEL_COLUMNS.find((c) => c.id === 'COMPATIBLE')!;
    expect(compatible.droppable).toBe(false);
    expect(compatible.color).toBe('bg-slate-400');
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

  it('067 FR-06: Bloqueados é a 5a coluna, imediatamente antes de Completado, só leitura, cor âmbar', () => {
    const ids = VACANCY_FUNNEL_COLUMNS.map((c) => c.id);
    expect(VACANCY_FUNNEL_COLUMNS).toHaveLength(9);
    expect(ids.indexOf('BLOQUEADO')).toBe(ids.indexOf('COMPLETED') - 1);
    const bloqueado = VACANCY_FUNNEL_COLUMNS.find((c) => c.id === 'BLOQUEADO')!;
    expect(bloqueado.sources).toEqual(['BLOQUEADO']);
    expect(bloqueado.droppable).toBe(false);
    expect(bloqueado.color).toBe('bg-amber-500');
  });

  it('nenhum id de coluna é IN_PROGRESS (vira Pre Screening)', () => {
    expect(VACANCY_FUNNEL_COLUMNS.map((c) => c.id)).not.toContain('IN_PROGRESS');
  });

  it('067: columnCount lê a chave BLOQUEADO dos contadores', () => {
    const bloqueado = VACANCY_FUNNEL_COLUMNS.find((c) => c.id === 'BLOQUEADO')!;
    expect(columnCount(bloqueado, { BLOQUEADO: 3, COMPLETED: 5 })).toBe(3);
  });

  it('stageColumnIdFor mapeia as 10 sources para o id da coluna (IN_PROGRESS → PRE_SCREENING)', () => {
    expect(stageColumnIdFor('COMPATIBLE')).toBe('COMPATIBLE');
    expect(stageColumnIdFor('INVITED')).toBe('INVITED');
    expect(stageColumnIdFor('INICIADO')).toBe('INICIADO');
    expect(stageColumnIdFor('PRE_SCREENING')).toBe('PRE_SCREENING');
    expect(stageColumnIdFor('IN_PROGRESS')).toBe('PRE_SCREENING');
    expect(stageColumnIdFor('BLOQUEADO')).toBe('BLOQUEADO');
    expect(stageColumnIdFor('COMPLETED')).toBe('COMPLETED');
    expect(stageColumnIdFor('SELECTED')).toBe('SELECTED');
    expect(stageColumnIdFor('QUICK_RESPONSE_TEAM')).toBe('QUICK_RESPONSE_TEAM');
    expect(stageColumnIdFor('REJECTED')).toBe('REJECTED');
  });

  it('stageColumnIdFor devolve null para nulo, vazio e source desconhecida', () => {
    expect(stageColumnIdFor(null)).toBeNull();
    expect(stageColumnIdFor(undefined)).toBeNull();
    expect(stageColumnIdFor('')).toBeNull();
    expect(stageColumnIdFor('FOO')).toBeNull();
  });
});
