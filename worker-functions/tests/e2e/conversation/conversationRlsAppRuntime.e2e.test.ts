import { Pool, PoolClient } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

/**
 * conversationRlsAppRuntime.e2e.test.ts — spec 022, Bloco 1 (achado ALTO do gate revisao-pr,
 * 2ª rodada, evidencias/b1-gate-parcial-2.md).
 *
 * O PROBLEMA que este arquivo existe pra fechar: as 6 tabelas novas desta spec (`conversations`,
 * `conversation_messages`, `conversation_message_mentions`, `conversation_read_marks`,
 * `notification_events`, `notifications`) ligaram RLS (migrations 457/458/460), mas todo e2e do
 * módulo até aqui (`adminConversation.e2e.test.ts`, `conversationAbacMatrix.e2e.test.ts`) conecta
 * como `enlite_admin` — o DONO das tabelas. Dono bypassa RLS SEMPRE quando a tabela não tem FORCE
 * (nenhuma tem, `country-rls-policies.test.ts` prova a invariante "NENHUMA tabela da leva tem
 * FORCE" — decisão deliberada: FORCE quebraria migrations/seed rodados como dono). Os 14/14 verdes
 * anteriores não provam NADA sobre o comportamento sob `app_runtime` — o papel real de runtime da
 * aplicação em produção. Dois desfechos possíveis e os dois invisíveis sem este teste: policy
 * estrita demais → INSERT falha e o chat quebra no deploy; policy frouxa → não isola nada.
 *
 * Molde: `tests/e2e/country-rls-policies.test.ts` (`asRole` — `SET LOCAL ROLE` + `set_config(...,
 * true)` dentro de uma transação, ROLLBACK no fim; é o contrato real de `withActorContext`,
 * `@shared/database/actorContext.ts`). A ÚNICA prova anterior de app_runtime real nestas 6 tabelas
 * (`evidencias/b1-fecho-classe.md` §4b) cobria só SELECT, só nas 3 tabelas-filha sem FK direta
 * para `patients`. Este arquivo cobre ESCRITA nas 6, com seed AR+BR (nunca tabela vazia — contagem
 * zero é falha, não sucesso).
 *
 * Nenhum texto clínico real em fixture/asserção — corpo sintético (`ilike '%test%'`-safe,
 * "corpo-sintetico-XX").
 */
