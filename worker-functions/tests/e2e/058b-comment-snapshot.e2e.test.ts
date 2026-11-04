/**
 * 058b-comment-snapshot.e2e.test.ts @integration — spec 058 T217: `patient_contracted_services.authorized_hours` fica marcada como
 * snapshot legado (dono novo = contracted_service_authorization) pela migration 545, e a 545 é idempotente (não prefixa duas vezes).
 */
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { emTransacaoRevertida, novoPool } from './helpers/itinerario058bDb';

describe('058b COMMENT de snapshot em authorized_hours @integration', () => {
  let pool: Pool;
  beforeAll(() => { pool = novoPool(); });
  afterAll(async () => { await pool.end(); });

  const COMENTARIO = `SELECT col_description('patient_contracted_services'::regclass,
    (SELECT attnum FROM pg_attribute WHERE attrelid = 'patient_contracted_services'::regclass AND attname = 'authorized_hours')) AS c`;

  it('COMMENT de snapshot: authorized_hours leva snapshot e Spec 058', async () => {
    const c = (await pool.query<{ c: string | null }>(COMENTARIO)).rows[0].c;
    expect(c).toContain('snapshot');
    expect(c).toContain('Spec 058');
    expect(c).toContain('contracted_service_authorization');
  });

  it('COMMENT de snapshot: idempotente 2× (não prefixa duas vezes)', async () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../migrations/545_058b_comment_snapshot_authorized_hours.sql'), 'utf8');
    const c = await emTransacaoRevertida(pool, async (cli) => {
      await cli.query(sql);
      await cli.query(sql);
      return (await cli.query<{ c: string | null }>(COMENTARIO)).rows[0].c ?? '';
    });
    expect((c.match(/snapshot legado/g) ?? []).length).toBe(1);
  });
});
