import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

/**
 * Spec 030 (F1, T011/T012) — seed `495_seed_therapeutic_segments.sql` contra banco REAL.
 *
 * A fixture `tests/fixtures/segmentos-ana-care.txt` tem SÓ a 1ª coluna da planilha do Javier (os
 * rótulos; lex C10 — as colunas 2-3 nunca entram) e "Segmento Personalizado" fica de fora (DEC-41).
 * O arquivo é lido DENTRO dos casos, não no topo: antes da migration existir, o caso (1) tem de
 * falhar por contagem (esperado 13, recebido 0), não por ENOENT na coleta.
 */

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const SEED_FILE = join(__dirname, '..', '..', 'migrations', '495_seed_therapeutic_segments.sql');
const FIXTURE_FILE = join(__dirname, '..', 'fixtures', 'segmentos-ana-care.txt');

const fixtureLabels = (): string[] => readFileSync(FIXTURE_FILE, 'utf8').split('\n').filter((l) => l.length > 0);

/** Aplica o .sql como o runner de migrations faz: um `psql` com ON_ERROR_STOP; devolve o rc. */
function applySeed(): number {
  try {
    execFileSync('psql', [DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-q', '-f', SEED_FILE], { stdio: ['ignore', 'pipe', 'pipe'] });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? 1;
  }
}

describe('migration 495 — seed dos segmentos Ana Care (banco real) @integration', () => {
  let pool: Pool;

  const seeded = async (): Promise<{ label: string; sort_order: number }[]> =>
    (await pool.query<{ label: string; sort_order: number }>(
      `SELECT label, sort_order FROM therapeutic_segments WHERE active AND created_by = 'seed:495' ORDER BY sort_order, lower(label)`,
    )).rows;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
  });
  afterAll(async () => {
    await pool.end();
  });

  it('(1) a fixture tem 13 rótulos e o banco tem 13 linhas ativas com created_by=seed:495', async () => {
    expect(fixtureLabels()).toHaveLength(13);
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM therapeutic_segments WHERE active AND created_by = 'seed:495'`,
    );
    expect(rows[0].n).toBe(13);
  });

  it('(2) rótulos e sort_order estão na ordem da fixture (estritamente crescente)', async () => {
    const rows = await seeded();
    expect(rows.map((r) => r.label)).toEqual(fixtureLabels());
    const ordens = rows.map((r) => r.sort_order);
    expect(ordens).toEqual([...ordens].sort((a, b) => a - b));
    expect(new Set(ordens).size).toBe(13);
  });

  it('(3) "Personalizado" não aparece no .sql nem no banco', async () => {
    expect(readFileSync(SEED_FILE, 'utf8')).not.toMatch(/personalizado/i);
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM therapeutic_segments WHERE label ILIKE '%personalizado%'`);
    expect(rows[0].n).toBe(0);
  });

  it('(4) aplicar o .sql 2× (ON_ERROR_STOP=1) dá rc=0 nas duas e continua 13', async () => {
    const rcs = [applySeed(), applySeed()];
    expect(rcs).toEqual([0, 0]);
    expect(await seeded()).toHaveLength(13);
  });
});
