/**
 * ServiceTeamReader — Fase 10, DX-10.5.
 *
 * Molde do mock de `inPatientTransaction`: `PatientKanbanServicesReader.test.ts`.
 * `inPatientTransaction` NÃO é mockado (roda de verdade); só `DatabaseConnection` é mockado, e o
 * `getPool()` mockado devolve `connect` + `query` SEPARADOS: se o leitor chamasse `pool.query` cru
 * (fora da transação), o mock de `query` do pool cru acusaria a chamada.
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

import { ServiceTeamReader } from '../ServiceTeamReader';

const calls = (): Array<{ sql: string; params?: unknown[] }> =>
  mockClient.query.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));
const svcCalls = () => calls().filter((c) => /WITH svc AS/.test(c.sql));

describe('ServiceTeamReader', () => {
  let reader: ServiceTeamReader;

  beforeEach(() => {
    jest.clearAllMocks();
    reader = new ServiceTeamReader();
  });

  it('UMA query dentro da transação (BEGIN…COMMIT), chamada exatamente 1×; o pool cru não recebe query', async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });

    await reader.read('p-1', 's-1');

    expect(svcCalls()).toHaveLength(1);
    const c = calls();
    expect(c[0].sql).toBe('BEGIN');
    expect(c[c.length - 1].sql).toBe('COMMIT');
    expect(rawPoolQuery).not.toHaveBeenCalled();
  });

  it('parâmetros [patientId, serviceId, \'QUICK_RESPONSE_TEAM\']', async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });

    await reader.read('p-1', 's-1');

    expect(svcCalls()[0].params).toEqual(['p-1', 's-1', 'QUICK_RESPONSE_TEAM']);
  });

  it('a SQL contém a vaga viva, reverted_at IS NULL, to_char da data, o escopo do paciente e a exclusão de desativados; nada de capacidade/alocação antiga/encuadres/telefone/clínico/endereço', async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });

    await reader.read('p-1', 's-1');

    const sql = svcCalls()[0].sql;
    expect(sql).toMatch(/DISTINCT ON \(jp\.contracted_service_id\)/);
    expect(sql).toMatch(/reverted_at IS NULL/);
    expect(sql).toMatch(/to_char\(a\.valid_from,'YYYY-MM-DD'\)/);
    expect(sql).toMatch(/pcs\.patient_id = \$1/);
    expect(sql).toMatch(/p\.deleted_at IS NULL/);
    expect(sql).toMatch(/COALESCE\(w\.status, ''\) <> 'DISABLED'/);
    expect(/contracted_service_providers|encuadres|phone|diagnos|address/i.test(sql)).toBe(false);
  });

  it('DX-13.5: o CTE subs — patient_itinerary_absence, cancelled_at IS NULL, substitute_worker_id IS NOT NULL, contracted_service_id = $2, to_char da data e a.id AS allocation_id no alloc; ainda 1 client.query', async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });

    await reader.read('p-1', 's-1');

    const sql = svcCalls()[0].sql;
    expect(sql).toMatch(/patient_itinerary_absence/);
    expect(sql).toMatch(/ab\.cancelled_at IS NULL/);
    expect(sql).toMatch(/ab\.substitute_worker_id IS NOT NULL/);
    expect(sql).toMatch(/s\.contracted_service_id = \$2/);
    expect(sql).toMatch(/to_char\(ab\.on_date/);
    expect(sql).toMatch(/a\.id AS allocation_id/);
    expect(svcCalls()).toHaveLength(1);
  });

  it('0 linhas → null', async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });

    const result = await reader.read('p-1', 's-1');

    expect(result).toBeNull();
  });

  it('1 linha → as listas mapeadas (json → camelCase), inclusive o horário da alocação e as substituições (DX-13.5); live_vacancy_id NULL → null', async () => {
    queryImpl = async () => ({
      rows: [
        {
          service_id: 's-1',
          country: 'AR',
          live_vacancy_id: null,
          candidacies: [
            {
              worker_id: 'w-1',
              vacancy_id: 'v-old',
              stage: 'QUICK_RESPONSE_TEAM',
              first_name_encrypted: 'enc-first-1',
              last_name_encrypted: 'enc-last-1',
            },
          ],
          assignments: [
            {
              worker_id: 'w-2',
              service_id: 's-1',
              vacancy_id: 'v-2',
              valid_from: '2026-09-01',
              valid_to: null,
              status: 'ACTIVE',
              first_name_encrypted: 'enc-first-2',
              last_name_encrypted: 'enc-last-2',
              allocation_id: 'alloc-2',
              weekday: 1,
              start_time: '08:00',
              end_time: '12:00',
            },
          ],
          marks: [
            {
              worker_id: 'w-3',
              service_id: 's-1',
              reject_reason_category: 'OTHER',
              first_name_encrypted: 'enc-first-3',
              last_name_encrypted: 'enc-last-3',
            },
          ],
          substitutions: [
            {
              worker_id: 'w-4',
              service_id: 's-1',
              vacancy_id: 'v-2',
              date: '2026-10-05',
              first_name_encrypted: 'enc-first-4',
              last_name_encrypted: 'enc-last-4',
            },
          ],
        },
      ],
      rowCount: 1,
    });

    const result = await reader.read('p-1', 's-1');

    expect(result).toEqual({
      serviceId: 's-1',
      country: 'AR',
      liveVacancyId: null,
      candidacies: [
        { workerId: 'w-1', vacancyId: 'v-old', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: 'enc-first-1', lastNameEncrypted: 'enc-last-1' },
      ],
      assignments: [
        {
          workerId: 'w-2',
          serviceId: 's-1',
          vacancyId: 'v-2',
          validFrom: '2026-09-01',
          validTo: null,
          status: 'ACTIVE',
          firstNameEncrypted: 'enc-first-2',
          lastNameEncrypted: 'enc-last-2',
          allocationId: 'alloc-2',
          weekday: 1,
          startTime: '08:00',
          endTime: '12:00',
        },
      ],
      marks: [
        { workerId: 'w-3', serviceId: 's-1', rejectReasonCategory: 'OTHER', firstNameEncrypted: 'enc-first-3', lastNameEncrypted: 'enc-last-3' },
      ],
      substitutions: [
        { workerId: 'w-4', serviceId: 's-1', vacancyId: 'v-2', date: '2026-10-05', firstNameEncrypted: 'enc-first-4', lastNameEncrypted: 'enc-last-4' },
      ],
    });
  });

  it('D445 (rodada 2): o CTE cand seleciona `w.occupation` (coluna plana), e o leitor mapeia para `occupation` camelCase', async () => {
    queryImpl = async () => ({
      rows: [
        {
          service_id: 's-1',
          country: 'AR',
          live_vacancy_id: 'v-live',
          candidacies: [
            {
              worker_id: 'w-1',
              vacancy_id: 'v-live',
              stage: 'QUICK_RESPONSE_TEAM',
              first_name_encrypted: null,
              last_name_encrypted: null,
              occupation: 'CAREGIVER',
            },
          ],
          assignments: [],
          marks: [],
          substitutions: [],
        },
      ],
      rowCount: 1,
    });

    const result = await reader.read('p-1', 's-1');

    expect(result?.candidacies[0].occupation).toBe('CAREGIVER');
    const sql = svcCalls()[0].sql;
    expect(sql).toMatch(/w\.occupation/);
  });

  it('gate parcial #1: o CTE subs só conta substituição sobre alocação do titular ACTIVE e vigente na data', async () => {
    queryImpl = async () => ({ rows: [], rowCount: 0 });

    await reader.read('p-1', 's-1');

    const sql = svcCalls()[0].sql;
    expect(sql).toMatch(/ab\.cancelled_at IS NULL/);
    expect(sql).toMatch(/a\.status = 'ACTIVE'/);
    expect(sql).toMatch(/a\.valid_from <= ab\.on_date/);
    expect(sql).toMatch(/\(a\.valid_to IS NULL OR a\.valid_to >= ab\.on_date\)/);
    expect(sql).toMatch(/ab\.substitute_worker_id IS NOT NULL/);
  });

  it('Fase 2 (D2): o CTE marks faz LEFT JOIN no catálogo `service_exit_reasons` por `code`, e o leitor mapeia o rótulo para `rejectReasonLabel`', async () => {
    queryImpl = async () => ({
      rows: [
        {
          service_id: 's-1',
          country: 'AR',
          live_vacancy_id: 'v-live',
          candidacies: [],
          assignments: [],
          marks: [
            { worker_id: 'w-3', service_id: 's-1', reject_reason_category: 'NOVO', reject_reason_label: 'Cambio de disponibilidad', first_name_encrypted: null, last_name_encrypted: null },
            { worker_id: 'w-4', service_id: 's-1', reject_reason_category: 'OTHER', reject_reason_label: null, first_name_encrypted: null, last_name_encrypted: null },
          ],
          substitutions: [],
        },
      ],
      rowCount: 1,
    });

    const result = await reader.read('p-1', 's-1');

    expect(svcCalls()[0].sql).toMatch(/LEFT JOIN service_exit_reasons ser ON ser\.code = r\.reject_reason_category/);
    expect(result?.marks.map((m) => [m.workerId, m.rejectReasonCategory, m.rejectReasonLabel])).toEqual([
      ['w-3', 'NOVO', 'Cambio de disponibilidad'],
      ['w-4', 'OTHER', null],
    ]);
  });
});
