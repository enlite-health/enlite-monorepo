/**
 * SubstitutionRequestReader — spec 069, FR-20/US3. Cliente dublê (o SQL de verdade roda no e2e): prova o mapeamento, os parâmetros e
 * que o serviço de outro paciente/país vira `null` (404) sem ler mais nada.
 */
import type { PoolClient } from 'pg';
import { SubstitutionRequestReader } from '../SubstitutionRequestReader';

const PID = 'p-1';
const SID = 's-1';

function clientWith(impl: (sql: string, params?: unknown[]) => unknown[]) {
  const query = jest.fn(async (sql: string, params?: unknown[]) => ({ rows: impl(sql, params) }));
  return { query, client: { query } as unknown as PoolClient };
}

describe('SubstitutionRequestReader.readForServiceWith', () => {
  const reader = new SubstitutionRequestReader();

  it('serviço inexistente/de outro paciente/outro país → null, e NENHUMA outra consulta roda', async () => {
    const { query, client } = clientWith(() => []);
    await expect(reader.readForServiceWith(client, PID, SID)).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([SID, PID]);
  });

  it('mapeia cabeçalho, ausências (com e sem pedido), registros do log e a alocação nova; nomes só CIFRADOS e sem repetir pessoa', async () => {
    const { query, client } = clientWith((sql) => {
      if (/FROM patient_contracted_services pcs/.test(sql)) return [{ country: 'AR' }];
      if (/FROM patient_itinerary_substitution_request/.test(sql))
        return [{ id: 'r-1', outgoing_worker_id: 'w-out', reason_code: 'OTHER', created_at: '2026-10-30T10:00:00.000Z', created_by: 'u-1', undone_at: null, undone_by: null }];
      if (/FROM patient_itinerary_absence ab/.test(sql))
        return [
          { id: 'ab-1', assignment_id: 'a-1', request_id: 'r-1', on_date: '2026-11-02', start_time: '08:00', slot_end: '12:00', substitute_worker_id: 'w-sub', cancelled_at: null, status: 'ACTIVE', valid_to: null, titular_worker_id: 'w-out' },
          { id: 'ab-2', assignment_id: 'a-1', request_id: null, on_date: '2026-11-03', start_time: '08:00', slot_end: '12:00', substitute_worker_id: null, cancelled_at: '2026-10-31T00:00:00.000Z', status: 'ENDED', valid_to: '2026-11-01', titular_worker_id: 'w-out' },
        ];
      if (/FROM patient_itinerary_change_log/.test(sql))
        return [{ request_id: 'r-1', kind: 'REPLACE', assignment_id: 'a-1', new_assignment_id: 'n-1', effective_date: '2026-11-20', destination: 'RESERVE' }];
      if (/FROM patient_itinerary_assignment WHERE id = ANY/.test(sql)) return [{ id: 'n-1', worker_id: 'w-new', status: 'ACTIVE' }];
      if (/FROM workers WHERE id = ANY/.test(sql)) return [{ id: 'w-out', first_name_encrypted: 'fo', last_name_encrypted: 'lo' }];
      return [];
    });

    const rows = await reader.readForServiceWith(client, PID, SID);

    expect(rows?.country).toBe('AR');
    expect(rows?.headers).toEqual([{ id: 'r-1', outgoingWorkerId: 'w-out', reasonCode: 'OTHER', createdAt: '2026-10-30T10:00:00.000Z', createdBy: 'u-1', undoneAt: null, undoneBy: null }]);
    expect(rows?.absences).toEqual([
      { absenceId: 'ab-1', assignmentId: 'a-1', requestId: 'r-1', onDate: '2026-11-02', startTime: '08:00', endTime: '12:00', substituteWorkerId: 'w-sub', cancelledAt: null, assignmentStatus: 'ACTIVE', assignmentValidTo: null, titularWorkerId: 'w-out' },
      { absenceId: 'ab-2', assignmentId: 'a-1', requestId: null, onDate: '2026-11-03', startTime: '08:00', endTime: '12:00', substituteWorkerId: null, cancelledAt: '2026-10-31T00:00:00.000Z', assignmentStatus: 'ENDED', assignmentValidTo: '2026-11-01', titularWorkerId: 'w-out' },
    ]);
    expect(rows?.logRows).toEqual([{ requestId: 'r-1', kind: 'REPLACE', assignmentId: 'a-1', newAssignmentId: 'n-1', effectiveDate: '2026-11-20', destination: 'RESERVE' }]);
    expect(rows?.newAssignments).toEqual([{ assignmentId: 'n-1', workerId: 'w-new', status: 'ACTIVE' }]);
    // 3 pessoas distintas (w-out, w-sub, w-new) — w-out repetido 3× entra 1×; quem não veio do banco fica com nome null
    expect(rows?.workerNames.map((w) => w.workerId).sort()).toEqual(['w-new', 'w-out', 'w-sub']);
    expect(rows?.workerNames.find((w) => w.workerId === 'w-out')).toEqual({ workerId: 'w-out', firstNameEncrypted: 'fo', lastNameEncrypted: 'lo' });
    expect(rows?.workerNames.find((w) => w.workerId === 'w-sub')).toEqual({ workerId: 'w-sub', firstNameEncrypted: null, lastNameEncrypted: null });
    const names = query.mock.calls.find(([sql]) => /FROM workers WHERE id = ANY/.test(String(sql)));
    expect(names?.[1]).toEqual([['w-out', 'w-sub', 'w-new']]);
  });

  it('sem registros do log e sem pessoas: não consulta alocações novas nem nomes', async () => {
    const { query, client } = clientWith((sql) => (/FROM patient_contracted_services pcs/.test(sql) ? [{ country: 'BR' }] : []));
    const rows = await reader.readForServiceWith(client, PID, SID);
    expect(rows).toMatchObject({ country: 'BR', headers: [], absences: [], logRows: [], newAssignments: [], workerNames: [] });
    const sqls = query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((s) => /FROM patient_itinerary_assignment WHERE id = ANY/.test(s))).toBe(false);
    expect(sqls.some((s) => /FROM workers WHERE id = ANY/.test(s))).toBe(false);
  });
});

