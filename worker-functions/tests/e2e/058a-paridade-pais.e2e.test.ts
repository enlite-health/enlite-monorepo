/**
 * 058a-paridade-pais.e2e.test.ts @integration — spec 058 T042 (Rv27): o mapa de fusos, o CHECK de país do serviço, o CHECK de país do contrato e
 * a tabela de moedas cobrem EXATAMENTE os mesmos países. Os literais vêm do `pg_get_constraintdef` do banco VIVO — nenhum `['AR','BR']` aqui.
 * Acrescentar um país ao mapa sem os CHECKs (ou o inverso) derruba o teste.
 */
import { Pool } from 'pg';
import { CURRENCY_COUNTRIES } from '@modules/case/domain/currencyOf';
import { COUNTRY_TIMEZONE_MAP } from '@shared/locale/CountryTimezone';
import { novoPool } from './helpers/contrato058aDb';

describe('058a paridade de países: mapa de fusos × CHECK do banco × moedas @integration', () => {
  let pool: Pool;
  beforeAll(() => { pool = novoPool(); });
  afterAll(async () => { await pool.end(); });

  const paisesDoCheck = async (conname: string): Promise<string[]> => {
    const r = await pool.query<{ def: string }>('SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1', [conname]);
    expect(r.rows).toHaveLength(1); // 0 linhas seria "não medi"
    return [...r.rows[0].def.matchAll(/'([A-Z]{2})'::text/g)].map((m) => m[1]).sort();
  };

  it('chaves de COUNTRY_TIMEZONE_MAP = países de pcs_country_check = países de insurance_contracts_country_check', async () => {
    const mapa = Object.keys(COUNTRY_TIMEZONE_MAP).sort();
    expect(mapa.length).toBeGreaterThan(0);
    expect(await paisesDoCheck('pcs_country_check')).toEqual(mapa);
    expect(await paisesDoCheck('insurance_contracts_country_check')).toEqual(mapa);
  });

  it('moeda: currencyOf cobre exatamente os países do CHECK do contrato', async () => {
    expect([...CURRENCY_COUNTRIES].sort()).toEqual(await paisesDoCheck('insurance_contracts_country_check'));
  });
});
