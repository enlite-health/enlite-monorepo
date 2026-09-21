/**
 * notificationFanOut.e2e.test.ts — spec 022, Bloco 4 (T415). HTTP real, Postgres real, engine
 * ABAC LIGADO. Cobre o cenário de D-09 que `adminNotifications.e2e.test.ts` NÃO cobre (aquele
 * arquivo prova menção; este prova THREAD): resposta numa thread de 3 participantes notifica os
 * outros 2, NUNCA o autor da resposta atual.
 *
 * Como rodar:
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e_022 \
 *   PERMISSION_ENGINE_ENABLED=true PERMISSION_CATALOG_SYNC_ENABLED=true \
 *     npx jest --config jest.config.e2e.js tests/e2e/notifications/notificationFanOut.e2e.test.ts
 */
import { Pool } from 'pg';
import {
  montarAppDeFamilia,
  tokenMock,
  grupoComCelulas,
  limparIamFixtures,
  garantirCelula,
  TENANT_E2E,
  type AppDeFamilia,
} from '../helpers/permissionFamilyHarness';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e_022';

describe('Fan-out de thread respondida — D-09 (Spec 022, Bloco 4, T415)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const PATIENT = 'ee422000-c4a7-0004-0005-000000000005';
  const COUNTRY = 'AR';

  // Thread de 3 participantes: ROOT postado por P1, reply por P2, reply por P3.
  const P1 = 'e022-b4-fanout-p1';
  const P2 = 'e022-b4-fanout-p2';
  const P3 = 'e022-b4-fanout-p3';
  const GRUPO = 'E022 B4 Fan-out Thread';

  const TODOS_UIDS = [P1, P2, P3];
  const celulasCriadas: Array<[string, string]> = [];

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: TODOS_UIDS, grupos: [GRUPO, `${GRUPO} P2`, `${GRUPO} P3`] });
    // `notification_events.patient_id`/`.conversation_id` são `ON DELETE SET NULL` (migration
    // 460), NUNCA CASCADE — deletar o paciente NÃO limpa notificação nenhuma. Limpeza explícita.
    await pool.query(
      `DELETE FROM notifications WHERE recipient_uid = ANY($1) OR event_id IN (SELECT id FROM notification_events WHERE actor_uid = ANY($1))`,
      [TODOS_UIDS],
    );
    await pool.query(`DELETE FROM notification_events WHERE actor_uid = ANY($1)`, [TODOS_UIDS]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT]);
  }

  async function limparCelulasCriadas(): Promise<void> {
    for (const [resource, action] of celulasCriadas) {
      await pool.query(
        `DELETE FROM iam.group_permissions WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = $1 AND action = $2)`,
        [resource, action],
      );
      await pool.query(`DELETE FROM iam.permissions WHERE resource = $1 AND action = $2`, [resource, action]);
    }
  }

  async function chamar(metodo: string, caminho: string, uid: string, body?: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: { Authorization: tokenMock(uid, 'admin', COUNTRY), 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();

    await pool.query(
      `INSERT INTO users (firebase_uid, email, display_name, role, status, is_active, tenant_id) VALUES
         ($1, 'e022-b4-fanout-p1@e2e.local', 'Fanout P1', 'admin', 'ACTIVE', true, $4),
         ($2, 'e022-b4-fanout-p2@e2e.local', 'Fanout P2', 'admin', 'ACTIVE', true, $4),
         ($3, 'e022-b4-fanout-p3@e2e.local', 'Fanout P3', 'admin', 'ACTIVE', true, $4)`,
      [P1, P2, P3, TENANT_E2E],
    );

    const { criada: c1 } = await garantirCelula(pool, { resource: 'patient_conversation', action: 'create', category: 'Pacientes' });
    if (c1) celulasCriadas.push(['patient_conversation', 'create']);
    const { criada: c2 } = await garantirCelula(pool, { resource: 'own_notifications', action: 'read', category: 'Administração' });
    if (c2) celulasCriadas.push(['own_notifications', 'read']);

    await grupoComCelulas(pool, {
      nome: GRUPO,
      uid: P1,
      celulas: [['patient_conversation', 'create'], ['own_notifications', 'read']],
    });
    // Os 3 precisam do MESMO conjunto — 3 grupos com o mesmo nome colidiria (UNIQUE), então 3 nomes.
    await grupoComCelulas(pool, {
      nome: `${GRUPO} P2`,
      uid: P2,
      celulas: [['patient_conversation', 'create'], ['own_notifications', 'read']],
    });
    await grupoComCelulas(pool, {
      nome: `${GRUPO} P3`,
      uid: P3,
      celulas: [['patient_conversation', 'create'], ['own_notifications', 'read']],
    });

    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-022-b4-fanout', 'Paciente', 'Fanout', $2, true)`,
      [PATIENT, COUNTRY],
    );

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients;admin.users');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const { createAdminConversationRoutes } = await import(
      '../../../src/modules/conversation/interfaces/routes/adminConversationRoutes'
    );
    const { createAdminNotificationRoutes } = await import(
      '../../../src/modules/inapp-notification/interfaces/routes/adminNotificationRoutes'
    );
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients;admin.users',
      montarRotas: ({ app: express, auth, permissions, modulo }) => {
        express.use('/api/admin', createAdminConversationRoutes(auth, permissions));
        express.use('/api/admin', createAdminNotificationRoutes(auth, permissions, modulo.client));
      },
    });
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await limparCelulasCriadas();
    await pool.end();
    for (const [k, v] of Object.entries(envAnterior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('root de P1 não notifica ninguém (mensagem de topo, sem menção, sem thread ainda)', async () => {
    const root = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, P1, { body: 'root-fanout' });
    expect(root.status).toBe(201);

    const countP1 = await chamar('GET', '/api/admin/notifications/unread-count', P1);
    expect(countP1.body.data.count).toBe(0);
  });

  it('P2 responde ao root: notifica P1 (autor do root), NUNCA o próprio P2', async () => {
    const rootRow = await pool.query<{ id: string }>(
      `SELECT id FROM conversation_messages WHERE conversation_id = (SELECT id FROM conversations WHERE patient_id = $1) AND root_message_id IS NULL`,
      [PATIENT],
    );
    const rootId = rootRow.rows[0].id;

    const reply = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, P2, {
      body: 'reply-fanout-p2',
      rootMessageId: rootId,
    });
    expect(reply.status).toBe(201);

    const countP1 = await chamar('GET', '/api/admin/notifications/unread-count', P1);
    expect(countP1.body.data.count).toBe(1);

    const countP2 = await chamar('GET', '/api/admin/notifications/unread-count', P2);
    expect(countP2.body.data.count).toBe(0); // nunca notifica a si mesmo

    const listaP1 = await chamar('GET', '/api/admin/notifications', P1);
    expect(listaP1.body.data[0].typeCode).toBe('CONVERSATION_REPLIED');
    expect(listaP1.body.data[0].actorUid).toBe(P2);
  });

  it('P3 responde na MESMA thread: notifica P1 E P2 (os outros 2 participantes), NUNCA P3', async () => {
    const rootRow = await pool.query<{ id: string }>(
      `SELECT id FROM conversation_messages WHERE conversation_id = (SELECT id FROM conversations WHERE patient_id = $1) AND root_message_id IS NULL`,
      [PATIENT],
    );
    const rootId = rootRow.rows[0].id;

    const reply = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, P3, {
      body: 'reply-fanout-p3',
      rootMessageId: rootId,
    });
    expect(reply.status).toBe(201);

    // P1 tinha 1 (da resposta de P2) + 1 nova (da resposta de P3) = 2.
    const countP1 = await chamar('GET', '/api/admin/notifications/unread-count', P1);
    expect(countP1.body.data.count).toBe(2);

    // P2 agora tem 1 (a resposta de P3 o notifica, já que ele participa da thread).
    const countP2 = await chamar('GET', '/api/admin/notifications/unread-count', P2);
    expect(countP2.body.data.count).toBe(1);

    // P3 nunca notifica a si mesmo.
    const countP3 = await chamar('GET', '/api/admin/notifications/unread-count', P3);
    expect(countP3.body.data.count).toBe(0);
  });
});
