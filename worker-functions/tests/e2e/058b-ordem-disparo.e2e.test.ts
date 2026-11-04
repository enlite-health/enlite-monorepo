/**
 * 058b-ordem-disparo.e2e.test.ts @integration — spec 058 T214: os triggers BEFORE do mesmo evento disparam por ORDEM DE NOME
 * (não de criação). A Trava A (`trg_058_b_assignment_capacity`) precisa disparar antes dos triggers `trg_patient_…` da tabela.
 */
import { Pool } from 'pg';
import { emTransacaoRevertida, novoPool } from './helpers/itinerario058bDb';

describe('058b ordem de disparo dos triggers BEFORE: trg_058_b_ antes de trg_p… @integration', () => {
  let pool: Pool;
  beforeAll(() => { pool = novoPool(); });
  afterAll(async () => { await pool.end(); });

  it('ordem de disparo: a sonda trg_058_b_probe dispara antes de trg_p_probe', async () => {
    const quem = await emTransacaoRevertida(pool, async (c) => {
      await c.query('CREATE TEMP TABLE probe_alvo (id int)');
      await c.query('CREATE TEMP TABLE probe_ordem (n serial, quem text)');
      await c.query(`CREATE FUNCTION pg_temp.fn_probe() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO probe_ordem (quem) VALUES (TG_ARGV[0]); RETURN NEW; END $$`);
      // ordem de CRIAÇÃO: trg_p_probe primeiro, trg_058_b_probe depois; ordem de DISPARO (por nome): ao contrário.
      await c.query(`CREATE TRIGGER trg_p_probe BEFORE INSERT ON probe_alvo FOR EACH ROW EXECUTE FUNCTION pg_temp.fn_probe('trg_p_probe')`);
      await c.query(`CREATE TRIGGER trg_058_b_probe BEFORE INSERT ON probe_alvo FOR EACH ROW EXECUTE FUNCTION pg_temp.fn_probe('trg_058_b_probe')`);
      await c.query('INSERT INTO probe_alvo VALUES (1)');
      return (await c.query<{ quem: string }>('SELECT quem FROM probe_ordem ORDER BY n')).rows.map((r) => r.quem);
    });
    expect(quem).toEqual(['trg_058_b_probe', 'trg_p_probe']);
  });

  it('nomes reais: trg_058_b_assignment_capacity ordena antes de todo BEFORE da tabela', async () => {
    const outros = await pool.query<{ n: number; antes: boolean }>(
      `SELECT count(*)::int AS n, bool_and('trg_058_b_assignment_capacity' COLLATE "C" < tgname COLLATE "C") AS antes
         FROM pg_trigger
        WHERE tgrelid = 'patient_itinerary_assignment'::regclass AND NOT tgisinternal
          AND tgname <> 'trg_058_b_assignment_capacity' AND (tgtype & 2) = 2`);
    expect(outros.rows[0].n).toBeGreaterThanOrEqual(3); // zero seria "não medi"
    expect(outros.rows[0].antes).toBe(true);
    const proprio = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'trg_058_b_assignment_capacity' AND NOT tgisinternal`);
    expect(proprio.rows[0].n).toBe(1);
  });
});
