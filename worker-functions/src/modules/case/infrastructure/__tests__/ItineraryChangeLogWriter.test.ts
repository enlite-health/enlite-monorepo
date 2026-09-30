/**
 * ItineraryChangeLogWriter — registro de trocas (migration 494). Cliente falso na fronteira; o SQL
 * de verdade (FK, CHECKs, append-only, país, RLS) é provado no e2e `itinerary-change-log`.
 */
import { ItineraryChangeLogWriter } from '../ItineraryChangeLogWriter';

const cliente = () => ({ query: jest.fn().mockResolvedValue({ rows: [{ id: 'log-1' }] }) });

describe('ItineraryChangeLogWriter.insert', () => {
  it('UMA query no client recebido, só INSERT (append-only), devolve o id', async () => {
    const cli = cliente();
    const r = await new ItineraryChangeLogWriter().insert(cli as never, {
      serviceId: 's-1',
      kind: 'ABSENCE',
      outgoingWorkerId: 'w-out',
      incomingWorkerId: 'w-in',
      assignmentId: 'a-1',
      absenceId: 'ab-1',
      effectiveDate: '2026-09-28',
      reasonCode: 'OTHER',
      actorUid: 'staff:u-1',
    });
    expect(r).toEqual({ id: 'log-1' });
    expect(cli.query).toHaveBeenCalledTimes(1);
    const [sql, params] = cli.query.mock.calls[0];
    expect(sql).toMatch(/^\s*INSERT INTO patient_itinerary_change_log/);
    expect(sql).not.toMatch(/UPDATE|DELETE/);
    expect(sql).not.toMatch(/country/); // herdado do serviço pelo trigger
    expect(params).toEqual(['s-1', 'ABSENCE', 'w-out', 'w-in', 'a-1', null, 'ab-1', '2026-09-28', 'OTHER', null, 'staff:u-1']);
  });

  it('campos opcionais ausentes viram NULL (destination só REPLACE/REMOVE)', async () => {
    const cli = cliente();
    await new ItineraryChangeLogWriter().insert(cli as never, {
      serviceId: 's-1',
      kind: 'REMOVE',
      outgoingWorkerId: 'w-out',
      effectiveDate: '2026-09-28',
      reasonCode: 'OTHER',
      destination: 'RESERVE',
      actorUid: 'u-1',
    });
    const params = cli.query.mock.calls[0][1] as unknown[];
    expect(params[3]).toBeNull(); // incoming
    expect(params[4]).toBeNull(); // assignment
    expect(params[5]).toBeNull(); // new assignment
    expect(params[6]).toBeNull(); // absence
    expect(params[9]).toBe('RESERVE');
  });

  it('erro do banco sobe cru (quem chama decide; a transação desfaz)', async () => {
    const boom = Object.assign(new Error('fk'), { code: '23503' });
    const cli = { query: jest.fn().mockRejectedValue(boom) };
    await expect(
      new ItineraryChangeLogWriter().insert(cli as never, { serviceId: 's', kind: 'ABSENCE', outgoingWorkerId: 'w', effectiveDate: '2026-09-28', reasonCode: 'X', actorUid: 'u' }),
    ).rejects.toBe(boom);
  });
});
