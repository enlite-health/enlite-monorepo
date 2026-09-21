import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * conversationAttachmentsRlsAppRuntime.e2e.test.ts — spec 022, Bloco 3 (T305-T317, exigência de
 * entrada #2 do contrato: "RLS sob `app_runtime` no caminho de ESCRITA (upload grava
 * `stored_files`)").
 *
 * `stored_files`/`conversation_message_attachments` (migration 460) nasceram no Bloco 1 SEM RLS
 * nenhuma — `country-rls-policies.test.ts` não pegou porque seu invariante só varre FK DIRETA
 * para `patients`, e nenhuma das duas tem (uma aponta para `conversations`, a outra para
 * `conversation_messages`/`stored_files`). A migration 462 fechou isso seguindo o MESMO molde
 * "follow the immediate parent" de `conversation_messages_follow_patient` (459) — este arquivo é
 * a prova sob o papel REAL de runtime (`app_runtime`, nunca o dono `enlite_admin`, que bypassa RLS
 * sempre), molde direto de `conversationRlsAppRuntime.e2e.test.ts` (B1).
 *
 * Nenhum texto clínico real — corpo/nome de arquivo sintéticos.
 */
describe('RLS de ESCRITA sob app_runtime — stored_files/conversation_message_attachments (spec 022, Bloco 3)', () => {
  let pool: Pool; // enlite_admin (dono) — só seed/asserção de estado, nunca prova de comportamento.

  const IDS = {
    patientAR: 'ee461000-b3a0-0001-0001-000000000001',
    patientBR: 'ee461000-b3a0-0001-0002-000000000001',
  };
  const STAFF_AR = 'e022-b3-rls-staff-ar';
  const STAFF_BR = 'e022-b3-rls-staff-br';

  async function cleanup(p: Pool): Promise<void> {
    await p.query(`DELETE FROM patients WHERE id = ANY($1)`, [[IDS.patientAR, IDS.patientBR]]); // CASCADE: conversations → messages → attachments/stored_files
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup(pool);
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-022-b3-rls-ar', 'Paciente', 'B3RlsAr', 'AR', true),
         ($2, 'e2e-022-b3-rls-br', 'Paciente', 'B3RlsBr', 'BR', true)`,
      [IDS.patientAR, IDS.patientBR],
    );
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  /** Molde idêntico a `conversationRlsAppRuntime.e2e.test.ts` — `SET LOCAL ROLE` + `set_config`, ROLLBACK sempre. */
  async function asRole<T>(
    role: 'app_runtime' | 'app_system',
    ctx: { userCountry?: string; userUid?: string; systemContext?: string },
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE ${role}`);
      if (ctx.userCountry) await client.query(`SELECT set_config('app.user_country', $1, true)`, [ctx.userCountry]);
      if (ctx.userUid) await client.query(`SELECT set_config('app.user_uid', $1, true)`, [ctx.userUid]);
      if (ctx.systemContext) await client.query(`SELECT set_config('app.system_context', $1, true)`, [ctx.systemContext]);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  /** Grava conversa → mensagem → stored_files → attachment, sob o client/role JÁ setado. */
  async function writeAttachmentChain(
    client: PoolClient,
    patientId: string,
    authorUid: string,
  ): Promise<{ conversationId: string; messageId: string; fileId: string }> {
    const conv = await client.query<{ id: string }>(`INSERT INTO conversations (patient_id) VALUES ($1) RETURNING id`, [patientId]);
    const conversationId = conv.rows[0].id;

    const msg = await client.query<{ id: string }>(
      `INSERT INTO conversation_messages (conversation_id, author_uid, body_encrypted) VALUES ($1, $2, 'enc:corpo-sintetico') RETURNING id`,
      [conversationId, authorUid],
    );
    const messageId = msg.rows[0].id;

    const file = await client.query<{ id: string }>(
      `INSERT INTO stored_files
         (bucket, object_path_encrypted, original_name_encrypted, content_type, size_bytes, sha256, uploaded_by_uid, conversation_id)
       VALUES ('b3-rls-test-bucket', 'enc:path-sintetico', 'enc:nome-sintetico', 'application/pdf', 10, '\\x00', $1, $2)
       RETURNING id`,
      [authorUid, conversationId],
    );
    const fileId = file.rows[0].id;

    await client.query(`INSERT INTO conversation_message_attachments (message_id, file_id) VALUES ($1, $2)`, [messageId, fileId]);

    return { conversationId, messageId, fileId };
  }

  it('0. sanidade do seed: harness (dono) vê os 2 pacientes de teste (AR + BR)', async () => {
    const res = await pool.query(`SELECT id, country FROM patients WHERE id = ANY($1) ORDER BY country`, [
      [IDS.patientAR, IDS.patientBR],
    ]);
    expect(res.rows.map((r) => r.country)).toEqual(['AR', 'BR']);
  });

  it('1. ESCRITA sob app_runtime (nunca enlite_admin/dono) em stored_files + conversation_message_attachments — sucesso; SELECT current_user confirma o papel', async () => {
    const { currentUser, chain } = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_AR }, async (client) => {
      const cu = await client.query<{ current_user: string }>('SELECT current_user');
      const chainResult = await writeAttachmentChain(client, IDS.patientAR, STAFF_AR);
      return { currentUser: cu.rows[0].current_user, chain: chainResult };
    });

    expect(currentUser).toBe('app_runtime');
    expect(chain.fileId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('2. ESCRITA sob app_runtime PERSISTIDA (COMMIT real) — stored_files/attachments ficam gravados de verdade', async () => {
    const client = await pool.connect();
    let chain: { conversationId: string; messageId: string; fileId: string };
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_runtime');
      await client.query(`SELECT set_config('app.user_country', $1, true)`, ['AR']);
      await client.query(`SELECT set_config('app.user_uid', $1, true)`, [STAFF_AR]);
      chain = await writeAttachmentChain(client, IDS.patientAR, STAFF_AR);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const direto = await pool.query(`SELECT id FROM stored_files WHERE id = $1`, [chain.fileId]);
    expect(direto.rows).toHaveLength(1);
    const attachDireto = await pool.query(`SELECT 1 FROM conversation_message_attachments WHERE file_id = $1`, [chain.fileId]);
    expect(attachDireto.rows).toHaveLength(1);

    await pool.query(`DELETE FROM conversations WHERE id = $1`, [chain.conversationId]); // CASCADE limpa messages/attachments; stored_files fica órfão de propósito abaixo
    await pool.query(`DELETE FROM stored_files WHERE id = $1`, [chain.fileId]);
  });

  it('3. ISOLAMENTO cross-país por CONTAGEM (nunca só ausência de erro) — ator AR não LÊ stored_files/attachments do BR, mesmo com AMBOS existindo', async () => {
    async function seedPersisted(country: 'AR' | 'BR', patientId: string, authorUid: string) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE app_system');
        await client.query(`SELECT set_config('app.system_context', $1, true)`, ['job:e2e-b3-rls-seed']);
        const chain = await writeAttachmentChain(client, patientId, authorUid);
        await client.query('COMMIT');
        return chain;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    const ar = await seedPersisted('AR', IDS.patientAR, STAFF_AR);
    const br = await seedPersisted('BR', IDS.patientBR, STAFF_BR);

    try {
      const counts = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_AR }, async (client) => {
        const files = await client.query(`SELECT id FROM stored_files WHERE id = ANY($1)`, [[ar.fileId, br.fileId]]);
        const attachments = await client.query(`SELECT file_id FROM conversation_message_attachments WHERE file_id = ANY($1)`, [
          [ar.fileId, br.fileId],
        ]);
        return { files: files.rows.length, attachments: attachments.rows.length };
      });

      expect(counts).toEqual({ files: 1, attachments: 1 });

      const controleDono = await pool.query(`SELECT id FROM stored_files WHERE id = ANY($1)`, [[ar.fileId, br.fileId]]);
      expect(controleDono.rows).toHaveLength(2); // as DUAS existem — "1" acima é a policy, não um seed manco
    } finally {
      for (const chain of [ar, br]) {
        await pool.query(`DELETE FROM conversations WHERE id = $1`, [chain.conversationId]);
        await pool.query(`DELETE FROM stored_files WHERE id = $1`, [chain.fileId]);
      }
    }
  });

  it('4. ISOLAMENTO de ESCRITA — ator AR NÃO insere stored_files apontando para conversa BR alheia (WITH CHECK via EXISTS em conversations)', async () => {
    const client = await pool.connect();
    let conversationIdBR: string;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_system');
      await client.query(`SELECT set_config('app.system_context', $1, true)`, ['job:e2e-b3-rls-seed']);
      const conv = await client.query<{ id: string }>(`INSERT INTO conversations (patient_id) VALUES ($1) RETURNING id`, [IDS.patientBR]);
      conversationIdBR = conv.rows[0].id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    try {
      await expect(
        asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_AR }, (c) =>
          c.query(
            `INSERT INTO stored_files (bucket, object_path_encrypted, original_name_encrypted, content_type, size_bytes, sha256, uploaded_by_uid, conversation_id)
             VALUES ('ataque', 'enc:x', 'enc:x', 'application/pdf', 10, '\\x00', $1, $2)`,
            [STAFF_AR, conversationIdBR],
          ),
        ),
      ).rejects.toThrow(/row-level security/);

      const depois = await pool.query(`SELECT COUNT(*)::int AS n FROM stored_files WHERE conversation_id = $1`, [conversationIdBR]);
      expect(depois.rows[0].n).toBe(0);
    } finally {
      await pool.query(`DELETE FROM conversations WHERE id = $1`, [conversationIdBR]);
    }
  });

  it('5. ISOLAMENTO de ESCRITA — ator AR NÃO anexa (conversation_message_attachments) um arquivo a uma mensagem BR alheia', async () => {
    const client = await pool.connect();
    let messageIdBR: string;
    let fileIdBR: string;
    let conversationIdBR: string;
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_system');
      await client.query(`SELECT set_config('app.system_context', $1, true)`, ['job:e2e-b3-rls-seed']);
      const chain = await writeAttachmentChain(client, IDS.patientBR, STAFF_BR);
      conversationIdBR = chain.conversationId;
      messageIdBR = chain.messageId;
      // 2º arquivo, ainda não anexado — o ator AR vai tentar anexá-lo à mensagem BR.
      const file2 = await client.query<{ id: string }>(
        `INSERT INTO stored_files (bucket, object_path_encrypted, original_name_encrypted, content_type, size_bytes, sha256, uploaded_by_uid, conversation_id)
         VALUES ('b3-rls-test-bucket', 'enc:path2', 'enc:nome2', 'application/pdf', 10, '\\x00', $1, $2) RETURNING id`,
        [STAFF_BR, conversationIdBR],
      );
      fileIdBR = file2.rows[0].id;
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    try {
      await expect(
        asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_AR }, (c) =>
          c.query(`INSERT INTO conversation_message_attachments (message_id, file_id) VALUES ($1, $2)`, [messageIdBR, fileIdBR]),
        ),
      ).rejects.toThrow(/row-level security/);

      const depois = await pool.query(`SELECT COUNT(*)::int AS n FROM conversation_message_attachments WHERE file_id = $1`, [fileIdBR]);
      expect(depois.rows[0].n).toBe(0);
    } finally {
      await pool.query(`DELETE FROM conversations WHERE id = $1`, [conversationIdBR]);
    }
  });
});
