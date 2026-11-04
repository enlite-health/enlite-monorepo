/**
 * ItinerarySlotWriter — Fase 11, DX-11.5 (parte do escritor), spec 056 T1.7. Dublê é só o `client` (a transação
 * é de quem chama, molde `ServiceTeamMarkWriter.test.ts`). Abrir/fechar faixa é de `ServiceSlotWriter` (delegado,
 * provado em `ServiceSlotWriter.test.ts`); aqui: leituras e a prova de que NADA escreve `pcs.schedule`.
 */
import { ItinerarySlotWriter } from '../ItinerarySlotWriter';
import { openSlot, closeSlot, readVigentSlots } from '../ServiceSlotWriter';

function clientStub(rows: unknown[] = []) {
  const query = jest.fn().mockResolvedValue({ rows, rowCount: rows.length });
  return { query };
}

describe('ItinerarySlotWriter', () => {
  it('findServiceForWrite: FOR UPDATE OF pcs, pcs.patient_id = $1, p.deleted_at IS NULL, pcs.active; não lê pcs.schedule', async () => {
    const client = clientStub([{ id: 's-1', address_id: 'a-1', country: 'AR' }]);
    const service = await new ItinerarySlotWriter().findServiceForWrite(client as never, 'p-1', 's-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/FOR UPDATE OF pcs/);
    expect(String(sql)).toMatch(/pcs\.patient_id = \$1/);
    expect(String(sql)).toMatch(/p\.deleted_at IS NULL/);
    expect(String(sql)).toMatch(/pcs\.active/);
    expect(String(sql)).not.toMatch(/schedule/);
    expect(params).toEqual(['p-1', 's-1']);
    expect(service).toEqual({ id: 's-1', addressId: 'a-1', country: 'AR' });
  });

  it('findServiceForWrite: 0 linha → null', async () => {
    expect(await new ItinerarySlotWriter().findServiceForWrite(clientStub([]) as never, 'p-1', 's-1')).toBeNull();
  });

  it('findSlot: filtra por contracted_service_id, vigência por parâmetro, fim derivado (slot de outro serviço → null)', async () => {
    const client = clientStub([]);
    const slot = await new ItinerarySlotWriter().findSlot(client as never, 's-1', 'slot-1', '2026-10-18');

    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/s\.id = \$2 AND s\.contracted_service_id = \$1/);
    expect(String(sql)).toMatch(/s\.valid @> \$3::date/);
    expect(String(sql)).toContain("make_interval(mins => s.duration_minutes)");
    expect(String(sql)).not.toMatch(/\bs\.active|end_time/);
    expect(params).toEqual(['s-1', 'slot-1', '2026-10-18']);
    expect(slot).toBeNull();
  });

  it('findSlot: mapeia início + duração + fim derivado + vigente', async () => {
    const client = clientStub([{ id: 'slot-1', weekday: 6, start_time: '20:00', duration_minutes: 720, slot_end: '08:00', vigente: true }]);
    expect(await new ItinerarySlotWriter().findSlot(client as never, 's-1', 'slot-1', '2026-10-18')).toEqual({
      id: 'slot-1', weekday: 6, startTime: '20:00', durationMinutes: 720, endTime: '08:00', vigente: true,
    });
  });

  it('slotHasActiveAllocation: recebe hoje por parâmetro (nunca now()/CURRENT_DATE no SQL)', async () => {
    const client = clientStub([{ exists: true }]);
    const hasActive = await new ItinerarySlotWriter().slotHasActiveAllocation(client as never, 'slot-1', '2026-09-28');

    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).not.toMatch(/now\(\)|CURRENT_DATE/i);
    expect(String(sql)).toMatch(/status = 'ACTIVE'/);
    expect(params).toEqual(['slot-1', '2026-09-28']);
    expect(hasActive).toBe(true);
  });

  it('abre/fecha/lê faixa por delegação ao ServiceSlotWriter; writeSchedule e findSlotByKey não existem mais', () => {
    const w = new ItinerarySlotWriter() as unknown as Record<string, unknown>;
    expect(w.openSlot).toBe(openSlot);
    expect(w.closeSlot).toBe(closeSlot);
    expect(w.readVigentSlots).toBe(readVigentSlots);
    expect(w.writeSchedule).toBeUndefined();
    expect(w.findSlotByKey).toBeUndefined();
  });

  it('nenhuma SQL de leitura escreve em pcs.schedule nem toca vaga, candidatura ou alocação antiga', async () => {
    const client = clientStub([{ id: 's-1', address_id: 'a-1', country: 'AR' }]);
    const writer = new ItinerarySlotWriter();
    await writer.findServiceForWrite(client as never, 'p-1', 's-1');
    await writer.findSlot(client as never, 's-1', 'slot-1', '2026-09-28');
    await writer.slotHasActiveAllocation(client as never, 'slot-1', '2026-09-28');

    const allSql = client.query.mock.calls.map(([sql]: [unknown]) => String(sql)).join('\n');
    expect(/job_postings|worker_job_applications|encuadres|UPDATE patients|contracted_service_providers|SET schedule/i.test(allSql)).toBe(false);
  });
});