describe('SubstitutionRequestReader.readOutgoingCandidatesWith', () => {
  const reader = new SubstitutionRequestReader();

  it('serviço inexistente → null', async () => {
    const { client } = clientWith(() => []);
    await expect(reader.readOutgoingCandidatesWith(client, PID, SID, () => '2026-11-02')).resolves.toBeNull();
  });

  it('pessoas DISTINTAS com alocação ACTIVE vigente ou futura: "hoje" pelo país do serviço no $2; nomes só cifrados', async () => {
    const { query, client } = clientWith((sql) => {
      if (/FROM patient_contracted_services pcs/.test(sql)) return [{ country: 'AR' }];
      if (/SELECT DISTINCT a\.worker_id/.test(sql)) return [{ worker_id: 'w-1' }, { worker_id: 'w-2' }];
      if (/FROM workers WHERE id = ANY/.test(sql)) return [{ id: 'w-1', first_name_encrypted: 'f1', last_name_encrypted: 'l1' }];
      return [];
    });
    const todayFor = jest.fn((country: string) => (country === 'AR' ? '2026-11-02' : 'x'));

    const rows = await reader.readOutgoingCandidatesWith(client, PID, SID, todayFor);

    expect(todayFor).toHaveBeenCalledWith('AR');
    const distinct = query.mock.calls.find(([sql]) => /SELECT DISTINCT a\.worker_id/.test(String(sql)));
    expect(distinct?.[1]).toEqual([SID, '2026-11-02']);
    expect(String(distinct?.[0])).toMatch(/a\.status = 'ACTIVE'/);
    expect(String(distinct?.[0])).toMatch(/a\.valid_to IS NULL OR a\.valid_to >= \$2::date/);
    expect(rows).toEqual({
      country: 'AR',
      workers: [
        { workerId: 'w-1', firstNameEncrypted: 'f1', lastNameEncrypted: 'l1' },
        { workerId: 'w-2', firstNameEncrypted: null, lastNameEncrypted: null },
      ],
    });
  });
});
