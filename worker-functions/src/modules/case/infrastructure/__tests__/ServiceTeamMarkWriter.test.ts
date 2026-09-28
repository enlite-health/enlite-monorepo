/**
 * ServiceTeamMarkWriter — Fase 10, DX-10.6 (2). Recebe o `client` já aberto (a transação é de
 * quem chama) — o dublê aqui é só o `client`, sem `DatabaseConnection`/`inPatientTransaction`.
 */
import { ServiceTeamMarkWriter } from '../ServiceTeamMarkWriter';

function clientStub() {
  const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  return { query };
}

describe('ServiceTeamMarkWriter', () => {
  let writer: ServiceTeamMarkWriter;

  beforeEach(() => {
    writer = new ServiceTeamMarkWriter();
  });

  it('insertRejection: 1 query, INSERT em contracted_service_rejections com os 4 parâmetros na ordem certa', async () => {
    const client = clientStub();

    await writer.insertRejection(client as never, {
      serviceId: 's-1',
      workerId: 'w-1',
      category: 'OTHER',
      actorUid: 'staff:u-1',
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/INSERT INTO contracted_service_rejections/);
    expect(String(sql)).toMatch(/reject_reason_category, rejected_by, created_by, updated_by/);
    expect(params).toEqual(['s-1', 'w-1', 'OTHER', 'staff:u-1']);
  });

  it('revertRejection: 1 query, UPDATE em contracted_service_rejections; devolve o rowCount', async () => {
    const client = clientStub();

    const rowCount = await writer.revertRejection(client as never, {
      serviceId: 's-1',
      workerId: 'w-1',
      category: 'REAVALIACAO',
      actorUid: 'staff:u-1',
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/UPDATE contracted_service_rejections/);
    expect(String(sql)).toMatch(/reverted_at = now\(\)/);
    expect(String(sql)).toMatch(/WHERE service_id = \$1 AND worker_id = \$2 AND reverted_at IS NULL/);
    expect(params).toEqual(['s-1', 'w-1', 'staff:u-1', 'REAVALIACAO']);
    expect(rowCount).toBe(1);
  });

  it('revertRejection: rowCount 0 quando o UPDATE não bate nenhuma linha (nenhuma marca ativa)', async () => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };

    const rowCount = await writer.revertRejection(client as never, {
      serviceId: 's-1',
      workerId: 'w-1',
      category: 'OTHER',
      actorUid: 'staff:u-1',
    });

    expect(rowCount).toBe(0);
  });

  it('nenhuma SQL nomeia worker_job_applications/encuadres/patient_itinerary; só contracted_service_rejections (≥ 2×)', async () => {
    const client = clientStub();

    await writer.insertRejection(client as never, { serviceId: 's-1', workerId: 'w-1', category: 'OTHER', actorUid: 'u-1' });
    await writer.revertRejection(client as never, { serviceId: 's-1', workerId: 'w-1', category: 'OTHER', actorUid: 'u-1' });

    const allSql = client.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(/worker_job_applications|encuadres|patient_itinerary/i.test(allSql)).toBe(false);
    expect((allSql.match(/contracted_service_rejections/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
