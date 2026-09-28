/**
 * ItineraryAbsenceWriter — DX-13.7 (P16). Recebe o `client` já aberto (a transação é de quem chama)
 * — o dublê aqui é só o `client`, sem `DatabaseConnection`/`inPatientTransaction` (molde
 * `ItineraryAllocationWriter.test.ts`).
 */
import { ItineraryAbsenceWriter } from '../ItineraryAbsenceWriter';

function clientStub(result: { rows: unknown[]; rowCount: number }) {
  const query = jest.fn().mockResolvedValue(result);
  return { query };
}

describe('ItineraryAbsenceWriter', () => {
  let writer: ItineraryAbsenceWriter;

  beforeEach(() => {
    writer = new ItineraryAbsenceWriter();
  });

  it('insertAbsence: 1 query, on_date do PARÂMETRO (nunca now()/CURRENT_DATE), sem substituto → os 2 campos NULL', async () => {
    const client = clientStub({ rows: [{ id: 'abs-1', on_date: '2026-09-28' }], rowCount: 1 });

    const result = await writer.insertAbsence(client as never, {
      allocationId: 'alloc-1',
      date: '2026-09-28',
      substituteWorkerId: null,
      substituteApplicationId: null,
      actorUid: 'staff:u-1',
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/INSERT INTO patient_itinerary_absence/);
    expect(String(sql)).toMatch(
      /\(assignment_id, on_date, substitute_worker_id, substitute_application_id, created_by, updated_by\)/,
    );
    expect(String(sql)).not.toMatch(/now\(\)|CURRENT_DATE/);
    expect(params).toEqual(['alloc-1', '2026-09-28', null, null, 'staff:u-1']);
    expect(result).toEqual({ id: 'abs-1', date: '2026-09-28' });
  });

  it('insertAbsence: com substituto → os 2 campos preenchidos JUNTOS, nunca um sem o outro', async () => {
    const client = clientStub({ rows: [{ id: 'abs-2', on_date: '2026-09-28' }], rowCount: 1 });

    await writer.insertAbsence(client as never, {
      allocationId: 'alloc-1',
      date: '2026-09-28',
      substituteWorkerId: 'w-sub',
      substituteApplicationId: 'wja-sub',
      actorUid: 'staff:u-1',
    });

    const [, params] = client.query.mock.calls[0];
    expect(params[2]).toBe('w-sub');
    expect(params[3]).toBe('wja-sub');
    expect((params[2] === null) === (params[3] === null)).toBe(true);
  });

  it('findAbsence: 1 query, junção ausência→alocação→slot→serviço pelos 3 ids', async () => {
    const client = clientStub({
      rows: [{ id: 'abs-1', assignment_id: 'alloc-1', on_date: '2026-09-28', substitute_worker_id: null, cancelled_at: null }],
      rowCount: 1,
    });

    const result = await writer.findAbsence(client as never, 'p-1', 's-1', 'abs-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/FROM patient_itinerary_absence ab/);
    expect(String(sql)).toMatch(/JOIN patient_itinerary_assignment a ON a\.id = ab\.assignment_id/);
    expect(String(sql)).toMatch(/JOIN patient_itinerary_slot s ON s\.id = a\.slot_id/);
    expect(String(sql)).toMatch(/JOIN patient_contracted_services pcs ON pcs\.id = s\.contracted_service_id/);
    expect(String(sql)).toMatch(/WHERE pcs\.patient_id = \$1 AND s\.contracted_service_id = \$2 AND ab\.id = \$3/);
    expect(params).toEqual(['p-1', 's-1', 'abs-1']);
    expect(result).toEqual({ id: 'abs-1', allocationId: 'alloc-1', date: '2026-09-28', substituteWorkerId: null, cancelled: false });
  });

  it('findAbsence: cancelled_at preenchido → cancelled true', async () => {
    const client = clientStub({
      rows: [{ id: 'abs-1', assignment_id: 'alloc-1', on_date: '2026-09-28', substitute_worker_id: 'w-sub', cancelled_at: '2026-09-27T12:00:00Z' }],
      rowCount: 1,
    });

    const result = await writer.findAbsence(client as never, 'p-1', 's-1', 'abs-1');

    expect(result).toEqual({ id: 'abs-1', allocationId: 'alloc-1', date: '2026-09-28', substituteWorkerId: 'w-sub', cancelled: true });
  });

  it('findAbsence: rowCount 0 → null', async () => {
    const client = clientStub({ rows: [], rowCount: 0 });

    const result = await writer.findAbsence(client as never, 'p-1', 's-1', 'abs-x');

    expect(result).toBeNull();
  });

  it('updateSubstitute: 1 query, os 2 campos JUNTOS e cancelled_at IS NULL no WHERE; devolve o rowCount', async () => {
    const client = clientStub({ rows: [], rowCount: 1 });

    const rowCount = await writer.updateSubstitute(client as never, 'abs-1', 'w-sub', 'wja-sub', 'staff:u-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/UPDATE patient_itinerary_absence/);
    expect(String(sql)).toMatch(/SET substitute_worker_id = \$2, substitute_application_id = \$3/);
    expect(String(sql)).toMatch(/WHERE id = \$1 AND cancelled_at IS NULL/);
    expect(params).toEqual(['abs-1', 'w-sub', 'wja-sub', 'staff:u-1']);
    expect(rowCount).toBe(1);
  });

  it('updateSubstitute: null/null tira o substituto', async () => {
    const client = clientStub({ rows: [], rowCount: 1 });

    await writer.updateSubstitute(client as never, 'abs-1', null, null, 'staff:u-1');

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual(['abs-1', null, null, 'staff:u-1']);
  });

  it('updateSubstitute: rowCount 0 quando a linha já está cancelada (corrida)', async () => {
    const client = clientStub({ rows: [], rowCount: 0 });

    const rowCount = await writer.updateSubstitute(client as never, 'abs-1', 'w-sub', 'wja-sub', 'staff:u-1');

    expect(rowCount).toBe(0);
  });

  it('cancelAbsence: 1 query, UPDATE cancelled_at (nunca DELETE) e cancelled_at IS NULL no WHERE', async () => {
    const client = clientStub({ rows: [], rowCount: 1 });

    const rowCount = await writer.cancelAbsence(client as never, 'abs-1', 'staff:u-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/UPDATE patient_itinerary_absence/);
    expect(String(sql)).toMatch(/SET cancelled_at = now\(\), cancelled_by = \$2/);
    expect(String(sql)).toMatch(/WHERE id = \$1 AND cancelled_at IS NULL/);
    expect(String(sql)).not.toMatch(/DELETE/);
    expect(params).toEqual(['abs-1', 'staff:u-1']);
    expect(rowCount).toBe(1);
  });

  it('cancelAbsence: rowCount 0 quando a linha já está cancelada', async () => {
    const client = clientStub({ rows: [], rowCount: 0 });

    const rowCount = await writer.cancelAbsence(client as never, 'abs-1', 'staff:u-1');

    expect(rowCount).toBe(0);
  });

  it('nenhuma SQL toca patients/contracted_service_providers/WJA/encuadres, nem campo de motivo; só patient_itinerary_absence (≥ 3×)', async () => {
    const client = clientStub({
      rows: [{ id: 'abs-1', on_date: '2026-09-28', assignment_id: 'alloc-1', substitute_worker_id: null, cancelled_at: null }],
      rowCount: 1,
    });

    await writer.insertAbsence(client as never, {
      allocationId: 'alloc-1',
      date: '2026-09-28',
      substituteWorkerId: null,
      substituteApplicationId: null,
      actorUid: 'u-1',
    });
    await writer.findAbsence(client as never, 'p-1', 's-1', 'abs-1');
    await writer.updateSubstitute(client as never, 'abs-1', null, null, 'u-1');
    await writer.cancelAbsence(client as never, 'abs-1', 'u-1');

    const allSql = client.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(
      /DELETE|UPDATE patients|contracted_service_providers|INSERT INTO worker_job_applications|UPDATE worker_job_applications|encuadres|reason|motivo/i.test(
        allSql,
      ),
    ).toBe(false);
    expect((allSql.match(/patient_itinerary_absence/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
