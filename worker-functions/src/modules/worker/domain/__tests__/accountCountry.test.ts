import { accountCountryOf } from '../accountCountry';

describe('accountCountryOf — país da conta nova pela região (D733)', () => {
  it.each([
    ['BR', 'BR'],
    ['br', 'BR'],
    [' AR ', 'AR'],
    ['XX', 'AR'],
    ['', 'AR'],
    [undefined, 'AR'],
    [42, 'AR'],
  ])('T-F0b-42 região %p vira %p', (region, esperado) => {
    expect(accountCountryOf(region)).toBe(esperado);
  });
});
