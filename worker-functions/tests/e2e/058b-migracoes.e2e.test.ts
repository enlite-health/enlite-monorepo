/**
 * 058b-migracoes.e2e.test.ts @integration — spec 058 T211–T217 (suporte): as migrations 541–545 são idempotentes (2×), não abrem
 * transação própria (o runner abre 1 por arquivo) e cada uma tem um ROLLBACK que desfaz na ordem inversa e é idempotente.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { emTransacaoRevertida, novoPool } from './helpers/itinerario058bDb';

const ARQS = [
  '541_fn_operation_date',
  '542_itinerary_slot_occupancy',
  '543_058b_trava_a_capacidade_da_faixa',
  '544_058b_trava_b_providers_needed',
  '545_058b_comment_snapshot_authorized_hours',
];
const lerM = (n: string): string => fs.readFileSync(path.join(__dirname, '../../migrations', n + '.sql'), 'utf8');
const lerR = (n: string): string => fs.readFileSync(path.join(__dirname, '../../migrations/pending', 'ROLLBACK_' + n + '.sql'), 'utf8');

describe('058b migrações 541–545 @integration', () => {
  let pool: Pool;
  beforeAll(() => { pool = novoPool(); });
  afterAll(async () => { await pool.end(); });

  it('migrações 541–545: sem BEGIN/COMMIT e com par ROLLBACK', () => {
    expect(ARQS.length).toBe(5); // contagem ≠ 0
    for (const n of ARQS) {
      // transação de statement ("BEGIN;" / "COMMIT;"); o BEGIN de bloco PL/pgSQL (sem ponto e vírgula) é legítimo.
      expect(lerM(n)).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
      expect(fs.existsSync(path.join(__dirname, '../../migrations/pending', 'ROLLBACK_' + n + '.sql'))).toBe(true);
    }
  });

  it('migrações 541–545: idempotentes 2×', async () => {
    await emTransacaoRevertida(pool, async (c) => {
      for (let vez = 0; vez < 2; vez++) for (const n of ARQS) await c.query(lerM(n));
    });
  });

  it('migrações 541–545: rollback na ordem inversa e reaplicação', async () => {
    await emTransacaoRevertida(pool, async (c) => {
      const estado = async (): Promise<{ fn: string | null; trg: number; com: string | null }> => ({
        fn: (await c.query<{ r: string | null }>(`SELECT to_regprocedure('fn_operation_date(text,timestamptz)')::text AS r`)).rows[0].r,
        trg: (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'trg_058_b_%' AND NOT tgisinternal`)).rows[0].n,
        com: (await c.query<{ c: string | null }>(`SELECT col_description('patient_contracted_services'::regclass,
              (SELECT attnum FROM pg_attribute WHERE attrelid = 'patient_contracted_services'::regclass AND attname = 'authorized_hours')) AS c`)).rows[0].c,
      });
      for (const n of [...ARQS].reverse()) await c.query(lerR(n));
      const depois = await estado();
      expect(depois.fn).toBeNull();
      expect(depois.trg).toBe(0);
      expect(depois.com ?? '').not.toContain('snapshot legado');
      for (const n of ARQS) await c.query(lerM(n));
      const volta = await estado();
      expect(volta.fn).not.toBeNull();
      expect(volta.trg).toBe(2);
      expect(volta.com).toContain('snapshot legado');
    });
  });

  it('migrações 541–545: rollback é idempotente', async () => {
    await emTransacaoRevertida(pool, async (c) => {
      for (let vez = 0; vez < 2; vez++) for (const n of [...ARQS].reverse()) await c.query(lerR(n));
    });
  });
});
