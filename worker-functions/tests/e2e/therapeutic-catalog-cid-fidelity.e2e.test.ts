/**
 * Spec 091 (F1, T111, CA-1 e CA-3) — fidelidade do catálogo por CID-11 à planilha, no BANCO REAL.
 *
 * O esperado vem do xlsx CRU (lido aqui com `xlsx`, por cabeçalho); nada do gerador é importado (design §9.11).
 * O obtido vem de `PgTherapeuticCatalogCascade.catalogFor` com as categorias da planilha, uma vez por serviço.
 *   - pares  = (categoria, serviço)            -> lista ORDENADA de `título|descrição` dos objetivos (DD-4)
 *   - triplas = (categoria, serviço, objetivo)  -> lista ORDENADA de `título|descrição|frecuencia` das atividades
 * Casos positivos (cada um em transação com ROLLBACK) provam que o medidor enxerga: vínculo a menos, a mais,
 * frecuencia trocada, ordem trocada. Só dado do catálogo da planilha (não é dado de paciente).
 */
import * as path from 'path';
import { Pool, PoolClient } from 'pg';
import * as XLSX from 'xlsx';
import { PgTherapeuticCatalogCascade } from '../../src/modules/case/infrastructure/PgTherapeuticCatalogCascade';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const XLSX_PATH = path.resolve(
  __dirname,
  '../../scripts/therapeutic-catalog/fonte/Catalogo_objetivos_actividades_por_diagnostico_CIE11.xlsx',
);

/** Rótulo da planilha -> service_code do banco (declarado aqui, independente do gerador). */
const SERVICO_DO_BANCO: Readonly<Record<string, string>> = { AT: 'AT', Cuidado: 'CAREGIVER' };
const ID_LINHA = /^(\S+)-(AT|CU)-([OA])(\d+)$/;

interface Item { n: number; texto: string; objetivoId?: string }
interface Esperado {
  /** `cat|serviço` -> objetivos ordenados */
  pares: Map<string, string[]>;
  /** `cat|serviço|título|descrição` do objetivo -> atividades ordenadas */
  triplas: Map<string, string[]>;
  categorias: string[];
}

function linhas(wb: XLSX.WorkBook, aba: string): Record<string, string>[] {
  const m = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[aba], { header: 1, defval: '' });
  const cab = m[0].map((c) => String(c).trim());
  return m.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => Object.fromEntries(cab.map((nome, i) => [nome, String(r[i] ?? '').trim()])));
}

const ordenar = (a: Item, b: Item): number =>
  a.n - b.n || (a.texto.toLowerCase() < b.texto.toLowerCase() ? -1 : a.texto.toLowerCase() > b.texto.toLowerCase() ? 1 : 0);

function esperadoDaPlanilha(): Esperado {
  const wb = XLSX.readFile(XLSX_PATH);
  const objetivos = linhas(wb, 'Objetivos específicos');
  const atividades = linhas(wb, 'Actividades de rutina');

  const objPorId = new Map<string, { chave: string; texto: string }>();
  const paresItens = new Map<string, Item[]>();
  const categorias = new Set<string>();
  for (const l of objetivos) {
    const m = ID_LINHA.exec(l['ID']);
    if (!m || m[3] !== 'O') throw new Error(`ID de objetivo inesperado: ${l['ID']}`);
    const servico = SERVICO_DO_BANCO[l['Tipo de servicio']];
    const cat = l['Código CIE-11'];
    const texto = `${l['Título']}|${l['Descripción']}`;
    categorias.add(cat);
    objPorId.set(l['ID'], { chave: `${cat}|${servico}|${texto}`, texto });
    const k = `${cat}|${servico}`;
    paresItens.set(k, [...(paresItens.get(k) ?? []), { n: Number(m[4]), texto }]);
  }

  const triplasItens = new Map<string, Item[]>();
  for (const { chave } of objPorId.values()) triplasItens.set(chave, []);
  for (const l of atividades) {
    const m = ID_LINHA.exec(l['ID']);
    if (!m || m[3] !== 'A') throw new Error(`ID de atividade inesperado: ${l['ID']}`);
    const dono = objPorId.get(l['ID objetivo']);
    if (!dono) throw new Error(`atividade ${l['ID']} aponta objetivo inexistente ${l['ID objetivo']}`);
    triplasItens.get(dono.chave)!.push({ n: Number(m[4]), texto: `${l['Título']}|${l['Descripción']}|${l['Frecuencia sugerida']}` });
  }

  const emTexto = (mapa: Map<string, Item[]>): Map<string, string[]> =>
    new Map([...mapa].map(([k, v]) => [k, [...v].sort(ordenar).map((i) => i.texto)]));
  return { pares: emTexto(paresItens), triplas: emTexto(triplasItens), categorias: [...categorias].sort() };
}

