/**
 * patientDocumentsRlsAppRuntime.e2e.test.ts — spec 031, F1 (rodada 2): RLS de `patient_documents` provada
 * sob o papel REAL de runtime (`app_runtime`, nunca a dona `enlite_admin`, que bypassa RLS). Molde:
 * `conversation/conversationAttachmentsRlsAppRuntime.e2e.test.ts` (`SET LOCAL ROLE` + `set_config`, ROLLBACK).
 *
 * O harness HTTP (`documentsE2eHelpers`) conecta como a DONA (`DATABASE_URL`), então o "404 de outro país"
 * por HTTP não prova RLS — a prova é no nível SQL, aqui. Texto sintético.
 */
import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const STAFF = 'e031-rls-staff-ar';
const IDS = {
  ar: 'ee031000-c001-4000-8000-000000000001',
  br: 'ee031000-c002-4000-8000-000000000001',
};

describe('RLS sob app_runtime — patient_documents (spec 031)', () => {
  let pool: Pool; // dona: só seed e asserção de estado
  const doc: Record<string, { tab: string; chat: string; conv: string; msg: string; file: string }> = {};

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [[IDS.ar, IDS.br]]); // CASCADE leva conversa, arquivos e documentos
  }

  async function asRuntime<T>(ctx: { country?: string; uid?: string }, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      if (ctx.country) await client.query(`SELECT set_config('app.user_country', $1, true)`, [ctx.country]);
      if (ctx.uid) await client.query(`SELECT set_config('app.user_uid', $1, true)`, [ctx.uid]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  const TAB_INSERT = `INSERT INTO patient_documents (patient_id, origin, label_encrypted, file_path_encrypted, original_name_encrypted, content_type, size_bytes, sha256, created_by_uid)
                      VALUES ($1, 'tab', 'enc:novo', 'enc:p', 'enc:n', 'application/pdf', 10, '\\x00', $2) RETURNING id`;
  const CHAT_INSERT = `INSERT INTO patient_documents (patient_id, origin, label_encrypted, stored_file_id, source_message_id, created_by_uid, created_at)
                       SELECT c.patient_id, 'chat', sf.original_name_encrypted, sf.id, m.id, $4, m.created_at
                         FROM stored_files sf JOIN conversations c ON c.id = $1 JOIN conversation_messages m ON m.id = $2 AND m.conversation_id = c.id
                        WHERE sf.id = $3`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup();
    for (const [k, id] of Object.entries(IDS)) {
      const country = k.toUpperCase();
      await pool.query(`INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES ($1, $2, 'Paciente', $3, $4, true)`, [id, `e2e-031-rls-${k}`, `Rls ${country}`, country]);
      const conv = (await pool.query(`INSERT INTO conversations (patient_id) VALUES ($1) RETURNING id`, [id])).rows[0].id;
      const msg = (await pool.query(`INSERT INTO conversation_messages (conversation_id, author_uid, body_encrypted) VALUES ($1, $2, 'enc:corpo') RETURNING id`, [conv, STAFF])).rows[0].id;
      const file = (await pool.query(
        `INSERT INTO stored_files (bucket, object_path_encrypted, original_name_encrypted, content_type, size_bytes, sha256, uploaded_by_uid, conversation_id)
         VALUES ('b', 'enc:p', 'enc:chat.pdf', 'application/pdf', 10, '\\x00', $1, $2) RETURNING id`, [STAFF, conv])).rows[0].id;
      const tab = (await pool.query(TAB_INSERT, [id, STAFF])).rows[0].id;
      await pool.query(CHAT_INSERT, [conv, msg, file, STAFF]);
      const chat = (await pool.query(`SELECT id FROM patient_documents WHERE stored_file_id = $1`, [file])).rows[0].id;
      doc[k] = { tab, chat, conv, msg, file };
    }
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it('0. sanidade: a dona vê os 4 documentos semeados (2 por país) — o zero abaixo não é banco vazio', async () => {
    const { rows } = await pool.query(`SELECT country, origin FROM patient_documents WHERE patient_id = ANY($1) ORDER BY country, origin`, [[IDS.ar, IDS.br]]);
    expect(rows).toEqual([
      { country: 'AR', origin: 'chat' }, { country: 'AR', origin: 'tab' },
      { country: 'BR', origin: 'chat' }, { country: 'BR', origin: 'tab' },
    ]);
  });

  it('1. identidade AR: SELECT/UPDATE/DELETE em documento de paciente BR = 0 linhas (tab e chat) — e o estado da dona não muda', async () => {
    const out = await asRuntime({ country: 'AR', uid: STAFF }, async (c) => {
      const role = (await c.query('SELECT current_user')).rows[0].current_user;
      const sel = await c.query(`SELECT id FROM patient_documents WHERE patient_id = $1`, [IDS.br]);
      const selById = await c.query(`SELECT id FROM patient_documents WHERE id = ANY($1)`, [[doc.br.tab, doc.br.chat]]);
      const upd = await c.query(`UPDATE patient_documents SET label_encrypted = 'enc:invasor' WHERE id = ANY($1)`, [[doc.br.tab, doc.br.chat]]);
      const del = await c.query(`DELETE FROM patient_documents WHERE id = ANY($1)`, [[doc.br.tab, doc.br.chat]]);
      return { role, sel: sel.rowCount, selById: selById.rowCount, upd: upd.rowCount, del: del.rowCount };
    });
    expect(out).toEqual({ role: 'app_runtime', sel: 0, selById: 0, upd: 0, del: 0 });
    const intact = await pool.query(`SELECT label_encrypted FROM patient_documents WHERE id = ANY($1)`, [[doc.br.tab, doc.br.chat]]);
    expect(intact.rowCount).toBe(2);
    expect(intact.rows.map((r) => r.label_encrypted)).not.toContain('enc:invasor');
  });

  it('2. identidade AR: INSERT para paciente BR é recusado (tab e chat) — nada gravado', async () => {
    await expect(asRuntime({ country: 'AR', uid: STAFF }, (c) => c.query(TAB_INSERT, [IDS.br, STAFF]))).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23502)$/) });
    // chat: o INSERT ... SELECT não enxerga a conversa/mensagem do BR → 0 linhas criadas (o use case trata ≠ nº de arquivos como erro)
    const created = await asRuntime({ country: 'AR', uid: STAFF }, (c) => c.query(CHAT_INSERT, [doc.br.conv, doc.br.msg, doc.br.file, STAFF]));
    expect(created.rowCount).toBe(0);
    const n = await pool.query(`SELECT count(*)::int AS n FROM patient_documents WHERE patient_id = $1`, [IDS.br]);
    expect(n.rows[0].n).toBe(2); // só os 2 do seed
  });

  it('3. controle positivo — identidade AR no paciente AR: vê, atualiza, insere (tab e chat) e exclui', async () => {
    const out = await asRuntime({ country: 'AR', uid: STAFF }, async (c) => {
      const sel = await c.query(`SELECT origin FROM patient_documents WHERE patient_id = $1 ORDER BY origin`, [IDS.ar]);
      const upd = await c.query(`UPDATE patient_documents SET label_encrypted = 'enc:ok' WHERE id = $1`, [doc.ar.tab]);
      const insTab = await c.query(TAB_INSERT, [IDS.ar, STAFF]);
      await c.query(`DELETE FROM patient_documents WHERE id = $1`, [doc.ar.chat]); // abre a UNIQUE do arquivo
      const insChat = await c.query(CHAT_INSERT, [doc.ar.conv, doc.ar.msg, doc.ar.file, STAFF]);
      const del = await c.query(`DELETE FROM patient_documents WHERE id = $1`, [doc.ar.tab]);
      return { sel: sel.rows.map((r) => r.origin), upd: upd.rowCount, insTab: insTab.rowCount, insChat: insChat.rowCount, del: del.rowCount };
    });
    expect(out).toEqual({ sel: ['chat', 'tab'], upd: 1, insTab: 1, insChat: 1, del: 1 });
  });

  it('4. sem identidade de sessão (sem set_config / sem withActorContext) = ERRO NOMEADO rls_session_without_identity — SELECT, INSERT tab e INSERT de origem chat', async () => {
    await expect(asRuntime({}, (c) => c.query(`SELECT id FROM patient_documents WHERE patient_id = $1`, [IDS.ar]))).rejects.toThrow(/rls_session_without_identity/);
    await expect(asRuntime({}, (c) => c.query(TAB_INSERT, [IDS.ar, STAFF]))).rejects.toThrow(/rls_session_without_identity/);
    await expect(asRuntime({}, (c) => c.query(CHAT_INSERT, [doc.ar.conv, doc.ar.msg, doc.ar.file, STAFF]))).rejects.toThrow(/rls_session_without_identity/);
  });
});
