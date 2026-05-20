/**
 * Acesso a message_templates: leitura e aplicação do plano de sync.
 */
import { Pool } from 'pg';
import { InsertPlan, SyncPlan, UpdatePlan } from './diff-engine';

export interface DbTemplateRow {
  id: string;
  slug: string;
  name: string;
  body: string;
  category: string | null;
  is_active: boolean;
  content_sid: string | null;
}

export async function fetchDbTemplates(pool: Pool): Promise<DbTemplateRow[]> {
  const res = await pool.query<DbTemplateRow>(
    `SELECT id, slug, name, body, category, is_active, content_sid FROM message_templates`,
  );
  return res.rows;
}

export async function applyPlan(pool: Pool, plan: SyncPlan): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const ins of plan.inserts) await applyInsert(client, ins);
    for (const upd of plan.updates) await applyUpdate(client, upd);
    for (const del of plan.deletes) {
      await client.query(`DELETE FROM message_templates WHERE id = $1`, [del.id]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function applyInsert(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  ins: InsertPlan,
): Promise<void> {
  await client.query(
    `INSERT INTO message_templates (slug, name, body, category, is_active, content_sid)
     VALUES ($1, $2, $3, $4, true, $5)
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       body = EXCLUDED.body,
       category = EXCLUDED.category,
       is_active = true,
       content_sid = EXCLUDED.content_sid,
       updated_at = NOW()`,
    [ins.slug, ins.name, ins.body, ins.category, ins.contentSid],
  );
}

async function applyUpdate(
  client: { query: (sql: string, params: unknown[]) => Promise<unknown> },
  upd: UpdatePlan,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(upd.fields)) {
    sets.push(`${k} = $${i++}`);
    values.push(v);
  }
  if (sets.length === 0) return;
  sets.push(`updated_at = NOW()`);
  values.push(upd.id);
  await client.query(
    `UPDATE message_templates SET ${sets.join(', ')} WHERE id = $${i}`,
    values,
  );
}
