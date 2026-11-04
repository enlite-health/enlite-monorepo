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
    expect(deriveKanbanColumn('SELECTED', 'talentum', null, true)).toBe('SELECTED');
    expect(deriveKanbanColumn('REJECTED', 'manual', null, true)).toBe('REJECTED');
  });

  /** Fase 4 (D430): destino do arrasto manual do quadro B, entre SELECTED e REJECTED. */
  it('maps QUICK_RESPONSE_TEAM to its own column', () => {
    expect(deriveKanbanColumn('QUICK_RESPONSE_TEAM', null, null, true)).toBe('QUICK_RESPONSE_TEAM');
  });

  it('groups COMPLETED / QUALIFIED / IN_DOUBT into COMPLETED', () => {
    expect(deriveKanbanColumn('COMPLETED', 'talentum', null, true)).toBe('COMPLETED');
    expect(deriveKanbanColumn('QUALIFIED', 'talentum', null, true)).toBe('COMPLETED');
    expect(deriveKanbanColumn('IN_DOUBT', 'talentum', null, true)).toBe('COMPLETED');
  });

  it('maps IN_PROGRESS', () => {
    expect(deriveKanbanColumn('IN_PROGRESS', 'talentum', null, true)).toBe('IN_PROGRESS');
  });

  it('maps PRE_SCREENING', () => {
    expect(deriveKanbanColumn('PRE_SCREENING', 'talentum', null, true)).toBe('PRE_SCREENING');
  });

  /**
   * Migration 264 (Fase-2 do redesenho, PR #95): INITIATED removido do CHECK
   * de application_funnel_stage — não é mais um valor gravável. O fallback
   * para 'unknown stage' (INVITED) é o comportamento correto agora, não uma
   * regressão do transitório da Fase-1 (migration 230).
   */
  it('no longer special-cases INITIATED (removed from the DB CHECK in migration 264) — falls back to INVITED', () => {
    expect(deriveKanbanColumn('INITIATED', 'talentum', null, true)).toBe('INVITED');
  });

  it('INVITED + source=manual is a real manual postulation → INICIADO', () => {
    expect(deriveKanbanColumn('INVITED', 'manual', null, true)).toBe('INICIADO');
  });

  it('INVITED from the auto-invite system (non-manual) → INVITED', () => {
    expect(deriveKanbanColumn('INVITED', 'talentum', null, true)).toBe('INVITED');
    expect(deriveKanbanColumn('INVITED', null, null, true)).toBe('INVITED');
  });

  it('null / unknown stage falls back to INVITED', () => {
    expect(deriveKanbanColumn(null, 'manual', null, true)).toBe('INVITED');
    expect(deriveKanbanColumn('SOMETHING_NEW', 'talentum', null, true)).toBe('INVITED');
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
    expect(deriveKanbanColumn('INVITED', 'system', null, true)).toBe('COMPATIBLE');
  });

  it('candidato do match já mensageado (convite real) deriva INVITED', () => {
    expect(deriveKanbanColumn('INVITED', 'system', '2026-09-01T00:00:00Z', true)).toBe('INVITED');
  });

  it('postulação manual (source=manual) deriva INICIADO mesmo sem messaged_at', () => {
    expect(deriveKanbanColumn('INVITED', 'manual', null, true)).toBe('INICIADO');
  });

  it('rejeitado nunca volta a COMPATIBLE, mesmo sem messaged_at', () => {
    expect(deriveKanbanColumn('REJECTED', 'system', null, true)).toBe('REJECTED');
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
    'SELECTED', 'REJECTED', null, 'SOMETHING_NEW',
  ];
  const ALL_SOURCES = ['manual', 'system', 'talentum', null];

  it('ranks every column deriveKanbanColumn can ever produce', () => {
    for (const stage of ALL_STAGES) {
      for (const source of ALL_SOURCES) {
        const column = deriveKanbanColumn(stage, source, null, true);
        expect(() => kanbanColumnRank(column)).not.toThrow();
      }
    }
  });

  it('throws for a column with no declared rank (build-breaker, not a silent drop)', () => {
    expect(() => kanbanColumnRank('MADE_UP' as KanbanColumn)).toThrow(/no declared advancement rank/);
  });

  it('orders the funnel from least to most advanced (Fase 5: +COMPATIBLE entre REJECTED e INVITED)', () => {
    const ranked = [...FUNNEL_COLUMNS].sort((a, b) => kanbanColumnRank(a) - kanbanColumnRank(b));
    expect(ranked).toEqual([
      'REJECTED', 'COMPATIBLE', 'INVITED', 'INICIADO', 'PRE_SCREENING',
      'IN_PROGRESS', 'BLOQUEADO', 'COMPLETED', 'SELECTED', 'QUICK_RESPONSE_TEAM',
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
    expect(mostAdvancedColumn('COMPLETED', 'COMPLETED')).toBe('COMPLETED');
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
    apto: true,
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

  it('devolve as 9 colunas, todas zero, quando não há linhas (Fase 5: + COMPATIBLE; spec 052: sem Confirmado)', () => {
    const tally = tallyKanbanColumns([]);
    expect(Object.keys(tally)).toHaveLength(10);
    expect(Object.values(tally).every((n) => n === 0)).toBe(true);
  });
});

/** emptyFunnelColumnCounts — todas as colunas do funil, nunca uma chave ausente. */
describe('emptyFunnelColumnCounts', () => {
  it('tem 10 chaves (Fase 5: + COMPATIBLE; spec 052: sem Confirmado; spec 067: + BLOQUEADO)', () => {
    expect(Object.keys(emptyFunnelColumnCounts())).toHaveLength(10);
    expect(emptyFunnelColumnCounts().BLOQUEADO).toBe(0);
  });
});

/**
 * VACANCY_BOARD_COLUMNS / boardPosition — a ordem que o operador vê no quadro B
 * (DX-4.5), base do "salto" que WF/domain/moveReason.ts consome (P6).
 */
describe('VACANCY_BOARD_COLUMNS / boardPosition', () => {
  it('tem as 9 colunas do quadro, na ordem do operador (spec 067: Bloqueados imediatamente antes de Completado)', () => {
    expect(VACANCY_BOARD_COLUMNS).toEqual([
      'COMPATIBLE', 'INVITED', 'INICIADO', 'PRE_SCREENING', 'BLOQUEADO', 'COMPLETED',
      'SELECTED', 'QUICK_RESPONSE_TEAM', 'REJECTED',
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

/**
 * Spec 067 (FR-06/08/12) — a coluna Completado só abriga quem está APTO.
 * Etapa de Completado + apto false/null → BLOQUEADO; apto true → COMPLETED; as outras etapas ignoram o apto.
 */
describe('deriveKanbanColumn — apto (spec 067, A8 i)', () => {
  const ETAPAS_DE_COMPLETADO = ['COMPLETED', 'QUALIFIED', 'IN_DOUBT'];

  it.each(ETAPAS_DE_COMPLETADO)('%s + apto=false → BLOQUEADO', (stage) => {
    expect(deriveKanbanColumn(stage, 'talentum', null, false)).toBe('BLOQUEADO');
  });

  it.each(ETAPAS_DE_COMPLETADO)('%s + apto=null (não lido) → BLOQUEADO (fail-closed)', (stage) => {
    expect(deriveKanbanColumn(stage, 'talentum', null, null)).toBe('BLOQUEADO');
  });

  it.each(ETAPAS_DE_COMPLETADO)('%s + apto=true → COMPLETED', (stage) => {
    expect(deriveKanbanColumn(stage, 'talentum', null, true)).toBe('COMPLETED');
  });

  it('as outras etapas ignoram o apto (false/null/true dão a mesma coluna)', () => {
    const casos: Array<[string | null, string | null, string]> = [
      ['SELECTED', 'talentum', 'SELECTED'],
      ['QUICK_RESPONSE_TEAM', null, 'QUICK_RESPONSE_TEAM'],
      ['REJECTED', 'talentum', 'REJECTED'],
      ['IN_PROGRESS', 'talentum', 'IN_PROGRESS'],
      ['PRE_SCREENING', 'talentum', 'PRE_SCREENING'],
      ['INVITED', 'manual', 'INICIADO'],
      ['INVITED', 'talentum', 'INVITED'],
      ['INVITED', 'system', 'COMPATIBLE'],
    ];
    for (const [stage, source, esperada] of casos) {
      for (const apto of [true, false, null]) {
        expect(deriveKanbanColumn(stage, source, null, apto)).toBe(esperada);
      }
    }
  });

  it('BLOQUEADO fica entre IN_PROGRESS e COMPLETED no ranking', () => {
    expect(kanbanColumnRank('BLOQUEADO')).toBeGreaterThan(kanbanColumnRank('IN_PROGRESS'));
    expect(kanbanColumnRank('BLOQUEADO')).toBeLessThan(kanbanColumnRank('COMPLETED'));
  });

  it('boardPosition: PRE_SCREENING → COMPLETED continua a distância 1 (Bloqueados não é etapa que se atravessa)', () => {
    expect(boardPosition('QUALIFIED', null, null) - boardPosition('PRE_SCREENING', null, null)).toBe(1);
    expect(VACANCY_BOARD_COLUMNS.indexOf('COMPLETED') - VACANCY_BOARD_COLUMNS.indexOf('BLOQUEADO')).toBe(1);
  });

  it('tallyKanbanColumns separa Completado apto de Bloqueados e a soma das colunas = total', () => {
    const base = { kind: 'wja' as const, source: 'talentum', messaged: false, stage: 'QUALIFIED' };
    const tally = tallyKanbanColumns([
      { ...base, apto: true, n: 3 },
      { ...base, apto: false, n: 2 },
      { ...base, apto: null, n: 1 },
      { ...base, stage: 'IN_PROGRESS', apto: null, n: 4 },
    ]);
    expect(tally.COMPLETED).toBe(3);
    expect(tally.BLOQUEADO).toBe(3);
    expect(tally.IN_PROGRESS).toBe(4);
    expect(Object.values(tally).reduce((a, n) => a + n, 0)).toBe(10);
  });

  it('a tentativa barrada (kind=blocked) NÃO vai para BLOQUEADO: segue em INICIADO (D474)', () => {
    const tally = tallyKanbanColumns([{ kind: 'blocked', stage: null, source: null, messaged: false, apto: null, n: 2 }]);
    expect(tally.INICIADO).toBe(2);
    expect(tally.BLOQUEADO).toBe(0);
  });
});
