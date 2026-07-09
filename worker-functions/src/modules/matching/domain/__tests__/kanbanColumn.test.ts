import { deriveKanbanColumn, KANBAN_COLUMN_BLOCKED } from '../kanbanColumn';

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
