/**
 * PatientItineraryEventsReader — spec 069 (FR-12). `inPatientTransaction` roda de verdade (molde `PatientItineraryReader.test.ts`);
 * só `DatabaseConnection` é mockado, e o pool mockado só tem `connect` (qualquer `pool.query` cru quebra o teste).
 */
let queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> = async () => ({ rows: [], rowCount: 0 });
const mockClient = { query: jest.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params)), release: jest.fn() };
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn(() => ({ getPool: jest.fn(() => ({ connect: jest.fn().mockResolvedValue(mockClient) })) })) },
}));

import { PatientItineraryEventsReader } from '../PatientItineraryEventsReader';

const PID = '11111111-1111-4111-8111-111111111111';
const calls = (): Array<{ sql: string; params?: unknown[] }> => mockClient.query.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));

describe('PatientItineraryEventsReader', () => {
  beforeEach(() => jest.clearAllMocks());

  it('paciente ausente/soft-deletado/outro país → null, sem ler faixa/alocação/ausência', async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });
    await expect(new PatientItineraryEventsReader().readForRange(PID, '2026-11-02', '2026-11-08')).resolves.toBeNull();
    expect(calls().some((c) => /patient_itinerary_slot/.test(c.sql))).toBe(false);
  });

  it('sem faixa/alocação/ausência: devolve o país e listas vazias, sem consultar nomes', async () => {
    queryImpl = async (sql) => (/FROM patients/.test(sql) ? { rows: [{ id: PID, country: 'AR' }], rowCount: 1 } : { rows: [], rowCount: 0 });
    await expect(new PatientItineraryEventsReader().readForRange(PID, '2026-11-02', '2026-11-08')).resolves.toEqual({
      country: 'AR', slots: [], assignments: [], absences: [], workerNames: [],
    });
    expect(calls().some((c) => /FROM workers/.test(c.sql))).toBe(false);
  });

  it('janela EXATA do pedido ($2..$3) nas 3 consultas de ocorrência; nome cifrado de titular e substituto, 1× por pessoa; dentro de BEGIN…COMMIT', async () => {
    queryImpl = async (sql) => {
      if (/FROM patients/.test(sql)) return { rows: [{ id: PID, country: 'AR' }], rowCount: 1 };
      if (/FROM patient_itinerary_absence/.test(sql))
        return { rows: [{ patient_id: PID, absence_id: 'ab-1', assignment_id: 'a-1', on_date: '2026-11-02', substitute_worker_id: 'w-sub', request_id: 'r-1' }], rowCount: 1 };
      if (/FROM patient_itinerary_assignment a\s+JOIN patient_itinerary_slot/.test(sql))
        return { rows: [{ patient_id: PID, assignment_id: 'a-1', slot_id: 's-1', worker_id: 'w-tit', valid_from: '2026-01-01', valid_to: null, status: 'ACTIVE' }], rowCount: 1 };
      if (/FROM patient_itinerary_slot s/.test(sql))
        return { rows: [{ patient_id: PID, slot_id: 's-1', service_id: 'svc', weekday: 1, start_time: '08:00', slot_end: '12:00', valid_range: '[2026-01-01,)' }], rowCount: 1 };
      if (/FROM workers/.test(sql)) return { rows: [{ id: 'w-tit', first_name_encrypted: 'ft', last_name_encrypted: 'lt' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };

    const rows = await new PatientItineraryEventsReader().readForRange(PID, '2026-11-02', '2026-11-08');

    expect(rows?.slots).toHaveLength(1);
    expect(rows?.absences[0]).toMatchObject({ absenceId: 'ab-1', substituteWorkerId: 'w-sub', requestId: 'r-1' });
    expect(rows?.workerNames).toEqual([
      { workerId: 'w-tit', firstNameEncrypted: 'ft', lastNameEncrypted: 'lt' },
      { workerId: 'w-sub', firstNameEncrypted: null, lastNameEncrypted: null },
    ]);
    const c = calls();
    expect(c[0].sql).toBe('BEGIN');
    expect(c[c.length - 1].sql).toBe('COMMIT');
    const occurrence = c.filter((x) => /patient_itinerary_(slot|assignment|absence)/.test(x.sql));
    expect(occurrence).toHaveLength(3);
    for (const x of occurrence) {
      expect(x.params).toEqual([PID, '2026-11-02', '2026-11-08']);
      expect(x.sql).toMatch(/\(\$2::date\)::date/);
      expect(x.sql).toMatch(/pcs\.patient_id = \$1 AND pcs\.active/);
    }
  });
});
