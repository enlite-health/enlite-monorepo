/**
 * adminNotifications.e2e.test.ts — spec 022, Bloco 4 (T404/T406/T417/T418). HTTP real (app em
 * processo, `permissionFamilyHarness.ts`), Postgres real, engine ABAC LIGADO.
 *
 * Cobre:
 *  1. CRUD básico do sino: lista só do próprio uid, unread-count, marcar 1 como lida,
 *     marcar todas como lidas (T404).
 *  2. Isolamento entre destinatários (D-24, T417): A nunca vê/marca notificação de B; marcar
 *     notificação alheia devolve 404 (nunca 403 — decisão do orquestrador, não confirma
 *     existência a quem não é dono).
 *  3. Matriz de ABAC de 3 atores × 4 rotas de `own_notifications:*` (D-24, T418).
 *
 * Nenhum texto clínico/corpo de mensagem em fixture/asserção — regra dura do CLAUDE.md.
 *
 * Como rodar:
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e_022 \
 *   PERMISSION_ENGINE_ENABLED=true PERMISSION_CATALOG_SYNC_ENABLED=true \
 *     npx jest --config jest.config.e2e.js tests/e2e/notifications/adminNotifications.e2e.test.ts
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

describe('Notificações in-app — CRUD, isolamento (D-24) e matriz ABAC (Spec 022, Bloco 4)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const PATIENT = 'ee422000-c4a7-0004-0004-000000000004';
  const COUNTRY = 'AR';

  // Isolamento (parte 1): destinatária de verdade (D) e um mencionador (E).
  const U_MENCIONADOR = 'e022-b4-not-mencionador';
  const U_D = 'e022-b4-not-destinatario-d';
  const U_OUTRO = 'e022-b4-not-outro-e';

  // Matriz ABAC (parte 2): 3 atores × 4 rotas de own_notifications.
  const M = { semCelula: 'e022-b4-abac-sem', soLeitura: 'e022-b4-abac-leitura', completo: 'e022-b4-abac-completo' };
  const GRUPO_MENCIONADOR = 'E022 B4 Mencionador';
  const GRUPO_D = 'E022 B4 Destinatária D';
  const GRUPO_OUTRO = 'E022 B4 Outro E';
  const GRUPO_LEITURA = 'E022 B4 ABAC — só read';
  const GRUPO_COMPLETO = 'E022 B4 ABAC — read+update';
  const TODOS_GRUPOS = [GRUPO_MENCIONADOR, GRUPO_D, GRUPO_OUTRO, GRUPO_LEITURA, GRUPO_COMPLETO];

  const TODOS_UIDS = [U_MENCIONADOR, U_D, U_OUTRO, M.semCelula, M.soLeitura, M.completo];
  const celulasCriadas: Array<[string, string]> = [];

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: TODOS_UIDS, grupos: TODOS_GRUPOS });
    // `notification_events.patient_id`/`.conversation_id` são `ON DELETE SET NULL` (migration
    // 460), NUNCA CASCADE — deletar o paciente NÃO limpa notificação nenhuma (achado desta
    // sessão: 1ª tentativa de reexecução vazou contagem entre runs). Limpeza explícita por uid.
    await pool.query(
      `DELETE FROM notifications WHERE recipient_uid = ANY($1) OR event_id IN (SELECT id FROM notification_events WHERE actor_uid = ANY($1))`,
      [TODOS_UIDS],
    );
    await pool.query(`DELETE FROM notification_events WHERE actor_uid = ANY($1)`, [TODOS_UIDS]);
    await pool.query(`DELETE FROM patients WHERE id = $1`, [PATIENT]); // CASCADE leva conversations/messages
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

  async function chamar(
    metodo: string,
    caminho: string,
    uid: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
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
         ($1, 'e022-b4-mencionador@e2e.local', 'Mencionador', 'admin', 'ACTIVE', true, $7),
         ($2, 'e022-b4-d@e2e.local', 'Destinataria D', 'admin', 'ACTIVE', true, $7),
         ($3, 'e022-b4-outro@e2e.local', 'Outro E', 'admin', 'ACTIVE', true, $7),
         ($4, 'e022-b4-abac-sem@e2e.local', 'ABAC Sem Célula', 'admin', 'ACTIVE', true, $7),
         ($5, 'e022-b4-abac-leitura@e2e.local', 'ABAC Só Leitura', 'admin', 'ACTIVE', true, $7),
         ($6, 'e022-b4-abac-completo@e2e.local', 'ABAC Completo', 'admin', 'ACTIVE', true, $7)`,
      [U_MENCIONADOR, U_D, U_OUTRO, M.semCelula, M.soLeitura, M.completo, TENANT_E2E],
    );

    const { criada: c1 } = await garantirCelula(pool, { resource: 'patient_conversation', action: 'create', category: 'Pacientes' });
    if (c1) celulasCriadas.push(['patient_conversation', 'create']);
    const { criada: c2 } = await garantirCelula(pool, { resource: 'own_notifications', action: 'read', category: 'Administração' });
    if (c2) celulasCriadas.push(['own_notifications', 'read']);
    const { criada: c3 } = await garantirCelula(pool, { resource: 'own_notifications', action: 'update', category: 'Administração' });
    if (c3) celulasCriadas.push(['own_notifications', 'update']);

    // Mencionador precisa de `patient_conversation:create` para gerar a notificação real via
    // fluxo HTTP (fan-out roda dentro do POST — nunca inserção direta em SQL nesta suíte).
    await grupoComCelulas(pool, { nome: GRUPO_MENCIONADOR, uid: U_MENCIONADOR, celulas: [['patient_conversation', 'create']] });
    // D e OUTRO precisam de own_notifications:read|update para operar o próprio sino.
    await grupoComCelulas(pool, { nome: GRUPO_D, uid: U_D, celulas: [['own_notifications', 'read'], ['own_notifications', 'update']] });
    await grupoComCelulas(pool, { nome: GRUPO_OUTRO, uid: U_OUTRO, celulas: [['own_notifications', 'read'], ['own_notifications', 'update']] });

    // Matriz ABAC: semCelula fica FORA de qualquer grupo (0 células) — cenário `no_group`.
    await grupoComCelulas(pool, { nome: GRUPO_LEITURA, uid: M.soLeitura, celulas: [['own_notifications', 'read']] });
    await grupoComCelulas(pool, { nome: GRUPO_COMPLETO, uid: M.completo, celulas: [['own_notifications', 'read'], ['own_notifications', 'update']] });

    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-022-b4-notifications', 'Paciente', 'B4', $2, true)`,
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

  describe('CRUD básico (T404) + isolamento entre destinatários (D-24, T417)', () => {
    let notificationIdD: string;

    it('mencionar D via POST gera notificação real (fan-out dentro da transação) — D vê 1 na lista', async () => {
      const post = await chamar(
        'POST',
        `/api/admin/patients/${PATIENT}/conversation/messages`,
        U_MENCIONADOR,
        { body: `oi <@${U_D}>` },
      );
      expect(post.status).toBe(201);

      const lista = await chamar('GET', '/api/admin/notifications', U_D);
      expect(lista.status).toBe(200);
      expect(lista.body.data).toHaveLength(1);
      expect(lista.body.data[0].typeCode).toBe('CONVERSATION_MENTIONED');
      expect(lista.body.data[0].actorUid).toBe(U_MENCIONADOR);
      notificationIdD = lista.body.data[0].id;
    });

    it('OUTRO (E) NUNCA vê a notificação de D — isolamento entre destinatários', async () => {
      const listaOutro = await chamar('GET', '/api/admin/notifications', U_OUTRO);
      expect(listaOutro.status).toBe(200);
      expect(listaOutro.body.data).toHaveLength(0);
    });

    it('unread-count de D é 1; unread-count de OUTRO é 0 (cada um só reflete o PRÓPRIO)', async () => {
      const countD = await chamar('GET', '/api/admin/notifications/unread-count', U_D);
      expect(countD.body.data.count).toBe(1);

      const countOutro = await chamar('GET', '/api/admin/notifications/unread-count', U_OUTRO);
      expect(countOutro.body.data.count).toBe(0);
    });

    it('OUTRO tenta marcar a notificação de D como lida: 404 (NUNCA 403 — não confirma existência)', async () => {
      const tentativa = await chamar('POST', `/api/admin/notifications/${notificationIdD}/read`, U_OUTRO);
      expect(tentativa.status).toBe(404);
      expect(tentativa.body.code).toBe('NOTIFICATION_NOT_FOUND');

      // Confirma que NÃO marcou (defesa: se tivesse marcado, o count de D cairia para 0).
      const countDAinda = await chamar('GET', '/api/admin/notifications/unread-count', U_D);
      expect(countDAinda.body.data.count).toBe(1);
    });

    it('D marca a PRÓPRIA notificação como lida: 200, unread-count cai para 0', async () => {
      const marcar = await chamar('POST', `/api/admin/notifications/${notificationIdD}/read`, U_D);
      expect(marcar.status).toBe(200);

      const countDepois = await chamar('GET', '/api/admin/notifications/unread-count', U_D);
      expect(countDepois.body.data.count).toBe(0);
    });

    it('read-all: marca todas as pendentes de D (2 novas menções) e devolve { updated: 2 }', async () => {
      await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U_MENCIONADOR, { body: `oi de novo <@${U_D}>` });
      await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U_MENCIONADOR, { body: `e mais uma vez <@${U_D}>` });

      const antes = await chamar('GET', '/api/admin/notifications/unread-count', U_D);
      expect(antes.body.data.count).toBe(2);

      const readAll = await chamar('POST', '/api/admin/notifications/read-all', U_D);
      expect(readAll.status).toBe(200);
      expect(readAll.body.data.updated).toBe(2);

      const depois = await chamar('GET', '/api/admin/notifications/unread-count', U_D);
      expect(depois.body.data.count).toBe(0);

      // read-all de OUTRO (que não tem nada pendente) devolve { updated: 0 } — nunca toca as de D.
      const readAllOutro = await chamar('POST', '/api/admin/notifications/read-all', U_OUTRO);
      expect(readAllOutro.body.data.updated).toBe(0);
    });
  });

  describe('Matriz de ABAC — 3 atores × 4 rotas de own_notifications (D-24, T418)', () => {
    it('1. GET /notifications — semCelula:403 no_group, soLeitura:200, completo:200', async () => {
      const sem = await chamar('GET', '/api/admin/notifications', M.semCelula);
      expect(sem.status).toBe(403);
      expect(sem.body.code).toBe('no_group');

      const leitura = await chamar('GET', '/api/admin/notifications', M.soLeitura);
      expect(leitura.status).toBe(200);

      const completo = await chamar('GET', '/api/admin/notifications', M.completo);
      expect(completo.status).toBe(200);
    });

    it('2. GET /notifications/unread-count — semCelula:403 no_group, soLeitura:200, completo:200', async () => {
      const sem = await chamar('GET', '/api/admin/notifications/unread-count', M.semCelula);
      expect(sem.status).toBe(403);
      expect(sem.body.code).toBe('no_group');

      const leitura = await chamar('GET', '/api/admin/notifications/unread-count', M.soLeitura);
      expect(leitura.status).toBe(200);

      const completo = await chamar('GET', '/api/admin/notifications/unread-count', M.completo);
      expect(completo.status).toBe(200);
    });

    it('3. POST /:id/read — semCelula:403 no_group, soLeitura:403 missing_cell (falta update), completo:404 (célula passa, id não é dele)', async () => {
      const idFalso = '00000000-0000-0000-0000-000000000000';

      const sem = await chamar('POST', `/api/admin/notifications/${idFalso}/read`, M.semCelula);
      expect(sem.status).toBe(403);
      expect(sem.body.code).toBe('no_group');

      const leitura = await chamar('POST', `/api/admin/notifications/${idFalso}/read`, M.soLeitura);
      expect(leitura.status).toBe(403);
      expect(leitura.body.code).toBe('missing_cell');

      // completo TEM a célula — a rota deixa passar o ABAC e o 404 vem do USE CASE (id não existe/não é dele).
      const completo = await chamar('POST', `/api/admin/notifications/${idFalso}/read`, M.completo);
      expect(completo.status).toBe(404);
      expect(completo.body.code).toBe('NOTIFICATION_NOT_FOUND');
    });

    it('4. POST /read-all — semCelula:403 no_group, soLeitura:403 missing_cell (falta update), completo:200', async () => {
      const sem = await chamar('POST', '/api/admin/notifications/read-all', M.semCelula);
      expect(sem.status).toBe(403);
      expect(sem.body.code).toBe('no_group');

      const leitura = await chamar('POST', '/api/admin/notifications/read-all', M.soLeitura);
      expect(leitura.status).toBe(403);
      expect(leitura.body.code).toBe('missing_cell');

      const completo = await chamar('POST', '/api/admin/notifications/read-all', M.completo);
      expect(completo.status).toBe(200);
      expect(completo.body.data.updated).toBe(0);
    });
  });
});
