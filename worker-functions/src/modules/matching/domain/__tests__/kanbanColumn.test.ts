import {
  deriveKanbanColumn,
  isMatchedNotInvited,
  kanbanColumnRank,
  mostAdvancedColumn,
  tallyKanbanColumns,
  emptyFunnelColumnCounts,
  boardPosition,
  FUNNEL_COLUMNS,
  KANBAN_COLUMN_BLOCKED,
  kanbanColumnForBlocked,
  isPreIniciado,
  VACANCY_BOARD_COLUMNS,
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
    expect(deriveKanbanColumn('SELECTED', 'talentum', null)).toBe('SELECTED');
    expect(deriveKanbanColumn('REJECTED', 'manual', null)).toBe('REJECTED');
    expect(deriveKanbanColumn('CONFIRMED', 'talentum', null)).toBe('CONFIRMED');
  });

  /** Fase 4 (D430): destino do arrasto manual do quadro B, entre SELECTED e REJECTED. */
  it('maps QUICK_RESPONSE_TEAM to its own column', () => {
    expect(deriveKanbanColumn('QUICK_RESPONSE_TEAM', null, null)).toBe('QUICK_RESPONSE_TEAM');
  });

  it('groups COMPLETED / QUALIFIED / IN_DOUBT into COMPLETED', () => {
    expect(deriveKanbanColumn('COMPLETED', 'talentum', null)).toBe('COMPLETED');
    expect(deriveKanbanColumn('QUALIFIED', 'talentum', null)).toBe('COMPLETED');
    expect(deriveKanbanColumn('IN_DOUBT', 'talentum', null)).toBe('COMPLETED');
  });

  it('maps IN_PROGRESS', () => {
    expect(deriveKanbanColumn('IN_PROGRESS', 'talentum', null)).toBe('IN_PROGRESS');
  });

  it('maps PRE_SCREENING', () => {
    expect(deriveKanbanColumn('PRE_SCREENING', 'talentum', null)).toBe('PRE_SCREENING');
  });

  /**
   * Migration 264 (Fase-2 do redesenho, PR #95): INITIATED removido do CHECK
   * de application_funnel_stage — não é mais um valor gravável. O fallback
   * para 'unknown stage' (INVITED) é o comportamento correto agora, não uma
   * regressão do transitório da Fase-1 (migration 230).
   */
  it('no longer special-cases INITIATED (removed from the DB CHECK in migration 264) — falls back to INVITED', () => {
    expect(deriveKanbanColumn('INITIATED', 'talentum', null)).toBe('INVITED');
  });

  it('INVITED + source=manual is a real manual postulation → INICIADO', () => {
    expect(deriveKanbanColumn('INVITED', 'manual', null)).toBe('INICIADO');
  });

  it('INVITED from the auto-invite system (non-manual) → INVITED', () => {
    expect(deriveKanbanColumn('INVITED', 'talentum', null)).toBe('INVITED');
    expect(deriveKanbanColumn('INVITED', null, null)).toBe('INVITED');
  });

  it('null / unknown stage falls back to INVITED', () => {
    expect(deriveKanbanColumn(null, 'manual', null)).toBe('INVITED');
    expect(deriveKanbanColumn('SOMETHING_NEW', 'talentum', null)).toBe('INVITED');
  });

  it('maps an active blocked attempt to INICIADO (D474, revoga D433 item 5)', () => {
    expect(KANBAN_COLUMN_BLOCKED).toBe('INICIADO');
    expect(kanbanColumnForBlocked(false)).toBe('INICIADO');
  });

  it('a DISMISSED blocked attempt ("Rechazar", E2) stays in REJECTED', () => {
    expect(kanbanColumnForBlocked(true)).toBe('REJECTED');
  });

  it('isPreIniciado: só INVITED sem source manual (convite/match do sistema); o resto não', () => {
    expect(isPreIniciado('INVITED', 'system')).toBe(true);
    expect(isPreIniciado('INVITED', null)).toBe(true);
    expect(isPreIniciado('INVITED', 'manual')).toBe(false);
    expect(isPreIniciado('PRE_SCREENING', 'system')).toBe(false);
    expect(isPreIniciado('SELECTED', 'system')).toBe(false);
    expect(isPreIniciado('REJECTED', 'system')).toBe(false);
  });
});

/**
 * COMPATIBLE (Fase 5, D432): candidato do match (source='system', stage='INVITED')
 * nunca mensageado. Antes descartado (continue) do Kanban/contagem; agora deriva
 * na SSOT e aparece como coluna própria nos 3 lugares (kanbanColumn.ts, DX-5.1).
 */