interface Medida { pares: number; triplas: number; totalPares: number; totalTriplas: number; divergencias: string[] }

/** Compara o que `catalogFor` devolve (1 chamada por serviço, todas as categorias) com o esperado. */
async function medir(db: Pick<Pool | PoolClient, 'query'>, esperado: Esperado): Promise<Medida> {
  const cascata = new PgTherapeuticCatalogCascade(db);
  const divergencias: string[] = [];
  let pares = 0;
  let triplas = 0;
  for (const servico of Object.values(SERVICO_DO_BANCO)) {
    const obtido = await cascata.catalogFor(servico, esperado.categorias);
    for (const cat of esperado.categorias) {
      const objs = obtido.get(cat) ?? [];
      const chavePar = `${cat}|${servico}`;
      const lista = objs.map((o) => `${o.label}|${o.description ?? ''}`);
      if (JSON.stringify(lista) === JSON.stringify(esperado.pares.get(chavePar) ?? [])) pares++;
      else divergencias.push(`par ${chavePar}`);
      for (const o of objs) {
        const chaveTripla = `${chavePar}|${o.label}|${o.description ?? ''}`;
        const ativ = o.activities.map((a) => `${a.label}|${a.description ?? ''}|${a.suggestedFrequency ?? ''}`);
        const esp = esperado.triplas.get(chaveTripla);
        if (esp && JSON.stringify(ativ) === JSON.stringify(esp)) triplas++;
        else divergencias.push(`tripla ${chaveTripla}`);
      }
    }
  }
  const totalPares = esperado.categorias.length * Object.keys(SERVICO_DO_BANCO).length;
  return { pares, triplas, totalPares, totalTriplas: esperado.triplas.size, divergencias };
}

