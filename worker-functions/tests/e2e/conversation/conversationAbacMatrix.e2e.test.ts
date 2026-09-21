/**
 * conversationAbacMatrix.e2e.test.ts — spec 022, Bloco 1 (T133). HTTP real (app em processo,
 * mesmo harness dos e2e de família única — `permissionFamilyHarness.ts`), Postgres real, engine
 * ABAC LIGADO, DUAS famílias ao mesmo tempo (`admin.patients` + `admin.users`) — é o que permite
 * provar, no MESMO run, que o ator com célula completa de conversa (C) NÃO vaza para
 * `staff_directory:read` (célula de outra família que ele nunca recebeu).
 *
 * 3 contas seedadas:
 *   A — nenhuma célula (0 grupos).
 *   B — só `patient_conversation:read`.
 *   C — `patient_conversation: read + create + update + delete`.
 * NENHUMA das três tem `staff_directory:read`.
 *
 * Nenhum texto clínico real em fixture/asserção — corpo sintético `"msg-*"` (regra dura do
 * CLAUDE.md: texto clínico nunca em log/prompt/fixture). UIDs/e-mails/nomes sintéticos.
 *
 * Como rodar:
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5442/enlite_e2e_022 \
 *   PERMISSION_ENGINE_ENABLED=true PERMISSION_CATALOG_SYNC_ENABLED=true \
 *     npx jest --config jest.config.e2e.js tests/e2e/conversation/conversationAbacMatrix.e2e.test.ts
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

describe('Matriz ABAC — 3 atores × conversa + staff-directory (spec 022, T133)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const PATIENT = 'ee422000-c4a7-0002-0002-000000000002';
  const COUNTRY = 'AR';
  // Autor sintético da mensagem "alheia" — NUNCA existe em `users` (author_uid não tem FK,
  // ver migration 458): não precisa ser conta real para provar D-04 (só o autor edita/apaga).
  const OUTRO_AUTOR_UID = 'e022-abac-matriz-outro-autor';

  const U = { a: 'e022-abac-matriz-a', b: 'e022-abac-matriz-b', c: 'e022-abac-matriz-c' };
  const GRUPO_B = 'E022 ABAC Matriz B (read)';
  const GRUPO_C = 'E022 ABAC Matriz C (completa)';

  const CELULAS_CONVERSA: ReadonlyArray<readonly [string, string]> = [
    ['patient_conversation', 'read'],
    ['patient_conversation', 'create'],
    ['patient_conversation', 'update'],
    ['patient_conversation', 'delete'],
  ];
  const celulasCriadas: Array<[string, string]> = [];

  let conversationId: string;
  /** Topo criado por C — só para "GET .../replies"; nunca mutado por outro teste. */
  let msgParaReplies: string;
  /** Topo criado por C — só para "PATCH própria"; nenhum outro teste mexe nele. */
  let msgPropriaC: string;
  /** Inserido DIRETO por SQL (author_uid = OUTRO_AUTOR_UID) — "alheia" para PATCH e DELETE.
   * Reusar entre as duas linhas é seguro: em TODAS as combinações (A/B/C) a autorização nega
   * ANTES de qualquer UPDATE/soft-delete (nem C, que tem a célula, é o autor). */
  let msgAlheia: string;

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: [...Object.values(U)], grupos: [GRUPO_B, GRUPO_C] });
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
         ($1, 'e022-abac-matriz-a@e2e.local', 'Matriz A', 'admin', 'ACTIVE', true, $4),
         ($2, 'e022-abac-matriz-b@e2e.local', 'Matriz B', 'admin', 'ACTIVE', true, $4),
         ($3, 'e022-abac-matriz-c@e2e.local', 'Matriz C', 'admin', 'ACTIVE', true, $4)`,
      [U.a, U.b, U.c, TENANT_E2E],
    );

    for (const [resource, action] of CELULAS_CONVERSA) {
      const { criada } = await garantirCelula(pool, { resource, action, category: 'Pacientes' });
      if (criada) celulasCriadas.push([resource, action]);
    }

    // A fica FORA de qualquer grupo (0 células) — cenário `no_group`.
    await grupoComCelulas(pool, { nome: GRUPO_B, uid: U.b, celulas: [['patient_conversation', 'read']] });
    await grupoComCelulas(pool, {
      nome: GRUPO_C,
      uid: U.c,
      celulas: CELULAS_CONVERSA.map(([r, a]): [string, string] => [r, a]),
    });
    // NENHUM insert de `staff_directory:read` em GRUPO_B/GRUPO_C — é o ponto do teste (C não vaza
    // para célula de OUTRA família). A célula em si (catálogo) já existe desde o boot da API
    // (T127/T128) ou de outra suíte — não precisamos garanti-la para provar ausência de grant.

    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-022-abac-matriz', 'Paciente', 'Matriz', $2, true)`,
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
    const { createAdminStaffDirectoryRoutes } = await import(
      '../../../src/modules/identity/interfaces/routes/adminStaffDirectoryRoutes'
    );
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients;admin.users',
      montarRotas: ({ app: express, auth, permissions }) => {
        express.use('/api/admin', createAdminConversationRoutes(auth, permissions));
        express.use('/api/admin', createAdminStaffDirectoryRoutes(auth, permissions));
      },
    });

    // Fixtures de mensagem — criadas DEPOIS do app subir (dependem de HTTP para msgParaReplies/
    // msgPropriaC; msgAlheia é SQL direto porque author_uid não pode ser nenhum dos 3 atores).
    const topoReplies = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.c, {
      body: 'msg-abac-matriz-replies',
    });
    if (topoReplies.status !== 201) {
      throw new Error(`fixture msgParaReplies falhou ao criar (status ${topoReplies.status}) — matriz não pode rodar`);
    }
    msgParaReplies = topoReplies.body.data.id;

    const topoPropria = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.c, {
      body: 'msg-abac-matriz-propria',
    });
    if (topoPropria.status !== 201) {
      throw new Error(`fixture msgPropriaC falhou ao criar (status ${topoPropria.status}) — matriz não pode rodar`);
    }
    msgPropriaC = topoPropria.body.data.id;

    const convRow = await pool.query<{ id: string }>(`SELECT id FROM conversations WHERE patient_id = $1`, [PATIENT]);
    conversationId = convRow.rows[0].id;
    const alheiaRow = await pool.query<{ id: string }>(
      `INSERT INTO conversation_messages (conversation_id, author_uid, body_encrypted) VALUES ($1, $2, $3) RETURNING id`,
      [conversationId, OUTRO_AUTOR_UID, 'ciphertext-sintetico-e2e'],
    );
    msgAlheia = alheiaRow.rows[0].id;
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

  it('1. GET conversa — A:403 no_group, B:200, C:200', async () => {
    const a = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.a);
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('no_group');

    const b = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.b);
    expect(b.status).toBe(200);
    expect(b.body.success).toBe(true);

    const c = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.c);
    expect(c.status).toBe(200);
    expect(c.body.success).toBe(true);
  });

  it('2. GET .../messages/:mid/replies — A:403 no_group, B:200, C:200', async () => {
    const rota = `/api/admin/patients/${PATIENT}/conversation/messages/${msgParaReplies}/replies`;

    const a = await chamar('GET', rota, U.a);
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('no_group');

    const b = await chamar('GET', rota, U.b);
    expect(b.status).toBe(200);
    expect(b.body.success).toBe(true);

    const c = await chamar('GET', rota, U.c);
    expect(c.status).toBe(200);
    expect(c.body.success).toBe(true);
  });

  it('3. POST mensagem — A:403 no_group, B:403 missing_cell (só tem `read`, falta `create`), C:201', async () => {
    const rota = `/api/admin/patients/${PATIENT}/conversation/messages`;

    const a = await chamar('POST', rota, U.a, { body: 'msg-abac-matriz-post-a' });
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('no_group');

    // B TEM grupo (GRUPO_B) — só falta a célula `create`, então o middleware nega por
    // `missing_cell`, não `no_group` (código distinto: PermissionMiddleware.ts:405-406).
    const b = await chamar('POST', rota, U.b, { body: 'msg-abac-matriz-post-b' });
    expect(b.status).toBe(403);
    expect(b.body.code).toBe('missing_cell');

    const c = await chamar('POST', rota, U.c, { body: 'msg-abac-matriz-post-c' });
    expect(c.status).toBe(201);
    expect(c.body.success).toBe(true);
  });

  it('4. PATCH mensagem ALHEIA — A:403 no_group, B:403 missing_cell (falta `update`), C:403 NOT_MESSAGE_AUTHOR (tem a célula, não é o autor)', async () => {
    const rota = `/api/admin/patients/${PATIENT}/conversation/messages/${msgAlheia}`;

    const a = await chamar('PATCH', rota, U.a, { body: 'tentativa-a' });
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('no_group');

    const b = await chamar('PATCH', rota, U.b, { body: 'tentativa-b' });
    expect(b.status).toBe(403);
    expect(b.body.code).toBe('missing_cell');

    const c = await chamar('PATCH', rota, U.c, { body: 'tentativa-c' });
    expect(c.status).toBe(403);
    expect(c.body.code).toBe('NOT_MESSAGE_AUTHOR');
  });

  it('5. PATCH mensagem PRÓPRIA — A:403 no_group, B:403 missing_cell (falta `update`), C:200 (é o autor)', async () => {
    const rota = `/api/admin/patients/${PATIENT}/conversation/messages/${msgPropriaC}`;

    const a = await chamar('PATCH', rota, U.a, { body: 'tentativa-a' });
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('no_group');

    const b = await chamar('PATCH', rota, U.b, { body: 'tentativa-b' });
    expect(b.status).toBe(403);
    expect(b.body.code).toBe('missing_cell');

    const c = await chamar('PATCH', rota, U.c, { body: 'msg-abac-matriz-propria-editada' });
    expect(c.status).toBe(200);
    expect(c.body.success).toBe(true);
  });

  it('6. DELETE mensagem ALHEIA — A:403 no_group, B:403 missing_cell (falta `delete`), C:403 NOT_MESSAGE_AUTHOR (tem a célula, não é o autor)', async () => {
    const rota = `/api/admin/patients/${PATIENT}/conversation/messages/${msgAlheia}`;

    const a = await chamar('DELETE', rota, U.a);
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('no_group');

    const b = await chamar('DELETE', rota, U.b);
    expect(b.status).toBe(403);
    expect(b.body.code).toBe('missing_cell');

    const c = await chamar('DELETE', rota, U.c);
    expect(c.status).toBe(403);
    expect(c.body.code).toBe('NOT_MESSAGE_AUTHOR');

    // Prova direta no banco: a mensagem alheia NÃO foi apagada por ninguém — os 3 403 são reais,
    // não um soft-delete que passou e a asserção não notou.
    const direto = await pool.query(`SELECT deleted_at FROM conversation_messages WHERE id = $1`, [msgAlheia]);
    expect(direto.rows[0].deleted_at).toBeNull();
  });

  it('7. PUT read-mark — A:403 no_group, B:200, C:200', async () => {
    const rota = `/api/admin/patients/${PATIENT}/conversation/read-mark`;

    const a = await chamar('PUT', rota, U.a);
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('no_group');

    const b = await chamar('PUT', rota, U.b);
    expect(b.status).toBe(200);
    expect(b.body.success).toBe(true);

    const c = await chamar('PUT', rota, U.c);
    expect(c.status).toBe(200);
    expect(c.body.success).toBe(true);
  });

  it('8. GET /api/admin/staff-directory (sem staff_directory:read) — A:403 no_group, B:403 missing_cell, C:403 missing_cell — NENHUM vaza, nem C com célula completa de conversa', async () => {
    const rota = `/api/admin/staff-directory?q=Staffdir`;

    const a = await chamar('GET', rota, U.a);
    expect(a.status).toBe(403);
    expect(a.body.code).toBe('no_group');

    // B/C TÊM grupo (GRUPO_B/GRUPO_C) — só falta a célula `staff_directory:read` (outra
    // família), então o código é `missing_cell`, não `no_group`.
    const b = await chamar('GET', rota, U.b);
    expect(b.status).toBe(403);
    expect(b.body.code).toBe('missing_cell');

    // O caso que mais importa: C tem read+create+update+delete de `patient_conversation`
    // (outra família de célula) — se isto desse 200, a célula vazou entre famílias.
    const c = await chamar('GET', rota, U.c);
    expect(c.status).toBe(403);
    expect(c.body.code).toBe('missing_cell');
  });
});
