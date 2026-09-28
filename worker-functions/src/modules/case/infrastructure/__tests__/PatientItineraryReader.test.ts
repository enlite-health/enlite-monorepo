/**
 * PatientItineraryReader — fase 7, DX-7.6.
 *
 * `inPatientTransaction` NÃO é mockado aqui: roda de verdade (é o mesmo `withActorContext` real
 * que carimba BEGIN/COMMIT). Só `DatabaseConnection` é mockado (molde
 * `PatientService.moveStatus.v2.test.ts`) — e o `getPool()` mockado devolve SÓ `connect`, sem
 * `query`: qualquer leitura fora da transação (`pool.query` cru) QUEBRA o teste com TypeError em
 * vez de passar calada com "0 chamadas" — é o controle positivo de "nunca `pool.query` cru".
 */
let queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> =
  async () => ({ rows: [], rowCount: 0 });
const mockClient = {
  query: jest.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params)),
  release: jest.fn(),
};
const mockConnect = jest.fn().mockResolvedValue(mockClient);
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn(() => ({ getPool: jest.fn(() => ({ connect: mockConnect })) })) },
}));

import { PatientItineraryReader } from '../PatientItineraryReader';

const PID = '11111111-1111-4111-8111-111111111111';
const calls = (): Array<{ sql: string; params?: unknown[] }> =>
  mockClient.query.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));

describe('PatientItineraryReader', () => {
  let reader: PatientItineraryReader;

  beforeEach(() => {
    jest.clearAllMocks();
    reader = new PatientItineraryReader();
  });

  it('paciente ausente (ou soft-deletado/outro país) → null, e nenhuma 2ª/3ª/4ª query roda', async () => {
    queryImpl = async (sql) => {
      if (/FROM patients/.test(sql)) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    };

    const result = await reader.readPatientItinerary(PID);

    expect(result).toBeNull();
    const c = calls();
    expect(c.some((x) => /FROM patients/.test(x.sql))).toBe(true);
    expect(c.some((x) => /FROM patient_contracted_services/.test(x.sql))).toBe(false);
    expect(c.some((x) => /FROM patient_itinerary_slot/.test(x.sql))).toBe(false);
    expect(c.some((x) => /FROM patient_itinerary_absence/.test(x.sql))).toBe(false);
    expect(c[0].sql).toBe('BEGIN');
    expect(c[c.length - 1].sql).toBe('COMMIT');
  });

  it('paciente presente: as 4 queries rodam dentro da MESMA transação (BEGIN…COMMIT), datas/horas por to_char, sem contracted_service_providers/nome/telefone', async () => {
    queryImpl = async (sql) => {
      if (/FROM patients/.test(sql)) return { rows: [{ id: PID, country: 'AR' }], rowCount: 1 };
      if (/FROM patient_contracted_services/.test(sql)) {
        return { rows: [{ id: 'svc-1', weekly_hours: '20', authorized_hours: null }], rowCount: 1 };
      }
      if (/FROM patient_itinerary_absence/.test(sql)) {
        return {
          rows: [
            { contracted_service_id: 'svc-1', on_date: '2026-10-05', start_time: '08:00', end_time: '12:00' },
          ],
          rowCount: 1,
        };
      }
      if (/FROM patient_itinerary_slot/.test(sql)) {
        return {
          rows: [
            {
              id: 'slot-1',
              contracted_service_id: 'svc-1',
              weekday: 1,
              start_time: '08:00',
              end_time: '12:00',
              active: true,
              assignment_id: 'asg-1',
              worker_id: 'w-1',
              application_id: 'wja-1',
              valid_from: '2026-09-01',
              valid_to: null,
              status: 'ACTIVE',
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    };

    const result = await reader.readPatientItinerary(PID);

    expect(result).toEqual({
      country: 'AR',
      services: [{ id: 'svc-1', weeklyHours: 20, authorizedHours: null }],
      slots: [
        {
          id: 'slot-1',
          contractedServiceId: 'svc-1',
          weekday: 1,
          startTime: '08:00',
          endTime: '12:00',
          active: true,
          assignmentId: 'asg-1',
          workerId: 'w-1',
          applicationId: 'wja-1',
          validFrom: '2026-09-01',
          validTo: null,
          status: 'ACTIVE',
        },
      ],
      uncoveredAbsences: [{ serviceId: 'svc-1', date: '2026-10-05', startTime: '08:00', endTime: '12:00' }],
    });

    const c = calls();
    expect(c[0].sql).toBe('BEGIN');
    expect(c[c.length - 1].sql).toBe('COMMIT');
    expect(c.filter((x) => /^SELECT/.test(x.sql))).toHaveLength(4);
    const slotsQuery = c.find((x) => /FROM patient_itinerary_slot/.test(x.sql));
    expect(slotsQuery?.sql).toMatch(/to_char\(s\.start_time, 'HH24:MI'\)/);
    expect(slotsQuery?.sql).toMatch(/to_char\(a\.valid_from, 'YYYY-MM-DD'\)/);
    expect(slotsQuery?.sql).toMatch(/pcs\.active/);
    const uncoveredQuery = c.find((x) => /FROM patient_itinerary_absence/.test(x.sql));
    expect(uncoveredQuery?.sql).toMatch(/ab\.cancelled_at IS NULL/);
    expect(uncoveredQuery?.sql).toMatch(/ab\.substitute_worker_id IS NULL/);
    expect(uncoveredQuery?.sql).toMatch(/pcs\.patient_id = \$1/);
    expect(uncoveredQuery?.sql).toMatch(/pcs\.active/);
    expect(uncoveredQuery?.sql).toMatch(/to_char\(ab\.on_date/);
    expect(c.every((x) => !/contracted_service_providers|first_name|last_name|phone/i.test(x.sql))).toBe(true);
  });

  it('gate parcial #1: a ausência descoberta só conta sobre alocação ACTIVE e vigente na data (fragmento único absenceSql)', async () => {
    queryImpl = async (sql) => {
      if (/FROM patients/.test(sql)) return { rows: [{ id: PID, country: 'AR' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };

    await reader.readPatientItinerary(PID);

    const sql = calls().find((x) => /FROM patient_itinerary_absence/.test(x.sql))?.sql ?? '';
    expect(sql).toMatch(/ab\.cancelled_at IS NULL/);
    expect(sql).toMatch(/a\.status = 'ACTIVE'/);
    expect(sql).toMatch(/a\.valid_from <= ab\.on_date/);
    expect(sql).toMatch(/\(a\.valid_to IS NULL OR a\.valid_to >= ab\.on_date\)/);
    expect(sql).toMatch(/ab\.substitute_worker_id IS NULL/);
  });
});
