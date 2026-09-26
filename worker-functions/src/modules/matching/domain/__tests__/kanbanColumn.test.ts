import {
  deriveKanbanColumn,
  isMatchedNotInvited,
  kanbanColumnRank,
  mostAdvancedColumn,
  tallyKanbanColumns,
  FUNNEL_COLUMNS,
  KANBAN_COLUMN_BLOCKED,
  type KanbanColumn,
  type KanbanTallyRow,
} from '../kanbanColumn';

/**
 * Single source of truth for the WJA stage → Kanban column mapping.
 * These cases mirror the inline classification in WJAFunnelController
 * (getEncuadreFunnel) so the worker-detail tab and the vacancy Kanban never drift.
 */
describe('deriveKanbanColumn', () => {
  it('maps terminal stages to their own column', () => {
    expect(deriveKanbanColumn('SELECTED', 'talentum')).toBe('SELECTED');
    expect(deriveKanbanColumn('REJECTED', 'manual')).toBe('REJECTED');
    expect(deriveKanbanColumn('CONFIRMED', 'talentum')).toBe('CONFIRMED');
  });

  it('groups COMPLETED / QUALIFIED / IN_DOUBT into COMPLETED', () => {
    expect(deriveKanbanColumn('COMPLETED', 'talentum')).toBe('COMPLETED');
    expect(deriveKanbanColumn('QUALIFIED', 'talentum')).toBe('COMPLETED');
    expect(deriveKanbanColumn('IN_DOUBT', 'talentum')).toBe('COMPLETED');
  });

  it('maps IN_PROGRESS', () => {
    expect(deriveKanbanColumn('IN_PROGRESS', 'talentum')).toBe('IN_PROGRESS');
  });

  it('maps PRE_SCREENING', () => {
    expect(deriveKanbanColumn('PRE_SCREENING', 'talentum')).toBe('PRE_SCREENING');
  });

  /**
   * Migration 264 (Fase-2 do redesenho, PR #95): INITIATED removido do CHECK
   * de application_funnel_stage — não é mais um valor gravável. O fallback
   * para 'unknown stage' (INVITED) é o comportamento correto agora, não uma
   * regressão do transitório da Fase-1 (migration 230).
   */
  it('no longer special-cases INITIATED (removed from the DB CHECK in migration 264) — falls back to INVITED', () => {
    expect(deriveKanbanColumn('INITIATED', 'talentum')).toBe('INVITED');
  });

  it('INVITED + source=manual is a real manual postulation → INICIADO', () => {
    expect(deriveKanbanColumn('INVITED', 'manual')).toBe('INICIADO');
  });

  it('INVITED from the auto-invite system (non-manual) → INVITED', () => {
    expect(deriveKanbanColumn('INVITED', 'talentum')).toBe('INVITED');
    expect(deriveKanbanColumn('INVITED', null)).toBe('INVITED');
  });

  it('null / unknown stage falls back to INVITED', () => {
    expect(deriveKanbanColumn(null, 'manual')).toBe('INVITED');
    expect(deriveKanbanColumn('SOMETHING_NEW', 'talentum')).toBe('INVITED');
  });

  it('maps a blocked attempt to REJECTED (D433)', () => {
    expect(KANBAN_COLUMN_BLOCKED).toBe('REJECTED');
  });
});

/**
 * isMatchedNotInvited — a WJA persisted by the matchmaking algorithm
 * (source='system', stage='INVITED') that was never actually messaged
 * (messaged_at IS NULL) is a *match candidate*, NOT an invitation. Including it
 * in the "Invitados" column inflates the metric (ClickUp 86ajb48v1 AC2:
 * "colocar todos está gerando uma métrica falsa"). This predicate flags those
 * rows so the funnel can skip them.
 */
describe('isMatchedNotInvited', () => {
  it('is true for a system match that was never messaged', () => {
    expect(isMatchedNotInvited('INVITED', 'system', null)).toBe(true);
  });

  it('is false once the system candidate has been messaged (real invite)', () => {
    expect(isMatchedNotInvited('INVITED', 'system', '2026-07-09T10:00:00Z')).toBe(false);
  });

  it('is false for manual postulations (source=manual) even without messaged_at', () => {
    expect(isMatchedNotInvited('INVITED', 'manual', null)).toBe(false);
  });

  it('is false for talentum-sourced rows', () => {
    expect(isMatchedNotInvited('INVITED', 'talentum', null)).toBe(false);
  });

  it('is false once the system candidate advanced past INVITED', () => {
    expect(isMatchedNotInvited('PRE_SCREENING', 'system', null)).toBe(false);
    expect(isMatchedNotInvited('SELECTED', 'system', null)).toBe(false);
  });
});

/**
 * Column advancement order — used by the management dashboard to collapse a worker
 * with N applications into the single column that describes where that person is.
 */
