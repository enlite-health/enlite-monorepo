/**
 * ItinerarySlotWriter — Fase 11, DX-11.5 (parte do escritor). Dublê é só o `client` (a transação
 * é de quem chama, molde `ServiceTeamMarkWriter.test.ts`); `syncItinerarySlots` injetado no
 * construtor para provar que `writeSchedule` chama o MESMO client e o MESMO `schedule`.
 */
import { ItinerarySlotWriter } from '../ItinerarySlotWriter';

function clientStub(rows: unknown[] = []) {
  const query = jest.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { query };
}

describe('ItinerarySlotWriter', () => {
  it('findServiceForWrite: FOR UPDATE OF pcs, pcs.patient_id = $1, p.deleted_at IS NULL, pcs.active', async () => {
    const client = clientStub([{ id: 's-1', address_id: 'a-1', schedule: null, country: 'AR' }]);
    const writer = new ItinerarySlotWriter();

    const service = await writer.findServiceForWrite(client as never, 'p-1', 's-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/FOR UPDATE OF pcs/);
    expect(String(sql)).toMatch(/pcs\.patient_id = \$1/);
    expect(String(sql)).toMatch(/p\.deleted_at IS NULL/);
    expect(String(sql)).toMatch(/pcs\.active/);
    expect(params).toEqual(['p-1', 's-1']);
    expect(service).toEqual({ id: 's-1', addressId: 'a-1', schedule: null, country: 'AR' });
  });

  it('findServiceForWrite: 0 linha → null', async () => {
    const client = clientStub([]);
    const writer = new ItinerarySlotWriter();

    const service = await writer.findServiceForWrite(client as never, 'p-1', 's-1');

    expect(service).toBeNull();
  });

  it('findSlot: filtra por contracted_service_id (slot de outro serviço → null)', async () => {
    const client = clientStub([]);
    const writer = new ItinerarySlotWriter();

    const slot = await writer.findSlot(client as never, 's-1', 'slot-1');

    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/WHERE id = \$2 AND contracted_service_id = \$1/);
    expect(params).toEqual(['s-1', 'slot-1']);
    expect(slot).toBeNull();
  });

  it('slotHasActiveAllocation: recebe hoje por parâmetro (nunca now()/CURRENT_DATE no SQL)', async () => {
    const client = clientStub([{ exists: true }]);
    const writer = new ItinerarySlotWriter();

    const hasActive = await writer.slotHasActiveAllocation(client as never, 'slot-1', '2026-09-28');

    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).not.toMatch(/now\(\)|CURRENT_DATE/i);
    expect(String(sql)).toMatch(/status = 'ACTIVE'/);
    expect(params).toEqual(['slot-1', '2026-09-28']);
    expect(hasActive).toBe(true);
  });

  it('writeSchedule: 1 UPDATE em patient_contracted_services + chama o sync com o MESMO client e o MESMO schedule', async () => {
    const client = clientStub([]);
    const sync = jest.fn().mockResolvedValue({ upserted: 1, deactivated: 0 });
    const writer = new ItinerarySlotWriter(sync);
    const schedule = [{ dayOfWeek: 1, startTime: '08:00', endTime: '12:00' }];

    await writer.writeSchedule(client as never, 's-1', schedule, 'staff:u-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/UPDATE patient_contracted_services SET schedule = \$2::jsonb/);
    expect(params[0]).toBe('s-1');
    expect(params[2]).toBe('staff:u-1');

    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith(client, 's-1', schedule, 'staff:u-1');
  });

  it('findSlotByKey: filtra por (contracted_service_id, weekday, start_time, end_time)', async () => {
    const client = clientStub([{ id: 'slot-2', weekday: 1, start_time: '08:00', end_time: '12:00', active: true }]);
    const writer = new ItinerarySlotWriter();

    const slot = await writer.findSlotByKey(client as never, 's-1', { weekday: 1, startTime: '08:00', endTime: '12:00' });

    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/contracted_service_id = \$1 AND weekday = \$2 AND start_time = \$3::time AND end_time = \$4::time/);
    expect(params).toEqual(['s-1', 1, '08:00', '12:00']);
    expect(slot).toEqual({ id: 'slot-2', weekday: 1, startTime: '08:00', endTime: '12:00', active: true });
  });

  it('nenhuma SQL toca vaga, candidatura, a tabela antiga de candidatura/entrevista nem a alocação antiga; patient_contracted_services aparece ≥ 2×', async () => {
    const client = clientStub([{ id: 's-1', address_id: 'a-1', schedule: null, country: 'AR' }]);
    const sync = jest.fn().mockResolvedValue({ upserted: 0, deactivated: 0 });
    const writer = new ItinerarySlotWriter(sync);

    await writer.findServiceForWrite(client as never, 'p-1', 's-1');
    await writer.findSlot(client as never, 's-1', 'slot-1');
    await writer.slotHasActiveAllocation(client as never, 'slot-1', '2026-09-28');
    await writer.writeSchedule(client as never, 's-1', null, 'u-1');
    await writer.findSlotByKey(client as never, 's-1', { weekday: 1, startTime: '08:00', endTime: '12:00' });

    const allSql = client.query.mock.calls.map(([sql]: [unknown]) => String(sql)).join('\n');
    expect(/job_postings|worker_job_applications|encuadres|UPDATE patients|contracted_service_providers/i.test(allSql)).toBe(false);
    expect((allSql.match(/patient_contracted_services/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
