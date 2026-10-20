/**
 * 058b-paridade-hoje.e2e.test.ts @integration — spec 058 T212: o "hoje" do SQL (`fn_operation_date`) e o do TS (`operationDateOf`)
 * dão o mesmo dia, com o processo e a sessão em fuso EXTERNO (Asia/Tokyo; AR e BR são ambos −03, passariam por coincidência).
 * O fuso é fixado AQUI (1ª linha executável): `npm run test:e2e` não define TZ, então o arquivo não depende do ambiente.
 */
process.env.TZ = 'Asia/Tokyo'; // antes de qualquer `Date` (o V8 relê TZ ao ser alterada em runtime)

import { Pool } from 'pg';
import { COUNTRY_TIMEZONE_MAP } from '@shared/locale/CountryTimezone';
import { operationDateOf, UnknownCountryError } from '@shared/locale/operationDate';
import { novoPool, erroDe } from './helpers/itinerario058bDb';

describe('058b paridade "hoje": fn_operation_date (SQL) × operationDateOf (TS) @integration', () => {
  let pool: Pool;
  beforeAll(() => { pool = novoPool(); });
  afterAll(async () => { await pool.end(); });

  const paisesDoCheck = async (conname: string): Promise<string[]> => {
    const r = await pool.query<{ def: string }>('SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1', [conname]);
    expect(r.rows).toHaveLength(1); // 0 linhas seria "não medi"
    return [...r.rows[0].def.matchAll(/'([A-Z]{2})'::text/g)].map((m) => m[1]).sort();
  };

  it('controle do fuso externo: TZ=Asia/Tokyo', () => {
    expect(process.env.TZ).toBe('Asia/Tokyo');
    expect(new Date(0).getTimezoneOffset()).toBe(-540); // prova o EFEITO: o processo realmente está em UTC+9
  });

  it.each([
    ['AR', '2024-03-10T01:30:00Z', '2024-03-09'],
    ['AR', '2024-03-10T23:30:00Z', '2024-03-10'],
    ['BR', '2024-03-10T01:30:00Z', '2024-03-09'],
    ['BR', '2024-03-10T23:30:00Z', '2024-03-10'],
  ])('paridade TS × SQL: %s em %s', async (pais, instante, esperado) => {
    const c = await pool.connect();
    try {
      await c.query("SET TIME ZONE 'Asia/Tokyo'");
      const r = await c.query<{ d: string }>('SELECT fn_operation_date($1, $2::timestamptz)::text AS d', [pais, instante]);
      expect(r.rows[0].d).toBe(esperado);
      expect(operationDateOf(pais, new Date(instante))).toBe(esperado);
    } finally {
      c.release();
    }
  });

  it('país desconhecido: SQL e TS lançam', async () => {
    const e1 = await erroDe(() => pool.query("SELECT fn_operation_date('XX')"));
    expect(e1?.code).toBe('P0001');
    expect(e1?.message).toContain('UNKNOWN_COUNTRY');
    const e2 = await erroDe(() => pool.query('SELECT fn_operation_date(NULL)'));
    expect(e2?.code).toBe('P0001');
    expect(e2?.message).toContain('UNKNOWN_COUNTRY');
    expect(() => operationDateOf('XX', new Date())).toThrow(UnknownCountryError);
  });

  it('paridade mapa × CHECK: chaves de COUNTRY_TIMEZONE_MAP = países de pcs_country_check = países que a função aceita', async () => {
    const mapa = Object.keys(COUNTRY_TIMEZONE_MAP).sort();
    const check = await paisesDoCheck('pcs_country_check');
    expect(mapa.length).toBeGreaterThan(0);
    expect(check).toEqual(mapa);
    const aceitos: string[] = [];
    for (const p of new Set([...mapa, ...check])) {
      try {
        await pool.query('SELECT fn_operation_date($1)', [p]);
        aceitos.push(p);
      } catch { /* recusado */ }
    }
    expect(aceitos.sort()).toEqual(check);
  });
});
