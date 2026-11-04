/**
 * operationDate.test.ts — spec 058 T041. Rode com fuso externo: `TZ=Asia/Tokyo npx jest src/shared/locale/__tests__/operationDate.test.ts`
 * (AR e BR são ambos -03: só um mapa de fusos DISTINTOS prova a diferença entre países, e só um TZ do processo diferente de ambos prova
 * que o "hoje" não é o do servidor).
 */
import { COUNTRY_TIMEZONE_MAP } from '../CountryTimezone';
import { UnknownCountryError, buildAsOfByCountry, operationDateInZone, operationDateOf } from '../operationDate';

const MADRUGADA = new Date('2026-10-20T01:30:00Z'); // AR/BR: 22:30 do dia 19
const NOITE = new Date('2026-10-20T23:30:00Z');     // AR/BR: 20:30 do dia 20

describe('operationDate', () => {
  it('operationDateOf: AR e BR usam a data LOCAL (01:30Z ainda é o dia anterior; 23:30Z já é o dia certo), não a do servidor', () => {
    expect(operationDateOf('AR', MADRUGADA)).toBe('2026-10-19');
    expect(operationDateOf('BR', MADRUGADA)).toBe('2026-10-19');
    expect(operationDateOf('AR', NOITE)).toBe('2026-10-20');
    expect(operationDateOf('BR', NOITE)).toBe('2026-10-20');
  });

  it('operationDateInZone: formato AAAA-MM-DD com zeros à esquerda, fuso explícito', () => {
    expect(operationDateInZone('Asia/Tokyo', new Date('2026-01-05T16:00:00Z'))).toBe('2026-01-06'); // 01:00 do dia 6
    expect(operationDateInZone('UTC', new Date('2026-03-04T00:00:00Z'))).toBe('2026-03-04');
  });

  it('país fora do mapa lança UnknownCountryError (nunca UTC), inclusive minúsculo, vazio e chave herdada', () => {
    for (const c of ['XX', 'ar', '', 'constructor', 'toString']) {
      expect(() => operationDateOf(c, MADRUGADA)).toThrow(UnknownCountryError);
    }
    expect(() => operationDateOf('XX', MADRUGADA)).toThrow(/país fora do mapa/);
  });

  it('buildAsOfByCountry com o mapa de produção devolve uma data para cada chave', () => {
    expect(buildAsOfByCountry(COUNTRY_TIMEZONE_MAP, MADRUGADA)).toEqual({ AR: '2026-10-19', BR: '2026-10-19' });
    expect(Object.keys(buildAsOfByCountry(COUNTRY_TIMEZONE_MAP, NOITE)).sort()).toEqual(Object.keys(COUNTRY_TIMEZONE_MAP).sort());
  });

  it('buildAsOfByCountry com fusos distintos (Tokyo +9, Los Angeles -7) cada país no seu fuso, às 01:30Z e às 23:30Z', () => {
    const mapa = { JP: 'Asia/Tokyo', US: 'America/Los_Angeles' };
    expect(buildAsOfByCountry(mapa, MADRUGADA)).toEqual({ JP: '2026-10-20', US: '2026-10-19' }); // 10:30 do 20 × 18:30 do 19
    expect(buildAsOfByCountry(mapa, NOITE)).toEqual({ JP: '2026-10-21', US: '2026-10-20' });      // 08:30 do 21 × 16:30 do 20
  });
});
