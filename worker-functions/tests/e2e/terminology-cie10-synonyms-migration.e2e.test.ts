/**
 * Migration 560 — sinônimos do CID-10 (F00-F99) no catálogo CID-11, contra o Postgres real.
 *
 * O defeito: "Retraso mental leve" e "F70" não achavam 6A00.0, porque `icd_synonyms` ficava vazia.
 * A migration é o que entrega o dado em prd, no deploy, sem passo manual. Se ela deixar de unir o par
 * ao catálogo corrente, a busca volta a não achar — o teste "aplicar a migration faz a busca devolver
 * 6A00.0" reprova.
 *
 * Aplica o SQL do arquivo (como o runner faria) sobre o catálogo real e restaura o estado no fim.
 * Se o release corrente não tiver 6A00.0, o teste o semeia e o remove depois.
 */
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { Pool, type PoolClient } from 'pg';
import { IcdCatalogTerminology } from '../../src/modules/terminology/infrastructure/IcdCatalogTerminology';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const MIGRATIONS = join(__dirname, '../../migrations');
const FILE = readdirSync(MIGRATIONS).find((f) => /^560_.*\.sql$/.test(f))!;
const SQL = readFileSync(join(MIGRATIONS, FILE), 'utf-8');
const ORIGENS = ['who-icd10to11map:code', 'ops-cie10-es:title'];
const SEED_URI = 'http://id.who.int/icd/release/11/test-cie10/mms/990001';

describe('migration 560 — sinônimos CID-10 F00-F99 (Postgres real) @integration', () => {
  let pool: Pool;
  let release = '';
  let semeou = false;
  const terminology = new IcdCatalogTerminology();

  const limpar = () => pool.query(`DELETE FROM terminology.icd_synonyms WHERE created_by = ANY($1)`, [ORIGENS]);
  const aplicar = async (client?: PoolClient): Promise<string[]> => {
    const c = client ?? (await pool.connect());
    const notices: string[] = [];
    const on = (n: { message?: string }): void => {
      notices.push(n.message ?? '');
    };
    c.on('notice', on as never);
    try {
      await c.query(SQL);
    } finally {
      c.removeListener('notice', on as never);
      if (!client) c.release();
    }
    return notices;
  };
  const busca = async (q: string) => (await terminology.search(q, { chapters: ['06', '08'] })).map((c) => c.code.value);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    release = (await pool.query<{ release: string }>(`SELECT release FROM terminology.icd_releases WHERE is_current`)).rows[0].release;
    const existe = await pool.query(`SELECT 1 FROM terminology.icd_entities WHERE release = $1 AND code = '6A00.0'`, [release]);
    if (existe.rowCount === 0) {
      await pool.query(
        `INSERT INTO terminology.icd_entities (icd_uri, release, code, title_es, title_en, chapter, kind, is_leaf)
         VALUES ($1, $2, '6A00.0', 'Trastorno del desarrollo intelectual, leve', NULL, '06', 'stem', true)`,
        [SEED_URI, release],
      );
      semeou = true;
    }
    await limpar();
  });
  afterAll(async () => {
    await limpar();
    if (semeou) await pool.query(`DELETE FROM terminology.icd_entities WHERE icd_uri = $1`, [SEED_URI]);
    await pool.end();
  });

  it('CONTROLE — sem os sinônimos, 6A00.0 não é o 1º resultado de "Retraso mental leve" nem de "F70"', async () => {
    await limpar();
    expect((await busca('Retraso mental leve'))[0]).not.toBe('6A00.0');
    expect((await busca('F70'))[0]).not.toBe('6A00.0');
  });

  it('aplicar a migration faz "Retraso mental leve" e "F70" devolverem 6A00.0 e emite NOTICE com contagem > 0', async () => {
    await limpar();
    const notices = await aplicar();

    expect(notices.join('\n')).toMatch(/esperadas=\d+, com entidade no release corrente=[1-9]\d*, inseridas=[1-9]\d*/);
    expect((await busca('Retraso mental leve'))[0]).toBe('6A00.0');
    expect((await busca('F70'))[0]).toBe('6A00.0');
  });

  it('é idempotente: aplicar de novo não duplica nem falha (inseridas=0)', async () => {
    await limpar();
    await aplicar();
    const antes = (await pool.query(`SELECT count(*)::int n FROM terminology.icd_synonyms WHERE created_by = ANY($1)`, [ORIGENS])).rows[0].n;
    const notices = await aplicar();
    const depois = (await pool.query(`SELECT count(*)::int n FROM terminology.icd_synonyms WHERE created_by = ANY($1)`, [ORIGENS])).rows[0].n;

    expect(depois).toBe(antes);
    expect(notices.join('\n')).toMatch(/inseridas=0/);
  });

  it('sem release corrente (catálogo ausente) insere 0 linhas, NÃO falha e AVISA com a contagem zero', async () => {
    await limpar();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE terminology.icd_releases SET is_current = false, promoted_at = NULL, promoted_by = NULL`);
      const notices = await aplicar(client);
      const n = (await client.query(`SELECT count(*)::int n FROM terminology.icd_synonyms WHERE created_by = ANY($1)`, [ORIGENS])).rows[0].n;
      expect(n).toBe(0);
      expect(notices.join('\n')).toMatch(/com entidade no release corrente=0, inseridas=0/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('só as duas origens do CID-10 entram — nunca indexTerm da OMS', async () => {
    await limpar();
    await aplicar();
    const { rows } = await pool.query<{ created_by: string }>(
      `SELECT DISTINCT created_by FROM terminology.icd_synonyms ORDER BY 1`,
    );
    expect(rows.map((r) => r.created_by).filter((o) => o.startsWith('who-') || o.startsWith('ops-'))).toEqual([...ORIGENS].sort());
  });
});
