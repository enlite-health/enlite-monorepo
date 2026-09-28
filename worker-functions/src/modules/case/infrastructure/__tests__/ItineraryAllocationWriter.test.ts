/**
 * ItineraryAllocationWriter — DX-11.7 (P12). Recebe o `client` já aberto (a transação é de quem
 * chama) — o dublê aqui é só o `client`, sem `DatabaseConnection`/`inPatientTransaction` (molde
 * `ServiceTeamMarkWriter.test.ts`).
 */
import { ItineraryAllocationWriter } from '../ItineraryAllocationWriter';

function clientStub(result: { rows: unknown[]; rowCount: number }) {
  const query = jest.fn().mockResolvedValue(result);
  return { query };
}

describe('ItineraryAllocationWriter', () => {
  let writer: ItineraryAllocationWriter;

  beforeEach(() => {
    writer = new ItineraryAllocationWriter();
  });

  it('findSlotForAllocation: 1 query, junção slot→serviço→paciente pelos 3 ids', async () => {
    const client = clientStub({ rows: [{ id: 'slot-1', active: true, address_id: 'addr-1' }], rowCount: 1 });

    const result = await writer.findSlotForAllocation(client as never, 'p-1', 's-1', 'slot-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/FROM patient_itinerary_slot s/);
    expect(String(sql)).toMatch(/JOIN patient_contracted_services pcs ON pcs\.id = s\.contracted_service_id/);
    expect(String(sql)).toMatch(/WHERE pcs\.patient_id = \$1 AND s\.contracted_service_id = \$2 AND s\.id = \$3/);
    expect(params).toEqual(['p-1', 's-1', 'slot-1']);
    expect(result).toEqual({ slotId: 'slot-1', active: true, addressId: 'addr-1' });
  });

  it('findSlotForAllocation: rowCount 0 → null', async () => {
    const client = clientStub({ rows: [], rowCount: 0 });

    const result = await writer.findSlotForAllocation(client as never, 'p-1', 's-1', 'slot-x');

    expect(result).toBeNull();
  });

  it('findApplicationId: 1 query, SEM filtro de etapa do funil', async () => {
    const client = clientStub({ rows: [{ id: 'wja-1' }], rowCount: 1 });

    const result = await writer.findApplicationId(client as never, 'w-1', 'vac-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/SELECT id FROM worker_job_applications WHERE worker_id = \$1 AND job_posting_id = \$2/);
    expect(String(sql)).not.toMatch(/application_funnel_stage/);
    expect(params).toEqual(['w-1', 'vac-1']);
    expect(result).toBe('wja-1');
  });

  it('findApplicationId: nenhuma linha → null', async () => {
    const client = clientStub({ rows: [], rowCount: 0 });

    const result = await writer.findApplicationId(client as never, 'w-1', 'vac-1');

    expect(result).toBeNull();
  });

  it('insertAllocation: 1 query, status ACTIVE e valid_from do PARÂMETRO (nunca now()/CURRENT_DATE)', async () => {
    const client = clientStub({ rows: [{ id: 'alloc-1', valid_from: '2026-09-28' }], rowCount: 1 });

    const result = await writer.insertAllocation(client as never, {
      slotId: 'slot-1',
      workerId: 'w-1',
      applicationId: 'wja-1',
      validFrom: '2026-09-28',
      actorUid: 'staff:u-1',
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/INSERT INTO patient_itinerary_assignment/);
    expect(String(sql)).toMatch(/'ACTIVE'/);
    expect(String(sql)).not.toMatch(/now\(\)|CURRENT_DATE/);
    expect(params).toEqual(['slot-1', 'w-1', 'wja-1', '2026-09-28', 'staff:u-1']);
    expect(result).toEqual({ id: 'alloc-1', validFrom: '2026-09-28' });
  });

  it('findAllocation: 1 query, junção slot→serviço→paciente pela alocação', async () => {
    const client = clientStub({ rows: [{ id: 'alloc-1', status: 'ACTIVE', valid_from: '2026-09-01' }], rowCount: 1 });

    const result = await writer.findAllocation(client as never, 'p-1', 's-1', 'alloc-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/FROM patient_itinerary_assignment a/);
    expect(String(sql)).toMatch(/JOIN patient_itinerary_slot s ON s\.id = a\.slot_id/);
    expect(String(sql)).toMatch(/JOIN patient_contracted_services pcs ON pcs\.id = s\.contracted_service_id/);
    expect(String(sql)).toMatch(/WHERE pcs\.patient_id = \$1 AND s\.contracted_service_id = \$2 AND a\.id = \$3/);
    expect(params).toEqual(['p-1', 's-1', 'alloc-1']);
    expect(result).toEqual({ id: 'alloc-1', status: 'ACTIVE', validFrom: '2026-09-01' });
  });

  it('findAllocation: rowCount 0 → null', async () => {
    const client = clientStub({ rows: [], rowCount: 0 });

    const result = await writer.findAllocation(client as never, 'p-1', 's-1', 'alloc-x');

    expect(result).toBeNull();
  });

  it('endAllocation: 1 query, GREATEST(valid_from, $2) e status ACTIVE no WHERE; devolve o rowCount', async () => {
    const client = clientStub({ rows: [], rowCount: 1 });

    const rowCount = await writer.endAllocation(client as never, 'alloc-1', '2026-09-28', 'staff:u-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/UPDATE patient_itinerary_assignment/);
    expect(String(sql)).toMatch(/valid_to = GREATEST\(valid_from, \$2::date\)/);
    expect(String(sql)).toMatch(/WHERE id = \$1 AND status = 'ACTIVE'/);
    expect(params).toEqual(['alloc-1', '2026-09-28', 'staff:u-1']);
    expect(rowCount).toBe(1);
  });

  it('endAllocation: rowCount 0 quando a linha não está mais ACTIVE', async () => {
    const client = clientStub({ rows: [], rowCount: 0 });

    const rowCount = await writer.endAllocation(client as never, 'alloc-1', '2026-09-28', 'staff:u-1');

    expect(rowCount).toBe(0);
  });

  it('nenhuma SQL nomeia a tabela do paciente, o cadastro do legado ou o card antigo; só patient_itinerary_assignment (≥ 2×)', async () => {
    const client = clientStub({ rows: [{ id: 'x', active: true, address_id: null, valid_from: '2026-09-28', status: 'ACTIVE' }], rowCount: 1 });

    await writer.findSlotForAllocation(client as never, 'p-1', 's-1', 'slot-1');
    await writer.findApplicationId(client as never, 'w-1', 'vac-1');
    await writer.insertAllocation(client as never, {
      slotId: 'slot-1',
      workerId: 'w-1',
      applicationId: 'wja-1',
      validFrom: '2026-09-28',
      actorUid: 'u-1',
    });
    await writer.findAllocation(client as never, 'p-1', 's-1', 'alloc-1');
    await writer.endAllocation(client as never, 'alloc-1', '2026-09-28', 'u-1');

    const allSql = client.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(/UPDATE patients|contracted_service_providers|encuadres/i.test(allSql)).toBe(false);
    expect((allSql.match(/patient_itinerary_assignment/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
