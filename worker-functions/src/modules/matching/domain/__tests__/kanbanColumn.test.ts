import {
  deriveKanbanColumn,
  isMatchedNotInvited,
  KANBAN_COLUMN_BLOCKED,
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

  it('maps PRE_SCREENING and transitional INITIATED to PRE_SCREENING', () => {
    expect(deriveKanbanColumn('PRE_SCREENING', 'talentum')).toBe('PRE_SCREENING');
    expect(deriveKanbanColumn('INITIATED', 'talentum')).toBe('PRE_SCREENING');
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

  it('exposes the BLOQUEADO constant for blocked-attempt rows (no WJA stage)', () => {
    expect(KANBAN_COLUMN_BLOCKED).toBe('BLOQUEADO');
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
