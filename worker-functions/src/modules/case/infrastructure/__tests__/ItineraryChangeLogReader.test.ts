/**
 * ItineraryChangeLogReader — leitura do registro de trocas (C9). Cliente falso na fronteira; o SQL
 * de verdade é provado no e2e `itinerary-change-log`.
 */
import { ItineraryChangeLogReader } from '../ItineraryChangeLogReader';

describe('ItineraryChangeLogReader.listByServiceWith', () => {
  it('serviço que não é do paciente (0 linhas) → null, sem consultar o registro', async () => {
    const cli = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const r = await new ItineraryChangeLogReader().listByServiceWith(cli as never, 'p-1', 's-1');
    expect(r).toBeNull();
    expect(cli.query).toHaveBeenCalledTimes(1);
    expect(cli.query.mock.calls[0][1]).toEqual(['p-1', 's-1']);
  });

  it('LEFT JOIN no catálogo para o rótulo; mapeia para camelCase; createdAt em ISO; sem nome de prestador', async () => {
    const cli = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'l-1',
              kind: 'ABSENCE',
              effective_date: '2026-09-28',
              outgoing_worker_id: 'w-out',
              incoming_worker_id: null,
              reason_code: 'OTHER',
              reason_label: 'Otro',
              destination: null,
              created_by: 'staff:u-1',
              created_at: new Date('2026-09-28T15:00:00Z'),
            },
          ],
        }),
    };
    const r = await new ItineraryChangeLogReader().listByServiceWith(cli as never, 'p-1', 's-1');
    const [sql, params] = cli.query.mock.calls[1];
    expect(sql).toMatch(/LEFT JOIN service_exit_reasons ser ON ser\.code = l\.reason_code/);
    expect(sql).not.toMatch(/first_name|last_name|workers/);
    expect(params).toEqual(['s-1']);
    expect(r).toEqual([
      {
        id: 'l-1',
        kind: 'ABSENCE',
        effectiveDate: '2026-09-28',
        outgoingWorkerId: 'w-out',
        incomingWorkerId: null,
        reasonCode: 'OTHER',
        reasonLabel: 'Otro',
        destination: null,
        createdBy: 'staff:u-1',
        createdAt: '2026-09-28T15:00:00.000Z',
      },
    ]);
  });
});