describe('kanbanColumnRank', () => {
  /** Every application_funnel_stage the DB CHECK accepts (migrations 190 + 230). */
  const ALL_STAGES = [
    'INVITED', 'PRE_SCREENING', 'INITIATED', 'IN_PROGRESS', 'COMPLETED',
    'ANALYZED', 'IN_DOUBT', 'QUALIFIED', 'NOT_QUALIFIED', 'REPROGRAM',
    'CONFIRMED', 'SELECTED', 'REJECTED', null, 'SOMETHING_NEW',
  ];
  const ALL_SOURCES = ['manual', 'system', 'talentum', null];

  it('ranks every column deriveKanbanColumn can ever produce', () => {
    for (const stage of ALL_STAGES) {
      for (const source of ALL_SOURCES) {
        const column = deriveKanbanColumn(stage, source);
        expect(() => kanbanColumnRank(column)).not.toThrow();
      }
    }
  });

  it('throws for a column with no declared rank (build-breaker, not a silent drop)', () => {
    expect(() => kanbanColumnRank('BLOQUEADO' as KanbanColumn)).toThrow(/no declared advancement rank/);
    expect(() => kanbanColumnRank('MADE_UP' as KanbanColumn)).toThrow();
  });

  it('orders the funnel from least to most advanced', () => {
    const ranked = [...FUNNEL_COLUMNS].sort((a, b) => kanbanColumnRank(a) - kanbanColumnRank(b));
    expect(ranked).toEqual([
      'REJECTED', 'INVITED', 'INICIADO', 'PRE_SCREENING',
      'IN_PROGRESS', 'COMPLETED', 'CONFIRMED', 'SELECTED',
    ]);
  });

  /**
   * Regression guard for design decision D2: the DB function funnel_stage_precedence
   * ranks REJECTED == SELECTED (both 7), which is correct for the upsert guard and
   * WRONG here. If someone ever "simplifies" this by reusing that ranking, this fails.
   */
  it('ranks REJECTED below every active column — a rejection on one vacancy does not define the worker', () => {
    for (const column of FUNNEL_COLUMNS) {
      if (column === 'REJECTED') continue;
      expect(kanbanColumnRank('REJECTED')).toBeLessThan(kanbanColumnRank(column));
    }
  });
});

describe('mostAdvancedColumn', () => {
  it('collapses a worker rejected on vacancy A and in progress on vacancy B to IN_PROGRESS', () => {
    expect(mostAdvancedColumn('REJECTED', 'IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(mostAdvancedColumn('IN_PROGRESS', 'REJECTED')).toBe('IN_PROGRESS');
  });

  it('keeps the furthest column when the worker advanced on one of the vacancies', () => {
    expect(mostAdvancedColumn('INVITED', 'SELECTED')).toBe('SELECTED');
    expect(mostAdvancedColumn('COMPLETED', 'PRE_SCREENING')).toBe('COMPLETED');
  });

  it('is stable for equal columns', () => {
    expect(mostAdvancedColumn('CONFIRMED', 'CONFIRMED')).toBe('CONFIRMED');
  });
});

/**
 * A dobra única da contagem por coluna — os MESMOS recortes do Kanban
 * (isMatchedNotInvited + deriveKanbanColumn), agora sobre linhas já agrupadas.
 */
describe('tallyKanbanColumns', () => {
  const row = (overrides: Partial<KanbanTallyRow>): KanbanTallyRow => ({
    kind: 'wja',
    stage: null,
    source: null,
    messaged: false,
    n: 1,
    ...overrides,
  });

  it('classifica INVITED+manual como INICIADO e INVITED+system+messaged como INVITED', () => {
    const tally = tallyKanbanColumns([
      row({ stage: 'INVITED', source: 'manual' }),
      row({ stage: 'INVITED', source: 'system', messaged: true }),
    ]);
    expect(tally.INICIADO).toBe(1);
    expect(tally.INVITED).toBe(1);
  });

  it('descarta candidato de match nunca mensageado (não conta em lugar nenhum)', () => {
    const tally = tallyKanbanColumns([row({ stage: 'INVITED', source: 'system', messaged: false })]);
    const total = Object.values(tally).reduce((acc, n) => acc + n, 0);
    expect(total).toBe(0);
  });

  it('mantém IN_PROGRESS separado de PRE_SCREENING (a união é feita no front)', () => {
    const tally = tallyKanbanColumns([row({ stage: 'IN_PROGRESS' })]);
    expect(tally.IN_PROGRESS).toBe(1);
    expect(tally.PRE_SCREENING).toBe(0);
  });

  it('soma tentativas negadas (kind=blocked) em REJECTED', () => {
    const tally = tallyKanbanColumns([row({ kind: 'blocked', n: 2 })]);
    expect(tally.REJECTED).toBe(2);
  });

  it('devolve as 8 colunas, todas zero, quando não há linhas', () => {
    const tally = tallyKanbanColumns([]);
    expect(Object.keys(tally)).toHaveLength(8);
    expect(Object.values(tally).every((n) => n === 0)).toBe(true);
  });
});
