/**
 * fetchPatientStatusHistory — a aba Historial lê patient_status_history (254/255):
 * quando / de → para / origem / motivo / autor (migration 486, decisão do Gabriel 29/09/2026 —
 * substitui o "sem ator" de C7.2), mais recente primeiro, SEM on_hold_note (C7.3).
 */
import type { Pool } from 'pg';
import { fetchPatientStatusHistory } from '../PatientStatusHistoryQueryHelper';

describe('fetchPatientStatusHistory', () => {
  it('mapeia as colunas da history (incl. reason/actorUid) e ordena por created_at DESC; não seleciona on_hold_note', async () => {
    const at = new Date('2026-09-03T14:00:00Z');
    const query = jest.fn().mockResolvedValue({ rows: [
      { old_value: 'SUSPENDED', new_value: 'SEARCHING', change_source: 'admin_panel', created_at: at, reason: 'RESUMED_SERVICE', actor_uid: 'uid-1' },
      { old_value: null, new_value: 'ACTIVE', change_source: null, created_at: at, reason: null, actor_uid: null },
    ] });
    const out = await fetchPatientStatusHistory({ query } as unknown as Pool, 'p1');
    expect(out).toEqual([
      { from: 'SUSPENDED', to: 'SEARCHING', source: 'admin_panel', at, reason: 'RESUMED_SERVICE', actorUid: 'uid-1' },
      { from: null, to: 'ACTIVE', source: null, at, reason: null, actorUid: null },
    ]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/FROM patient_status_history/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(sql).toMatch(/reason, actor_uid/);
    expect(sql).not.toMatch(/on_hold_note/);
    expect(query.mock.calls[0][1]).toEqual(['p1']);
  });
});
