import { DestinationNotAvailableForScheduledError, WorkerHasScheduledAttendancesError } from '../serviceExitReason';

describe('serviceExitReason — erros de domínio da B2', () => {
  it('DestinationNotAvailableForScheduledError: name e instanceof Error', () => {
    const e = new DestinationNotAvailableForScheduledError();

    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('DestinationNotAvailableForScheduledError');
  });

  it('WorkerHasScheduledAttendancesError: guarda substitutionDates e futureEntryFrom; sem id de pessoa na message', () => {
    const e = new WorkerHasScheduledAttendancesError(['2026-10-26'], '2026-10-28');

    expect(e.substitutionDates).toEqual(['2026-10-26']);
    expect(e.futureEntryFrom).toBe('2026-10-28');
    expect(e.message).toBe('worker has scheduled attendances');
  });
});
