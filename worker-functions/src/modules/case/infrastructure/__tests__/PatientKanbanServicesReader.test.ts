/**
 * PatientKanbanServicesReader — fase 8, DX-8.4.
 *
 * Molde do mock de `inPatientTransaction`: `PatientItineraryReader.test.ts`. `inPatientTransaction`
 * NÃO é mockado (roda de verdade — o mesmo `withActorContext` real que carimba BEGIN/COMMIT). Só
 * `DatabaseConnection` é mockado, e o `getPool()` mockado devolve `connect` + `query` SEPARADOS: se
 * o leitor chamasse `pool.query` cru (fora da transação), o mock de `query` do pool cru acusaria a
 * chamada — é o controle positivo de "nunca `pool.query` cru".
 */
let queryImpl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }> =
  async () => ({ rows: [], rowCount: 0 });
const mockClient = {
  query: jest.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params)),
  release: jest.fn(),
};
const mockConnect = jest.fn().mockResolvedValue(mockClient);
const rawPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn(() => ({
      getPool: jest.fn(() => ({ connect: mockConnect, query: rawPoolQuery })),
    })),
  },
}));

import { PatientKanbanServicesReader } from '../PatientKanbanServicesReader';

const calls = (): Array<{ sql: string; params?: unknown[] }> =>
  mockClient.query.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));
const svcCalls = () => calls().filter((c) => /WITH svc AS/.test(c.sql));
const absenceCalls = () => calls().filter((c) => /FROM patient_itinerary_absence/.test(c.sql));

