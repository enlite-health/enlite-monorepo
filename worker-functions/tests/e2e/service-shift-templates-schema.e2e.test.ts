/**
 * Spec 074 (guardias predefinidas) — trava de BANCO da migration 550. Sem app, sem HTTP.
 * Prova: sementes da FR-01, idempotência, sobreposição no dia circular (D560), índice de rótulo
 * entre ativos, `code` imutável, CHECK de duração e a célula ABAC só no Acesso Master.
 * Dados do teste: guardias com rótulo `QA 074 …`; as sementes nunca são apagadas.
 */
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const GROUP_MASTER = 'a0000000-0000-0000-0000-000000000001';
const PREFIXO = 'QA 074 ';

interface PgErr { code?: string; message: string; constraint?: string }
async function erroDe(fn: () => Promise<unknown>): Promise<PgErr | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as PgErr;
  }
}

describe('spec 074 — catálogo de guardias predefinidas (migration 550): banco', () => {
  let pool: Pool;

  async function limpar(): Promise<void> {
    await pool.query(
      `DELETE FROM service_shift_template_items WHERE template_id IN (SELECT id FROM service_shift_templates WHERE label LIKE $1)`,
      [`${PREFIXO}%`],
    );
    await pool.query(`DELETE FROM service_shift_templates WHERE label LIKE $1`, [`${PREFIXO}%`]);
  }

  async function novaGuardia(label: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO service_shift_templates (label) VALUES ($1) RETURNING id`, [label]);
    return r.rows[0].id;
  }

  const addItem = (id: string, start: string, dur: number) =>
    pool.query(
      `INSERT INTO service_shift_template_items (template_id, start_time, duration_minutes) VALUES ($1, $2::time, $3)`,
      [id, start, dur]);

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('B1 sementes: 2 guardias com os itens da FR-01', async () => {
    const itens = async (code: string) => (await pool.query<{ s: string; d: number }>(
      `SELECT to_char(i.start_time, 'HH24:MI') AS s, i.duration_minutes AS d
         FROM service_shift_template_items i JOIN service_shift_templates t ON t.id = i.template_id
        WHERE t.code = $1 ORDER BY i.start_time`, [code])).rows;
    const a = await itens('GUARDIAS_8_14_20');
    expect(a.map((r) => r.d)).toEqual([360, 360, 720]);
    expect(a.map((r) => r.s)).toEqual(['08:00', '14:00', '20:00']);
    const b = await itens('GUARDIA_24H');
    expect(b.map((r) => r.d)).toEqual([1440]);
  });

  it('B2 reaplicar a 550 não duplica', async () => {
    const sql = fs.readFileSync(path.join(__dirname, '../../migrations/550_074_service_shift_templates.sql'), 'utf8');
    await pool.query(sql);
    const g = await pool.query(
      `SELECT count(*)::int AS n FROM service_shift_templates WHERE code IN ('GUARDIAS_8_14_20','GUARDIA_24H')`);
    expect(g.rows[0].n).toBe(2);
    const it = await pool.query(
      `SELECT count(*)::int AS n FROM service_shift_template_items i JOIN service_shift_templates t ON t.id = i.template_id
        WHERE t.code IN ('GUARDIAS_8_14_20','GUARDIA_24H')`);
    expect(it.rows[0].n).toBe(4);
    const p = await pool.query(
      `SELECT count(*)::int AS n FROM iam.permissions WHERE resource = 'catalog_service_shift_templates'`);
    expect(p.rows[0].n).toBe(3);
  });

  it('B3 06:00 por 120 na guardia de 3 itens viola ssti_sem_sobreposicao', async () => {
    const id = await novaGuardia(`${PREFIXO}tres`);
    await addItem(id, '08:00', 360);
    await addItem(id, '14:00', 360);
    await addItem(id, '20:00', 720);
    const e = await erroDe(() => addItem(id, '06:00', 120));
    expect(e?.code).toBe('23P01');
    expect(e?.constraint).toBe('ssti_sem_sobreposicao');
  });

  it('B4 20:00 por 720 e 06:00 por 120 na mesma guardia violam (dia circular)', async () => {
    const id = await novaGuardia(`${PREFIXO}circular`);
    await addItem(id, '20:00', 720);
    const e = await erroDe(() => addItem(id, '06:00', 120));
    expect(e?.code).toBe('23P01');
  });

  it('B5 08:00 por 720 e 20:00 por 720 encostam e passam', async () => {
    const id = await novaGuardia(`${PREFIXO}encosta`);
    await addItem(id, '08:00', 720);
    await addItem(id, '20:00', 720);
    const r = await pool.query(`SELECT count(*)::int AS n FROM service_shift_template_items WHERE template_id = $1`, [id]);
    expect(r.rows[0].n).toBe(2);
  });

  it('B6 rótulo igual a ativo com caixa e espaço diferentes viola o índice único; igual a inativo passa', async () => {
    await novaGuardia(`${PREFIXO}Dup`);
    const e = await erroDe(() => novaGuardia(`  ${PREFIXO.toLowerCase()}dup `));
    expect(e?.code).toBe('23505');
    await pool.query(
      `INSERT INTO service_shift_templates (label, active, deactivated_at) VALUES ($1, false, now())`,
      [`${PREFIXO}Inativa`]);
    const ok = await erroDe(() => novaGuardia(`${PREFIXO}Inativa`));
    expect(ok).toBeNull();
  });

  it('B7 code é imutável', async () => {
    const id = await novaGuardia(`${PREFIXO}codigo`);
    const r = await pool.query<{ code: string }>(`SELECT code FROM service_shift_templates WHERE id = $1`, [id]);
    expect(r.rows[0].code).toBe(id);
    await expect(
      pool.query(`UPDATE service_shift_templates SET code = 'OUTRO' WHERE id = $1`, [id]),
    ).rejects.toThrow(/imut[aá]vel/i);
  });

  it('B8 duração 0 e 1441 violam o CHECK', async () => {
    const id = await novaGuardia(`${PREFIXO}duracao`);
    expect((await erroDe(() => addItem(id, '08:00', 0)))?.code).toBe('23514');
    expect((await erroDe(() => addItem(id, '08:00', 1441)))?.code).toBe('23514');
  });

  it('B9 célula catalog_service_shift_templates tem read/create/update e o Acesso Master as recebe', async () => {
    const cells = await pool.query<{ action: string }>(
      `SELECT action FROM iam.permissions WHERE resource = 'catalog_service_shift_templates' ORDER BY action`);
    expect(cells.rows.map((r) => r.action)).toEqual(['create', 'read', 'update']);
    const grants = await pool.query<{ group_id: string; n: number }>(
      `SELECT gp.group_id, count(*)::int AS n FROM iam.group_permissions gp
         JOIN iam.permissions p ON p.id = gp.permission_id
        WHERE p.resource = 'catalog_service_shift_templates' GROUP BY gp.group_id`);
    expect(grants.rows.map((r) => r.group_id)).toContain(GROUP_MASTER);
    expect(grants.rows.find((r) => r.group_id === GROUP_MASTER)?.n).toBe(3);
  });
});
