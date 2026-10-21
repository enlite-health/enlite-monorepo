/**
 * 058b-paridade-hoje.e2e.test.ts @integration — spec 058 T212: o "hoje" do SQL (`fn_operation_date`) e o do TS (`operationDateOf`)
 * dão o mesmo dia, com o processo e a sessão em fuso EXTERNO (Asia/Tokyo; AR e BR são ambos −03, passariam por coincidência).
 * O fuso do PROCESSO não se troca por `process.env.TZ` dentro do Jest (o sandbox não propaga; no CI, sem TZ, o processo roda em UTC).
 * Por isso a parte TS roda num PROCESSO FILHO iniciado com `TZ=Asia/Tokyo` no env, e é o filho que mede o próprio offset (controle).
 */
import { execFileSync } from 'child_process';
import * as path from 'path';
import { Pool } from 'pg';
import { COUNTRY_TIMEZONE_MAP } from '@shared/locale/CountryTimezone';
import { operationDateOf, UnknownCountryError } from '@shared/locale/operationDate';
import { novoPool, erroDe } from './helpers/itinerario058bDb';

const CASOS: Array<[string, string, string]> = [
  ['AR', '2024-03-10T01:30:00Z', '2024-03-09'],
  ['AR', '2024-03-10T23:30:00Z', '2024-03-10'],
  ['BR', '2024-03-10T01:30:00Z', '2024-03-09'],
  ['BR', '2024-03-10T23:30:00Z', '2024-03-10'],
];

interface SaidaFilho { tz: string | undefined; offset: number; hoje: Record<string, string> }

/** Roda `operationDateOf` (o código real, via ts-node) num processo novo com TZ=Asia/Tokyo; o filho devolve o próprio offset e os resultados. */
function rodarNoFusoExterno(): SaidaFilho {
  const raiz = path.resolve(__dirname, '../..'); // worker-functions (tsconfig.json com os aliases @shared/@modules)
  const codigo = `
    const { operationDateOf } = require('@shared/locale/operationDate');
    const casos = JSON.parse(process.argv[1]);
    const hoje = {};
    for (const [pais, instante] of casos) hoje[pais + '|' + instante] = operationDateOf(pais, new Date(instante));
    process.stdout.write(JSON.stringify({ tz: process.env.TZ, offset: new Date(0).getTimezoneOffset(), hoje }));
  `;
  const out = execFileSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', '-e', codigo, JSON.stringify(CASOS.map(([p, i]) => [p, i]))],
    { cwd: raiz, env: { ...process.env, TZ: 'Asia/Tokyo' }, encoding: 'utf8', timeout: 60000 },
  );
  return JSON.parse(out) as SaidaFilho;
}

describe('058b paridade "hoje": fn_operation_date (SQL) × operationDateOf (TS) @integration', () => {
  let pool: Pool;
  let filho: SaidaFilho;
  beforeAll(() => { pool = novoPool(); filho = rodarNoFusoExterno(); });
  afterAll(async () => { await pool.end(); });

  const paisesDoCheck = async (conname: string): Promise<string[]> => {
    const r = await pool.query<{ def: string }>('SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1', [conname]);
    expect(r.rows).toHaveLength(1); // 0 linhas seria "não medi"
    return [...r.rows[0].def.matchAll(/'([A-Z]{2})'::text/g)].map((m) => m[1]).sort();
  };

  it('controle do fuso externo: o processo filho está em TZ=Asia/Tokyo', () => {
    expect(filho.tz).toBe('Asia/Tokyo');
    expect(filho.offset).toBe(-540); // prova o EFEITO medido no filho: o processo realmente está em UTC+9
  });

  it.each(CASOS)('paridade TS (processo em Tokyo) × SQL (sessão em Tokyo): %s em %s', async (pais, instante, esperado) => {
    const c = await pool.connect();
    try {
      await c.query("SET TIME ZONE 'Asia/Tokyo'");
      const r = await c.query<{ d: string }>('SELECT fn_operation_date($1, $2::timestamptz)::text AS d', [pais, instante]);
      expect(r.rows[0].d).toBe(esperado);
      expect(filho.hoje[`${pais}|${instante}`]).toBe(esperado);
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
