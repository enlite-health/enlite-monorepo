/**
 * fetchPatientStatusHistory — a aba Historial lê patient_status_history (254/255):
 * quando / de → para / origem, mais recente primeiro, SEM ator e SEM on_hold_note.
 */
import type { Pool } from 'pg';
import { fetchPatientStatusHistory } from '../PatientStatusHistoryQueryHelper';

describe('fetchPatientStatusHistory', () => {
  it('mapeia as colunas da history e ordena por created_at DESC; não seleciona ator nem nota', async () => {
    const at = new Date('2026-09-03T14:00:00Z');
    const query = jest.fn().mockResolvedValue({ rows: [
      { old_value: 'ACTIVE', new_value: 'ON_HOLD', change_source: 'admin_panel', created_at: at },
      { old_value: null, new_value: 'ACTIVE', change_source: null, created_at: at },
    ] });
    const out = await fetchPatientStatusHistory({ query } as unknown as Pool, 'p1');
    expect(out).toEqual([
      { from: 'ACTIVE', to: 'ON_HOLD', source: 'admin_panel', at },
      { from: null, to: 'ACTIVE', source: null, at },
    ]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toMatch(/FROM patient_status_history/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(sql).not.toMatch(/actor|uid|on_hold_note/);
    expect(query.mock.calls[0][1]).toEqual(['p1']);
  });
});