describe('PatientKanbanServicesReader', () => {
  let reader: PatientKanbanServicesReader;

  beforeEach(() => {
    jest.clearAllMocks();
    reader = new PatientKanbanServicesReader();
  });

  it('EXATAMENTE 2 queries dentro da transação (BEGIN…COMMIT) — 1 a mais para TODOS os pacientes, sem N+1; o pool cru não recebe query', async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });

    await reader.readKanbanServices('AR');

    expect(svcCalls()).toHaveLength(1);
    expect(absenceCalls()).toHaveLength(1);
    const c = calls();
    expect(c).toHaveLength(4); // BEGIN, svc, absence, COMMIT — sem N+1
    expect(c[0].sql).toBe('BEGIN');
    expect(c[c.length - 1].sql).toBe('COMMIT');
    expect(rawPoolQuery).not.toHaveBeenCalled();
  });

  it('parâmetro: [null] sem país, [\'AR\'] com país (nas 2 queries)', async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });

    await reader.readKanbanServices(null);
    expect(svcCalls()[0].params).toEqual([null, null]);
    expect(absenceCalls()[0].params).toEqual([null, null]);

    jest.clearAllMocks();
    queryImpl = async () => ({ rows: [], rowCount: 0 });
    await reader.readKanbanServices('AR');
    expect(svcCalls()[0].params).toEqual(['AR', null]);
    expect(absenceCalls()[0].params).toEqual(['AR', null]);
  });

  it('a query de ausência tem o filtro de país, ab.cancelled_at IS NULL, ab.substitute_worker_id IS NULL, ab.on_date >= CURRENT_DATE - 1; nenhuma coluna de nome/telefone', async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });

    await reader.readKanbanServices('AR');

    const sql = absenceCalls()[0].sql;
    expect(sql).toMatch(/\(\$1::text IS NULL OR p\.country = \$1\)/);
    expect(sql).toMatch(/ab\.cancelled_at IS NULL/);
    expect(sql).toMatch(/ab\.substitute_worker_id IS NULL/);
    expect(sql).toMatch(/ab\.on_date >= CURRENT_DATE - 1/);
    expect(sql).toMatch(/pcs\.active/);
    expect(/contracted_service_providers|first_name|last_name|phone|diagnosis|address/i.test(sql)).toBe(false);
  });

  it('a SQL contém a junção da vaga viva e as guardas de ativo/soft-delete; nenhuma coluna de PII/clínico', async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });

    await reader.readKanbanServices('AR');

    const sql = svcCalls()[0].sql;
    expect(sql).toMatch(/DISTINCT ON \(jp\.contracted_service_id\)/);
    expect(sql).toMatch(/jp\.deleted_at IS NULL/);
    expect(sql).toMatch(/ORDER BY jp\.contracted_service_id, jp\.created_at ASC/);
    expect(sql).toMatch(/to_char\(a\.valid_from,'YYYY-MM-DD'\)/);
    expect(sql).toMatch(/pcs\.active/);
    expect(sql).toMatch(/p\.deleted_at IS NULL/);
    expect(/contracted_service_providers|first_name|last_name|phone|diagnosis|address/i.test(sql)).toBe(false);
  });

  it('agrupa por paciente: 2 pacientes (um com 2 serviços — um deles sem slot —, outro com 1 sem slot); live_vacancy_id NULL e weekly_hours string convertem; uncoveredAbsences distribuído por patient_id (o sem ausência fica SEM a chave)', async () => {
    const svcRows = {
      rows: [
        // Paciente 1 (AR), serviço s1: 1 slot com alocação vigente.
        {
          patient_id: 'p-1',
          country: 'AR',
          service_id: 's1',
          service_code: 'AT',
          weekly_hours: '20',
          authorized_hours: null,
          live_vacancy_id: 'v-1',
          slot_id: 'slot-1',
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
        // Paciente 1, serviço s2: sem slot (linha com slot_id NULL) e sem vaga viva.
        {
          patient_id: 'p-1',
          country: 'AR',
          service_id: 's2',
          service_code: 'FISIO',
          weekly_hours: '10',
          authorized_hours: '8',
          live_vacancy_id: null,
          slot_id: null,
          weekday: null,
          start_time: null,
          end_time: null,
          active: null,
          assignment_id: null,
          worker_id: null,
          application_id: null,
          valid_from: null,
          valid_to: null,
          status: null,
        },
        // Paciente 2 (BR), serviço s3: sem slot.
        {
          patient_id: 'p-2',
          country: 'BR',
          service_id: 's3',
          service_code: 'AT',
          weekly_hours: '15',
          authorized_hours: null,
          live_vacancy_id: null,
          slot_id: null,
          weekday: null,
          start_time: null,
          end_time: null,
          active: null,
          assignment_id: null,
          worker_id: null,
          application_id: null,
          valid_from: null,
          valid_to: null,
          status: null,
        },
      ],
      rowCount: 3,
    };
    queryImpl = async (sql) => {
      if (/FROM patient_itinerary_absence/.test(sql)) {
        // Só p-1 tem ausência sem substituto; p-2 fica sem a chave.
        return {
          rows: [{ patient_id: 'p-1', contracted_service_id: 's1', on_date: '2026-10-05', start_time: '08:00', end_time: '12:00' }],
          rowCount: 1,
        };
      }
      return svcRows;
    };

    const result = await reader.readKanbanServices(null);

    expect(result).toHaveLength(2);
    const p1 = result.find((p) => p.patientId === 'p-1');
    const p2 = result.find((p) => p.patientId === 'p-2');
    expect(p1).toBeDefined();
    expect(p2).toBeDefined();

    expect(p1!.country).toBe('AR');
    expect(p1!.services).toHaveLength(2);
    expect(p1!.slots).toHaveLength(1); // só s1 gera slot; s2 não.

    const s1 = p1!.services.find((s) => s.id === 's1');
    expect(s1).toEqual({ id: 's1', serviceCode: 'AT', weeklyHours: 20, authorizedHours: null, liveVacancyId: 'v-1' });
    const s2 = p1!.services.find((s) => s.id === 's2');
    expect(s2).toEqual({ id: 's2', serviceCode: 'FISIO', weeklyHours: 10, authorizedHours: 8, liveVacancyId: null });
    expect(p1!.slots[0]).toMatchObject({ id: 'slot-1', contractedServiceId: 's1', status: 'ACTIVE' });

    expect(p2!.country).toBe('BR');
    expect(p2!.services).toEqual([
      { id: 's3', serviceCode: 'AT', weeklyHours: 15, authorizedHours: null, liveVacancyId: null },
    ]);
    expect(p2!.slots).toHaveLength(0);

    expect(p1!.uncoveredAbsences).toEqual([
      { serviceId: 's1', date: '2026-10-05', startTime: '08:00', endTime: '12:00' },
    ]);
    expect(Object.prototype.hasOwnProperty.call(p2!, 'uncoveredAbsences')).toBe(false);
  });

  it('gate parcial #1: a ausência descoberta só conta sobre alocação ACTIVE e vigente na data (o MESMO fragmento do itinerário)', async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });

    await reader.readKanbanServices('AR');

    const sql = absenceCalls()[0].sql;
    expect(sql).toMatch(/ab\.cancelled_at IS NULL/);
    expect(sql).toMatch(/a\.status = 'ACTIVE'/);
    expect(sql).toMatch(/a\.valid_from <= ab\.on_date/);
    expect(sql).toMatch(/\(a\.valid_to IS NULL OR a\.valid_to >= ab\.on_date\)/);
    expect(sql).toMatch(/JOIN patients p ON p\.id = pcs\.patient_id AND p\.deleted_at IS NULL/);
  });

  describe('readForPatientWith (cadeia Fase 15)', () => {
    const PID = '22222222-2222-4222-8222-222222222222';
    const txCalls = (q: jest.Mock) => q.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));

    it('roda no client recebido (sem BEGIN/COMMIT, sem pool), com o patientId no $2 das DUAS queries, e devolve o agrupamento do paciente', async () => {
      const q = jest.fn(async (sql: string) => {
        if (/WITH svc AS/.test(sql)) {
          return {
            rows: [{
              patient_id: PID, country: 'AR', service_id: 's1', service_code: 'AT', weekly_hours: '8', authorized_hours: null,
              live_vacancy_id: 'v1', slot_id: null, weekday: null, start_time: null, end_time: null, active: null,
              assignment_id: null, worker_id: null, application_id: null, valid_from: null, valid_to: null, status: null,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      });
      const client = { query: q } as unknown as import('pg').PoolClient;

      const r = await reader.readForPatientWith(client, PID);

      expect(r).toEqual({
        patientId: PID, country: 'AR', slots: [],
        services: [{ id: 's1', serviceCode: 'AT', weeklyHours: 8, authorizedHours: null, liveVacancyId: 'v1' }],
      });
      const c = txCalls(q);
      expect(c).toHaveLength(2);
      expect(c.some((x) => /^(BEGIN|COMMIT|ROLLBACK)$/.test(x.sql))).toBe(false);
      expect(c[0].sql).toMatch(/\(\$2::uuid IS NULL OR p\.id = \$2\)/);
      expect(c[1].sql).toMatch(/\(\$2::uuid IS NULL OR p\.id = \$2\)/);
      expect(c[0].params).toEqual([null, PID]);
      expect(c[1].params).toEqual([null, PID]);
      expect(mockConnect).not.toHaveBeenCalled();
      expect(mockClient.query).not.toHaveBeenCalled();
      expect(rawPoolQuery).not.toHaveBeenCalled();
    });

    it('sem linha → null', async () => {
      const q = jest.fn(async () => ({ rows: [], rowCount: 0 }));
      const client = { query: q } as unknown as import('pg').PoolClient;
      await expect(reader.readForPatientWith(client, PID)).resolves.toBeNull();
    });
  });
});
