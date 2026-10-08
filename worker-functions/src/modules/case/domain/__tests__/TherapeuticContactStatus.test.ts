import { addCivilDays, deadlineDateOf, localDateOf, sortKinds, REMINDER_DAY_OFFSETS } from '../TherapeuticContactStatus';

describe('TherapeuticContactStatus (spec 048)', () => {
  it('o dia civil é o do fuso do país: 23:30 em Buenos Aires ainda é o dia anterior ao UTC', () => {
    // 2026-10-09T02:30Z = 2026-10-08 23:30 em Buenos Aires (UTC-3)
    const instant = new Date('2026-10-09T02:30:00Z');
    expect(localDateOf(instant, 'AR')).toBe('2026-10-08');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-10-09');
  });

  it('prazo = dia local + 15, e cruza o mês', () => {
    expect(deadlineDateOf(new Date('2026-10-09T02:30:00Z'), 'AR')).toBe('2026-10-23');
    expect(deadlineDateOf(new Date('2026-10-20T15:00:00Z'), 'AR')).toBe('2026-11-04');
  });

  it('o prazo também vira pelo fuso (23:30 AR de 30/11 vence 15/12, não 16/12)', () => {
    expect(deadlineDateOf(new Date('2026-12-01T02:30:00Z'), 'AR')).toBe('2026-12-15');
  });

  it('addCivilDays atravessa fim de ano', () => {
    expect(addCivilDays('2026-12-20', 15)).toBe('2027-01-04');
  });

  it('lembretes são 2, 5 e 12 e a lista de campos tem ordem fixa', () => {
    expect([...REMINDER_DAY_OFFSETS]).toEqual([2, 5, 12]);
    expect(sortKinds(['CARE_TEAM', 'RESPONSIBLE', 'COVERAGE'])).toEqual(['RESPONSIBLE', 'COVERAGE', 'CARE_TEAM']);
  });
});
