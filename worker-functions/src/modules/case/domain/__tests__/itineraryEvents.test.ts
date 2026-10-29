/**
 * itineraryEvents.test — as funções de DATA do itinerário (D445.3). Roda com `TZ` variado (`beforeAll`/`afterAll`
 * trocando `process.env.TZ`) porque elas só podem confiar em `Date.UTC` — um teste que passa só por coincidência de fuso
 * (São Paulo/Buenos Aires = -03) é o que a memória `teste-de-fuso-passa-por-coincidencia` pede para nunca escrever de novo.
 * A expansão faixa × data vive em `serviceOccurrences.test.ts` (spec 069).
 */
import { weekdayOfDateString, addDaysToDateString, dayCountInclusive } from '../itineraryEvents';

const ORIGINAL_TZ = process.env.TZ;

describe.each(['UTC', 'Asia/Tokyo'])('itineraryEvents (TZ=%s)', (tz) => {
  beforeAll(() => {
    process.env.TZ = tz;
  });
  afterAll(() => {
    process.env.TZ = ORIGINAL_TZ;
  });

  it('weekdayOfDateString: 2026-09-27 é domingo (0), 2026-09-28 é segunda (1)', () => {
    expect(weekdayOfDateString('2026-09-27')).toBe(0);
    expect(weekdayOfDateString('2026-09-28')).toBe(1);
  });

  it('addDaysToDateString: soma e subtrai, inclusive virada de mês/ano', () => {
    expect(addDaysToDateString('2026-09-27', 1)).toBe('2026-09-28');
    expect(addDaysToDateString('2026-09-27', -1)).toBe('2026-09-26');
    expect(addDaysToDateString('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDaysToDateString('2026-01-31', 1)).toBe('2026-02-01');
  });

  it('dayCountInclusive: mesma data = 1; 7 dias = 8 datas', () => {
    expect(dayCountInclusive('2026-09-27', '2026-09-27')).toBe(1);
    expect(dayCountInclusive('2026-09-27', '2026-10-04')).toBe(8);
  });
});
