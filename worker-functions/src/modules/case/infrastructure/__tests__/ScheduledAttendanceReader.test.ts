import { ScheduledAttendanceReader, hasScheduledAttendances } from '../ScheduledAttendanceReader';

describe('ScheduledAttendanceReader', () => {
  it('listFor: 2 queries com [serviceId, workerId, today]; mapeia substituições e entradas futuras', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ absence_id: 'ab-1', on_date: '2026-10-26' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ allocation_id: 'al-9', valid_from: '2026-10-28', replaces_allocation_id: 'al-3' }], rowCount: 1 });

    const result = await new ScheduledAttendanceReader().listFor({ query } as never, 's-1', 'w-1', '2026-10-21');

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual(['s-1', 'w-1', '2026-10-21']);
    expect(query.mock.calls[1][1]).toEqual(['s-1', 'w-1', '2026-10-21']);
    expect(String(query.mock.calls[0][0])).toMatch(/ab\.cancelled_at IS NULL AND ab\.on_date >= \$3::date/);
    expect(String(query.mock.calls[1][0])).toMatch(/a\.valid_from > \$3::date/);
    expect(result).toEqual({
      substitutions: [{ absenceId: 'ab-1', date: '2026-10-26' }],
      futureEntries: [{ allocationId: 'al-9', validFrom: '2026-10-28', replacesAllocationId: 'al-3' }],
    });
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
      hasScheduledAttendances({ substitutions: [], futureEntries: [{ allocationId: 'al-9', validFrom: '2026-10-28', replacesAllocationId: null }] }),
    ).toBe(true);
  });
});