describe('catálogo por CID — fidelidade à planilha (banco real) @integration', () => {
  let pool: Pool;
  let esperado: Esperado;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    esperado = esperadoDaPlanilha();
  });
  afterAll(async () => { await pool.end(); });

  /** Roda `fn` numa transação e sempre desfaz. */
  async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  }

  const um = async <R extends Record<string, unknown>>(c: PoolClient, sql: string): Promise<R> => {
    const { rows } = await c.query<R>(sql);
    if (rows.length !== 1) throw new Error(`esperava 1 linha, veio ${rows.length}: ${sql}`);
    return rows[0];
  };

  it('contagens: carga completa e catálogo antigo inativo (CA-1)', async () => {
    const q = async (sql: string): Promise<number> => Number((await pool.query<{ n: string }>(sql)).rows[0].n);
    expect(await q(`SELECT count(*) AS n FROM therapeutic_specific_objectives WHERE active`)).toBe(128);
    expect(await q(`SELECT count(*) AS n FROM therapeutic_activities WHERE active`)).toBe(254);
    expect(await q(`SELECT count(*) AS n FROM therapeutic_objective_icd_categories`)).toBe(11910);
    expect(await q(`SELECT count(*) AS n FROM therapeutic_activity_icd_categories`)).toBe(19699);
    expect(await q(`SELECT count(*) AS n FROM therapeutic_segments WHERE active`)).toBe(0);
    // itens do seed 415 (no banco do e2e: só os semeados pela migration 415): todos inativos; total>0 prova que a medição acharia algo
    expect(await q(`SELECT count(*) AS n FROM (
        SELECT id FROM therapeutic_specific_objectives WHERE created_by = 'seed:415'
        UNION ALL SELECT id FROM therapeutic_activities WHERE created_by = 'seed:415') s`)).toBeGreaterThan(0);
    expect(await q(`SELECT count(*) AS n FROM (
        SELECT id FROM therapeutic_specific_objectives WHERE created_by = 'seed:415' AND active
        UNION ALL SELECT id FROM therapeutic_activities WHERE created_by = 'seed:415' AND active) s`)).toBe(0);
  });

  it('fidelidade: pares e triplas do banco = planilha crua, listas ordenadas', async () => {
    const m = await medir(pool, esperado);
    // eslint-disable-next-line no-console
    console.log(`pares ${m.pares}/${m.totalPares}\ntriplas ${m.triplas}/${m.totalTriplas}`);
    expect(m.totalPares).toBe(2532);
    expect(m.totalTriplas).toBe(11910);
    expect(m.divergencias.slice(0, 5)).toEqual([]);
    expect(m.pares).toBe(2532);
    expect(m.triplas).toBe(11910);
  });

  describe('casos positivos: o medidor acusa a divergência (cada um com ROLLBACK)', () => {
    it('vínculo a menos (objetivo)', () =>
      tx(async (c) => {
        const v = await um<{ objective_id: string; category_code: string }>(c,
          `SELECT objective_id, category_code FROM therapeutic_objective_icd_categories ORDER BY objective_id, category_code LIMIT 1`);
        await c.query(`DELETE FROM therapeutic_objective_icd_categories WHERE objective_id = $1 AND category_code = $2`,
          [v.objective_id, v.category_code]);
        expect((await medir(c, esperado)).divergencias.length).toBeGreaterThanOrEqual(1);
      }));

    it('vínculo a menos (atividade)', () =>
      tx(async (c) => {
        const v = await um<{ activity_id: string; category_code: string }>(c,
          `SELECT activity_id, category_code FROM therapeutic_activity_icd_categories ORDER BY activity_id, category_code LIMIT 1`);
        await c.query(`DELETE FROM therapeutic_activity_icd_categories WHERE activity_id = $1 AND category_code = $2`,
          [v.activity_id, v.category_code]);
        expect((await medir(c, esperado)).divergencias.length).toBeGreaterThanOrEqual(1);
      }));

    it('vínculo a mais', () =>
      tx(async (c) => {
        const alvo = await um<{ objective_id: string; category_code: string }>(c,
          `SELECT o.id AS objective_id, code AS category_code
             FROM therapeutic_specific_objectives o
             CROSS JOIN unnest(string_to_array('${esperado.categorias.join(',')}', ',')) AS code
            WHERE o.active AND NOT EXISTS (
                    SELECT 1 FROM therapeutic_objective_icd_categories l
                     WHERE l.objective_id = o.id AND l.category_code = code)
            ORDER BY o.id, code LIMIT 1`);
        await c.query(
          `INSERT INTO therapeutic_objective_icd_categories (objective_id, category_code, sort_order, created_by) VALUES ($1, $2, 9999, 'e2e091-fidelity')`,
          [alvo.objective_id, alvo.category_code]);
        expect((await medir(c, esperado)).divergencias.length).toBeGreaterThanOrEqual(1);
      }));

    it('frecuencia trocada', () =>
      tx(async (c) => {
        const a = await um<{ id: string }>(c, `SELECT id FROM therapeutic_activities WHERE active ORDER BY id LIMIT 1`);
        await c.query(`UPDATE therapeutic_activities SET suggested_frequency = 'e2e091 trocada' WHERE id = $1`, [a.id]);
        expect((await medir(c, esperado)).divergencias.length).toBeGreaterThanOrEqual(1);
      }));

    it('ordem trocada (sort_order de 2 vínculos da mesma categoria e serviço)', () =>
      tx(async (c) => {
        const p = await um<{ a: string; b: string; cat: string; sa: number; sb: number }>(c,
          `SELECT la.objective_id AS a, lb.objective_id AS b, la.category_code AS cat, la.sort_order AS sa, lb.sort_order AS sb
             FROM therapeutic_objective_icd_categories la
             JOIN therapeutic_objective_icd_categories lb
               ON lb.category_code = la.category_code AND lb.objective_id > la.objective_id AND lb.sort_order <> la.sort_order
             JOIN therapeutic_specific_objectives oa ON oa.id = la.objective_id
             JOIN therapeutic_specific_objectives ob ON ob.id = lb.objective_id AND ob.service_code = oa.service_code
            ORDER BY la.category_code, la.objective_id, lb.objective_id LIMIT 1`);
        const set = `UPDATE therapeutic_objective_icd_categories SET sort_order = $1 WHERE objective_id = $2 AND category_code = $3`;
        await c.query(set, [p.sb, p.a, p.cat]);
        await c.query(set, [p.sa, p.b, p.cat]);
        expect((await medir(c, esperado)).divergencias.length).toBeGreaterThanOrEqual(1);
      }));
  });
});
