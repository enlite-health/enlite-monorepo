/**
 * ItineraryAssemblyWriter — Fase 11, DX-11.8 (parte do escritor). Dublê é só o `client` (molde
 * `ServiceTeamMarkWriter.test.ts`).
 */
import { ItineraryAssemblyWriter } from '../ItineraryAssemblyWriter';

function clientStub(rows: unknown[] = []) {
  const query = jest.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { query };
}

describe('ItineraryAssemblyWriter', () => {
  it('patientExists: 1 query, EXISTS sobre patients com deleted_at IS NULL', async () => {
    const client = clientStub([{ exists: true }]);
    const writer = new ItineraryAssemblyWriter();

    const exists = await writer.patientExists(client as never, 'p-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/FROM patients WHERE id = \$1 AND deleted_at IS NULL/);
    expect(params).toEqual(['p-1']);
    expect(exists).toBe(true);
  });

  it('servicesMissingSlot: 1 query só, contém DISTINCT ON (jp.contracted_service_id), s.active, pcs.active, patient_id = $1', async () => {
    const client = clientStub([
      { service_id: 's-1', service_code: 'AT', count_with_live_vacancy: '2', missing_slot: true },
      { service_id: 's-2', service_code: 'FISIO', count_with_live_vacancy: '2', missing_slot: false },
    ]);
    const writer = new ItineraryAssemblyWriter();

    const result = await writer.servicesMissingSlot(client as never, 'p-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/DISTINCT ON \(jp\.contracted_service_id\)/);
    expect(String(sql)).toMatch(/s\.active/);
    expect(String(sql)).toMatch(/pcs\.active/);
    expect(String(sql)).toMatch(/pcs\.patient_id = \$1/);
    expect(params).toEqual(['p-1']);

    expect(result.services).toEqual([{ serviceId: 's-1', serviceCode: 'AT' }]);
    expect(result.countWithLiveVacancy).toBe(2);
  });

  it('servicesMissingSlot: 0 linha → services vazio e countWithLiveVacancy 0', async () => {
    const client = clientStub([]);
    const writer = new ItineraryAssemblyWriter();

    const result = await writer.servicesMissingSlot(client as never, 'p-1');

    expect(result).toEqual({ services: [], countWithLiveVacancy: 0 });
  });

  it('insertAssembly: 1 INSERT INTO patient_itinerary_assembly, devolve id e assembledAt', async () => {
    const client = clientStub([{ id: 'asm-1', assembled_at: '2026-09-28T12:00:00.000Z' }]);
    const writer = new ItineraryAssemblyWriter();

    const result = await writer.insertAssembly(client as never, 'p-1', 'staff:u-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/INSERT INTO patient_itinerary_assembly/);
    expect(String(sql)).toMatch(/RETURNING id, assembled_at/);
    expect(params).toEqual(['p-1', 'staff:u-1']);
    expect(result).toEqual({ id: 'asm-1', assembledAt: '2026-09-28T12:00:00.000Z' });
  });

  it('nenhuma 2ª query por serviço (N+1): servicesMissingSlot com 2 serviços faltando ainda é 1 query', async () => {
    const client = clientStub([
      { service_id: 's-1', service_code: 'AT', count_with_live_vacancy: '2', missing_slot: true },
      { service_id: 's-2', service_code: 'FISIO', count_with_live_vacancy: '2', missing_slot: true },
    ]);
    const writer = new ItineraryAssemblyWriter();

    const result = await writer.servicesMissingSlot(client as never, 'p-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(result.services).toHaveLength(2);
  });
});