describe('RLS de ESCRITA sob app_runtime — 6 tabelas novas da spec 022 (achado ALTO do gate revisao-pr, Bloco 1)', () => {
  let pool: Pool; // conectado como enlite_admin (dono) — só para seed/asserção de estado, nunca para provar comportamento.

  const IDS = {
    patientAR: 'ee457000-b1a0-0001-0001-000000000001',
    patientBR: 'ee457000-b1a0-0001-0002-000000000001',
  };
  const STAFF_AR = 'e022-rls-staff-ar';
  const STAFF_BR = 'e022-rls-staff-br';

  async function cleanup(p: Pool): Promise<void> {
    // Ordem FK-segura; delete de 0 linhas não é erro — falha aqui deve APARECER.
    // `notifications`/`notification_events` são filhas de `patients` via `conversations`/direta —
    // apagar os pacientes CASCATEIA (conversations.patient_id ON DELETE CASCADE →
    // conversation_messages ON DELETE CASCADE → mentions/attachments; notification_events.patient_id
    // ON DELETE SET NULL, então apagamos explicitamente antes para não deixar órfã).
    await p.query(
      `DELETE FROM notifications WHERE event_id IN (
         SELECT id FROM notification_events WHERE patient_id = ANY($1)
       )`,
      [[IDS.patientAR, IDS.patientBR]],
    );
    await p.query(`DELETE FROM notification_events WHERE patient_id = ANY($1)`, [[IDS.patientAR, IDS.patientBR]]);
    await p.query(`DELETE FROM patients WHERE id = ANY($1)`, [[IDS.patientAR, IDS.patientBR]]); // CASCADE leva conversations/messages/mentions/read_marks
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup(pool);
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-022-rls-ar', 'Paciente', 'RlsAr', 'AR', true),
         ($2, 'e2e-022-rls-br', 'Paciente', 'RlsBr', 'BR', true)`,
      [IDS.patientAR, IDS.patientBR],
    );
  });

  afterAll(async () => {
    await cleanup(pool);
    await pool.end();
  });

  /**
   * Roda `fn` numa transação como a role dada com o contexto dado, e desfaz tudo (ROLLBACK) —
   * espelha o contrato de `withActorContext`/`requestDbSession` (SET LOCAL, nunca SET solto que
   * sobreviveria fora da transação e contaminaria a próxima query do pool).
   */
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

  /** Grava a cadeia completa das 6 tabelas para `patientId`, sob o client/role JÁ setado por `asRole`. */
  async function writeFullChain(
    client: PoolClient,
    patientId: string,
    authorUid: string,
    mentionedUid: string,
  ): Promise<{
    conversationId: string;
    messageId: string;
    eventId: string;
    notificationId: string;
  }> {
    const conv = await client.query<{ id: string }>(
      `INSERT INTO conversations (patient_id) VALUES ($1) RETURNING id`,
      [patientId],
    );
    const conversationId = conv.rows[0].id;

    const msg = await client.query<{ id: string }>(
      `INSERT INTO conversation_messages (conversation_id, author_uid, body_encrypted)
       VALUES ($1, $2, 'enc:corpo-sintetico-01') RETURNING id`,
      [conversationId, authorUid],
    );
    const messageId = msg.rows[0].id;

    await client.query(
      `INSERT INTO conversation_message_mentions (message_id, mentioned_uid) VALUES ($1, $2)`,
      [messageId, mentionedUid],
    );

    await client.query(
      `INSERT INTO conversation_read_marks (conversation_id, user_uid, last_read_at) VALUES ($1, $2, now())`,
      [conversationId, authorUid],
    );

    const event = await client.query<{ id: string }>(
      `INSERT INTO notification_events (type_code, actor_uid, patient_id, conversation_id, message_id, payload)
       VALUES ('CONVERSATION_MENTIONED', $1, $2, $3, $4, '{}'::jsonb) RETURNING id`,
      [authorUid, patientId, conversationId, messageId],
    );
    const eventId = event.rows[0].id;

    const notification = await client.query<{ id: string }>(
      `INSERT INTO notifications (event_id, recipient_uid) VALUES ($1, $2) RETURNING id`,
      [eventId, mentionedUid],
    );

    return { conversationId, messageId, eventId, notificationId: notification.rows[0].id };
  }

  it('0. sanidade do seed: harness (superuser/dono) vê os 2 pacientes de teste (AR + BR)', async () => {
    const res = await pool.query(`SELECT id, country FROM patients WHERE id = ANY($1) ORDER BY country`, [
      [IDS.patientAR, IDS.patientBR],
    ]);
    expect(res.rows.map((r) => r.country)).toEqual(['AR', 'BR']);
  });

  it('1. ESCRITA sob app_runtime (nunca enlite_admin/dono) nas 6 tabelas, para o país do ator (AR) — sucesso; SELECT current_user confirma o papel real', async () => {
    const { currentUser, chain } = await asRole(
      'app_runtime',
      { userCountry: 'AR', userUid: STAFF_AR },
      async (client) => {
        const cu = await client.query<{ current_user: string }>('SELECT current_user');
        const chainResult = await writeFullChain(client, IDS.patientAR, STAFF_AR, STAFF_BR);
        return { currentUser: cu.rows[0].current_user, chain: chainResult };
      },
    );

    // ⚠️ Obrigatório (contrato da Tarefa 1): sem isto não há como saber sob qual papel a
    // transação rodou — o teste inteiro viraria autoengano do MESMO tipo que ele existe pra caçar.
    expect(currentUser).toBe('app_runtime');

    // As 6 tabelas aceitaram a escrita — nenhuma delas derrubou o INSERT com erro de RLS.
    expect(chain.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(chain.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(chain.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(chain.notificationId).toMatch(/^[0-9a-f-]{36}$/);

    // Prova indireta (fora da transação, que fez ROLLBACK): o `asRole` desfaz tudo de propósito —
    // um segundo `asRole` idêntico abaixo confirma que a escrita não deixou resíduo (a mesma
    // transação pode repetir a cadeia sem colidir em `UNIQUE(patient_id)` de `conversations`).
    const repetiu = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_AR }, (client) =>
      writeFullChain(client, IDS.patientAR, STAFF_AR, STAFF_BR),
    );
    expect(repetiu.conversationId).not.toBe(chain.conversationId); // rodou de novo do zero — o ROLLBACK anterior realmente desfez
  });

  it('2. ESCRITA sob app_runtime PERSISTIDA (COMMIT real, não ROLLBACK) — as 6 tabelas ficam gravadas de verdade', async () => {
    const client = await pool.connect();
    let chain: { conversationId: string; messageId: string; eventId: string; notificationId: string };
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE app_runtime`);
      await client.query(`SELECT set_config('app.user_country', $1, true)`, ['AR']);
      await client.query(`SELECT set_config('app.user_uid', $1, true)`, [STAFF_AR]);
      chain = await writeFullChain(client, IDS.patientAR, STAFF_AR, STAFF_BR);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Relido pelo DONO (superuser, bypassa RLS) — prova que a escrita sob app_runtime persistiu de
    // verdade no banco, não é artefato da transação que a criou.
    const direto = await pool.query(`SELECT id FROM conversation_messages WHERE id = $1`, [chain.messageId]);
    expect(direto.rows).toHaveLength(1);

    // Limpa (CASCADE a partir da conversa; notification_events/notifications ficam soltos —
    // apagados explicitamente, mesma ordem do `cleanup`).
    await pool.query(`DELETE FROM notifications WHERE id = $1`, [chain.notificationId]);
    await pool.query(`DELETE FROM notification_events WHERE id = $1`, [chain.eventId]);
    await pool.query(`DELETE FROM conversations WHERE id = $1`, [chain.conversationId]);
  });

  it('3. ISOLAMENTO cross-país por CONTAGEM (nunca só ausência de erro) — ator AR não LÊ as 6 linhas do BR, mesmo com AMBAS existindo', async () => {
    // Seed das 6 tabelas para os DOIS países, como app_system (bypassa a barreira de país pelo
    // atalho legítimo de sistema, contexto declarado) — nunca como enlite_admin, que já bypassa
    // RLS por ser dono e não provaria que o SEED em si respeita a policy quando o ATOR do teste
    // (o app_runtime AR, abaixo) tenta ler.
    const seedAR = await asRole('app_system', { systemContext: 'job:e2e-rls-app-runtime-seed' }, (client) =>
      writeFullChain(client, IDS.patientAR, STAFF_AR, STAFF_BR),
    );
    // asRole faz ROLLBACK sempre — para o seed persistir de fato (precisamos que ele SOBREVIVA
    // para a leitura de app_runtime, numa transação DIFERENTE), gravamos com COMMIT explícito.
    async function seedPersisted(country: 'AR' | 'BR', patientId: string, authorUid: string, mentionedUid: string) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL ROLE app_system`);
        await client.query(`SELECT set_config('app.system_context', $1, true)`, ['job:e2e-rls-app-runtime-seed']);
        const chain = await writeFullChain(client, patientId, authorUid, mentionedUid);
        await client.query('COMMIT');
        return chain;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
    void seedAR; // descartado — o de cima fez ROLLBACK; usamos só a versão persistida abaixo.

    const ar = await seedPersisted('AR', IDS.patientAR, STAFF_AR, STAFF_BR);
    const br = await seedPersisted('BR', IDS.patientBR, STAFF_BR, STAFF_AR);

    try {
      // Ator AR (app_runtime, país AR) tentando ler as linhas das DUAS cadeias, pelos ids reais —
      // nunca por WHERE country, que seria "achar por definição". Cada SELECT mira exatamente as
      // 2 linhas (AR + BR) que sabemos que existem.
      const counts = await asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_AR }, async (client) => {
        const conv = await client.query(`SELECT id FROM conversations WHERE id = ANY($1)`, [
          [ar.conversationId, br.conversationId],
        ]);
        const msg = await client.query(`SELECT id FROM conversation_messages WHERE id = ANY($1)`, [
          [ar.messageId, br.messageId],
        ]);
        const mentions = await client.query(`SELECT message_id FROM conversation_message_mentions WHERE message_id = ANY($1)`, [
          [ar.messageId, br.messageId],
        ]);
        const readMarks = await client.query(`SELECT conversation_id FROM conversation_read_marks WHERE conversation_id = ANY($1)`, [
          [ar.conversationId, br.conversationId],
        ]);
        const events = await client.query(`SELECT id FROM notification_events WHERE id = ANY($1)`, [
          [ar.eventId, br.eventId],
        ]);
        const notifications = await client.query(`SELECT id FROM notifications WHERE id = ANY($1)`, [
          [ar.notificationId, br.notificationId],
        ]);
        return {
          conversations: conv.rows.length,
          messages: msg.rows.length,
          mentions: mentions.rows.length,
          readMarks: readMarks.rows.length,
          events: events.rows.length,
          notifications: notifications.rows.length,
        };
      });

      // As DUAS linhas existem no banco (seed com COMMIT, confirmável pelo dono) — o ator AR só
      // pode ver 1 de cada (a própria), nunca 0 (seed falhou) nem 2 (isolamento furou).
      expect(counts).toEqual({
        conversations: 1,
        messages: 1,
        mentions: 1,
        readMarks: 1,
        events: 1,
        notifications: 1,
      });

      // Controle positivo: o DONO (bypassa RLS) vê as 2 linhas de cada — prova que o seed real tem
      // as DUAS, e que "1" acima é a policy filtrando, não um seed manco.
      const controleDono = await pool.query(`SELECT id FROM conversations WHERE id = ANY($1)`, [
        [ar.conversationId, br.conversationId],
      ]);
      expect(controleDono.rows).toHaveLength(2);
    } finally {
      for (const chain of [ar, br]) {
        await pool.query(`DELETE FROM notifications WHERE id = $1`, [chain.notificationId]);
        await pool.query(`DELETE FROM notification_events WHERE id = $1`, [chain.eventId]);
        await pool.query(`DELETE FROM conversations WHERE id = $1`, [chain.conversationId]);
      }
    }
  });

  it('4. ISOLAMENTO de ESCRITA — ator AR NÃO insere `conversations` para paciente BR (WITH CHECK recusa via EXISTS em `patients`)', async () => {
    await expect(
      asRole('app_runtime', { userCountry: 'AR', userUid: STAFF_AR }, (client) =>
        client.query(`INSERT INTO conversations (patient_id) VALUES ($1)`, [IDS.patientBR]),
      ),
    ).rejects.toThrow(/row-level security/);

    // Contagem: nenhuma conversa nova para o paciente BR (a tentativa realmente não gravou nada).
    const depois = await pool.query(`SELECT COUNT(*)::int AS n FROM conversations WHERE patient_id = $1`, [IDS.patientBR]);
    expect(depois.rows[0].n).toBe(0);
  });

  it('5. ISOLAMENTO de ESCRITA — ator AR NÃO grava `conversation_messages` numa conversa BR alheia (EXISTS em `conversations`, que já filtra por país)', async () => {
    // Cria a conversa BR como app_system (visão de sistema) e faz COMMIT — precisa existir de
    // verdade para o ator AR tentar (e falhar) escrever nela.
    const client = await pool.connect();
    let conversationIdBR: string;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL ROLE app_system`);
      await client.query(`SELECT set_config('app.system_context', $1, true)`, ['job:e2e-rls-app-runtime-seed']);
      const conv = await client.query<{ id: string }>(`INSERT INTO conversations (patient_id) VALUES ($1) RETURNING id`, [
        IDS.patientBR,
      ]);
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
            `INSERT INTO conversation_messages (conversation_id, author_uid, body_encrypted) VALUES ($1, $2, 'enc:ataque')`,
            [conversationIdBR, STAFF_AR],
          ),
        ),
      ).rejects.toThrow(/row-level security/);

      const depois = await pool.query(`SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = $1`, [
        conversationIdBR,
      ]);
      expect(depois.rows[0].n).toBe(0);
    } finally {
      await pool.query(`DELETE FROM conversations WHERE id = $1`, [conversationIdBR]);
    }
  });
});