describe('deriveKanbanColumn — COMPATIBLE (Fase 5, D432)', () => {
  it('candidato do match nunca mensageado deriva COMPATIBLE', () => {
    expect(deriveKanbanColumn('INVITED', 'system', null)).toBe('COMPATIBLE');
  });

  it('candidato do match já mensageado (convite real) deriva INVITED', () => {
    expect(deriveKanbanColumn('INVITED', 'system', '2026-09-01T00:00:00Z')).toBe('INVITED');
  });

  it('postulação manual (source=manual) deriva INICIADO mesmo sem messaged_at', () => {
    expect(deriveKanbanColumn('INVITED', 'manual', null)).toBe('INICIADO');
  });

  it('rejeitado nunca volta a COMPATIBLE, mesmo sem messaged_at', () => {
    expect(deriveKanbanColumn('REJECTED', 'system', null)).toBe('REJECTED');
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
        const column = deriveKanbanColumn(stage, source, null);
        expect(() => kanbanColumnRank(column)).not.toThrow();
      }
    }
  });

  it('throws for a column with no declared rank (build-breaker, not a silent drop)', () => {
    expect(() => kanbanColumnRank('BLOQUEADO' as KanbanColumn)).toThrow(/no declared advancement rank/);
    expect(() => kanbanColumnRank('MADE_UP' as KanbanColumn)).toThrow();
  });

  it('orders the funnel from least to most advanced (Fase 5: +COMPATIBLE entre REJECTED e INVITED)', () => {
    const ranked = [...FUNNEL_COLUMNS].sort((a, b) => kanbanColumnRank(a) - kanbanColumnRank(b));
    expect(ranked).toEqual([
      'REJECTED', 'COMPATIBLE', 'INVITED', 'INICIADO', 'PRE_SCREENING',
      'IN_PROGRESS', 'COMPLETED', 'CONFIRMED', 'SELECTED', 'QUICK_RESPONSE_TEAM',
    ]);
  });

  /** Fase 5 (DX-5.1): COMPATIBLE é candidato do match sem convite — menos avançado que INVITED. */
  it('ranks COMPATIBLE between REJECTED and INVITED', () => {
    expect(kanbanColumnRank('COMPATIBLE')).toBeGreaterThan(kanbanColumnRank('REJECTED'));
    expect(kanbanColumnRank('COMPATIBLE')).toBeLessThan(kanbanColumnRank('INVITED'));
  });

  /** Fase 4 (DX-4.8): QUICK_RESPONSE_TEAM entra depois de SELECTED — mais avançada. */
  it('ranks QUICK_RESPONSE_TEAM above SELECTED', () => {
    expect(kanbanColumnRank('QUICK_RESPONSE_TEAM')).toBeGreaterThan(kanbanColumnRank('SELECTED'));
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

  it('conta candidato de match nunca mensageado em COMPATIBLE, não mais descartado (Fase 5: +COMPATIBLE)', () => {
    const tally = tallyKanbanColumns([row({ stage: 'INVITED', source: 'system', messaged: false })]);
    expect(tally.COMPATIBLE).toBe(1);
    const total = Object.values(tally).reduce((acc, n) => acc + n, 0);
    expect(total).toBe(1);
  });

  it('mantém IN_PROGRESS separado de PRE_SCREENING (a união é feita no front)', () => {
    const tally = tallyKanbanColumns([row({ stage: 'IN_PROGRESS' })]);
    expect(tally.IN_PROGRESS).toBe(1);
    expect(tally.PRE_SCREENING).toBe(0);
  });

  it('soma tentativas negadas ativas (kind=blocked) em INICIADO — E3: o contador bate com os cards', () => {
    const tally = tallyKanbanColumns([row({ kind: 'blocked', n: 2 })]);
    expect(tally.INICIADO).toBe(2);
    expect(tally.REJECTED).toBe(0);
  });

  it('tentativa negada DISPENSADA (dismissed) conta em REJECTED, não em INICIADO', () => {
    const tally = tallyKanbanColumns([
      row({ kind: 'blocked', n: 2 }),
      row({ kind: 'blocked', n: 1, dismissed: true }),
    ]);
    expect(tally.INICIADO).toBe(2);
    expect(tally.REJECTED).toBe(1);
  });

  it('devolve as 10 colunas, todas zero, quando não há linhas (Fase 5: + COMPATIBLE)', () => {
    const tally = tallyKanbanColumns([]);
    expect(Object.keys(tally)).toHaveLength(10);
    expect(Object.values(tally).every((n) => n === 0)).toBe(true);
  });
});

/** emptyFunnelColumnCounts — todas as colunas do funil, nunca uma chave ausente. */
describe('emptyFunnelColumnCounts', () => {
  it('tem 10 chaves (Fase 5: + COMPATIBLE)', () => {
    expect(Object.keys(emptyFunnelColumnCounts())).toHaveLength(10);
  });
});

/**
 * VACANCY_BOARD_COLUMNS / boardPosition — a ordem que o operador vê no quadro B
 * (DX-4.5), base do "salto" que WF/domain/moveReason.ts consome (P6).
 */
describe('VACANCY_BOARD_COLUMNS / boardPosition', () => {
  it('tem as 9 colunas do quadro, na ordem do operador (Fase 5: +COMPATIBLE na posição 0)', () => {
    expect(VACANCY_BOARD_COLUMNS).toEqual([
      'COMPATIBLE', 'INVITED', 'INICIADO', 'PRE_SCREENING', 'COMPLETED',
      'CONFIRMED', 'SELECTED', 'QUICK_RESPONSE_TEAM', 'REJECTED',
    ]);
  });

  it('IN_PROGRESS mora na mesma posição de PRE_SCREENING', () => {
    expect(boardPosition('IN_PROGRESS', null, null)).toBe(boardPosition('PRE_SCREENING', null, null));
  });

  it('origem sem candidatura (stage e source nulos) é a posição 1 (INVITED, mesmo fallback da SSOT; Fase 5: COMPATIBLE ocupa a 0)', () => {
    expect(boardPosition(null, null, null)).toBe(1);
  });

  it('INVITED+manual (INICIADO) é a posição 2 (Fase 5: +COMPATIBLE desloca)', () => {
    expect(boardPosition('INVITED', 'manual', null)).toBe(2);
  });

  it('QUALIFIED (colapsado em COMPLETED) é a posição 4 (Fase 5: +COMPATIBLE desloca)', () => {
    expect(boardPosition('QUALIFIED', null, null)).toBe(4);
  });

  /** Fase 5 (DX-5.1): candidato do match nunca mensageado ocupa a posição 0 do quadro. */
  it('candidato de match nunca mensageado (COMPATIBLE) é a posição 0', () => {
    expect(boardPosition('INVITED', 'system', null)).toBe(0);
  });
});
