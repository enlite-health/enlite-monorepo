import { ScheduledAttendanceReader, hasScheduledAttendances } from '../ScheduledAttendanceReader';

describe('ScheduledAttendanceReader', () => {
  it('listFor: 2 queries com [serviceId, workerId, today]; mapeia substituições e entradas futuras', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ absence_id: 'ab-1', on_date: '2026-10-26' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ allocation_id: 'al-9', valid_from: '2026-10-28', replaces_allocation_id: 'al-3', replaces_status: 'ACTIVE', replaces_valid_from: '2026-09-01', replaces_end_is_eve: true }], rowCount: 1 });

    const result = await new ScheduledAttendanceReader().listFor({ query } as never, 's-1', 'w-1', '2026-10-21');

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual(['s-1', 'w-1', '2026-10-21']);
    expect(query.mock.calls[1][1]).toEqual(['s-1', 'w-1', '2026-10-21']);
    expect(String(query.mock.calls[0][0])).toMatch(/ab\.cancelled_at IS NULL AND ab\.on_date >= \$3::date/);
    expect(String(query.mock.calls[1][0])).toMatch(/a\.valid_from > \$3::date/);
    // Titular achado pela LIGAÇÃO do REPLACE (nunca pela data).
    expect(String(query.mock.calls[1][0])).toMatch(/l\.kind = 'REPLACE' AND l\.new_assignment_id = a\.id/);
    expect(String(query.mock.calls[1][0])).not.toMatch(/valid_to = a\.valid_from - 1\s+LIMIT/);
    expect(result).toEqual({
      substitutions: [{ absenceId: 'ab-1', date: '2026-10-26' }],
      futureEntries: [{
        allocationId: 'al-9', validFrom: '2026-10-28',
        replaces: { allocationId: 'al-3', status: 'ACTIVE', validFrom: '2026-09-01', endIsEve: true },
      }],
    });
  });

  it('listFor: entrada sem ligação REPLACE → replaces null; titular CANCELLED com fim NULL → endIsEve false', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [
          { allocation_id: 'al-8', valid_from: '2026-10-27', replaces_allocation_id: null, replaces_status: null, replaces_valid_from: null, replaces_end_is_eve: null },
          { allocation_id: 'al-9', valid_from: '2026-10-28', replaces_allocation_id: 'al-3', replaces_status: 'CANCELLED', replaces_valid_from: '2026-10-30', replaces_end_is_eve: null },
        ],
        rowCount: 2,
      });

    const result = await new ScheduledAttendanceReader().listFor({ query } as never, 's-1', 'w-1', '2026-10-21');

    expect(result.futureEntries).toEqual([
      { allocationId: 'al-8', validFrom: '2026-10-27', replaces: null },
      { allocationId: 'al-9', validFrom: '2026-10-28', replaces: { allocationId: 'al-3', status: 'CANCELLED', validFrom: '2026-10-30', endIsEve: false } },
    ]);
  });

  it('listFor: sem agendamento → listas vazias; hasScheduledAttendances = false', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await new ScheduledAttendanceReader().listFor({ query } as never, 's-1', 'w-1', '2026-10-21');

    expect(result).toEqual({ substitutions: [], futureEntries: [] });
    expect(hasScheduledAttendances(result)).toBe(false);
  });

  it('hasScheduledAttendances: só substituição → true; só entrada → true', () => {
    expect(hasScheduledAttendances({ substitutions: [{ absenceId: 'ab-1', date: '2026-10-26' }], futureEntries: [] })).toBe(true);
    expect(
      hasScheduledAttendances({ substitutions: [], futureEntries: [{ allocationId: 'al-9', validFrom: '2026-10-28', replaces: null }] }),
    ).toBe(true);
  });
});
