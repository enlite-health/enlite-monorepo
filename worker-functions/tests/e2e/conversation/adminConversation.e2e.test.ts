/**
 * adminConversation.e2e.test.ts — spec 022, Bloco 1 (T118). HTTP real (app em processo, mesmo
 * harness dos e2e de família única — `permissionFamilyHarness.ts`), Postgres real, engine ABAC
 * LIGADO (`PERMISSION_ENGINE_ENABLED=true` + família `admin.patients` em `PERMISSION_ENFORCED_ROUTES`).
 *
 * Nenhum texto clínico real em fixture/asserção — corpo sintético `"msg-1"`/`"msg-2"` (regra dura
 * do CLAUDE.md: texto clínico nunca em log/prompt/fixture).
 *
 * Como rodar (RED, antes de T119/T120 existirem):
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e \
 *     npx jest --config jest.config.e2e.js tests/e2e/conversation/adminConversation.e2e.test.ts
 *
 * (GREEN, com engine ligado — mesma env que o beforeAll já declara, não precisa repetir na CLI.)
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
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Conversa do paciente (spec 022, Bloco 1) — HTTP real, Postgres real, engine ABAC ligado', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const PATIENT = 'ee422000-c4a7-0001-0001-000000000001';
  // 2º paciente — só para provar isolamento cross-paciente (caso 13, fecho da classe do gate
  // revisao-pr): NUNCA usado nos casos 1-12, sempre limpo junto de `limpar()`.
  const PATIENT_OUTRO = 'ee422000-c4a7-0002-0001-000000000001';
  const COUNTRY = 'AR';

  // `country` no mock-token precisa bater com o país do paciente — a policy `patients_country_isolation`
  // (mig 411) é fail-closed sem claim/grant de país (`stack-e2e-abac-ligado`).
  const U = { autor: 'e022-conv-autor', outro: 'e022-conv-outro', semCelula: 'e022-conv-sem-celula' };
  const GRUPO_COMPLETA = 'E022 Conversa Completa';

  const CELULAS: ReadonlyArray<readonly [string, string]> = [
    ['patient_conversation', 'read'],
    ['patient_conversation', 'create'],
    ['patient_conversation', 'update'],
    ['patient_conversation', 'delete'],
  ];
  const celulasCriadas: Array<[string, string]> = [];

  const envAnterior: Record<string, string | undefined> = {};
  const setEnv = (k: string, v: string): void => {
    envAnterior[k] = process.env[k];
    process.env[k] = v;
  };

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: [GRUPO_COMPLETA] });
    await pool.query(`DELETE FROM patients WHERE id = ANY($1)`, [[PATIENT, PATIENT_OUTRO]]); // CASCADE leva conversations/messages
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
         ($1, 'e022-conv-autor@e2e.local', 'Autor', 'admin', 'ACTIVE', true, $4),
         ($2, 'e022-conv-outro@e2e.local', 'Outro', 'admin', 'ACTIVE', true, $4),
         ($3, 'e022-conv-sem-celula@e2e.local', 'SemCelula', 'admin', 'ACTIVE', true, $4)`,
      [U.autor, U.outro, U.semCelula, TENANT_E2E],
    );

    for (const [resource, action] of CELULAS) {
      const { criada } = await garantirCelula(pool, { resource, action, category: 'Pacientes' });
      if (criada) celulasCriadas.push([resource, action]);
    }

    // U.semCelula fica FORA de qualquer grupo (0 grupos) — é o cenário `no_group` do
    // PermissionMiddleware, 403 por falta de célula.
    await grupoComCelulas(pool, {
      nome: GRUPO_COMPLETA,
      uid: U.autor,
      celulas: CELULAS.map(([resource, action]): [string, string] => [resource, action]),
    });
    // 2º membro do MESMO grupo (célula completa) — necessário para o caso "editar/apagar alheia":
    // sem a célula, U.outro seria negado no middleware (403 por permissão), e o teste provaria a
    // classe errada de 403. Com a célula, o 403 que sobra só pode ser "não é o autor" (D-04).
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) SELECT $1, id, $2 FROM iam.permission_groups WHERE name = $3`, [
      U.outro,
      TENANT_E2E,
      GRUPO_COMPLETA,
    ]);

    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, is_test) VALUES
         ($1, 'e2e-022-conv', 'Paciente', 'Sintetico', $3, true),
         ($2, 'e2e-022-conv-outro', 'Paciente', 'Outro', $3, true)`,
      [PATIENT, PATIENT_OUTRO, COUNTRY],
    );

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    const { createAdminConversationRoutes } = await import(
      '../../../src/modules/conversation/interfaces/routes/adminConversationRoutes'
    );
    app = await montarAppDeFamilia({
      enforcedRoutes: 'admin.patients',
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin', createAdminConversationRoutes(auth, permissions)),
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

  it('1. postar mensagem de topo — 201', async () => {
    const res = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, { body: 'msg-1' });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('2. responder — root correto (replyCount do topo sobe para 1)', async () => {
    const topo = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, { body: 'msg-2' });
    expect(topo.status).toBe(201);
    const topoId = topo.body.data.id;

    const reply = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, {
      body: 'msg-2-reply',
      rootMessageId: topoId,
    });
    expect(reply.status).toBe(201);

    const lista = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.autor);
    expect(lista.status).toBe(200);
    const linhaTopo = lista.body.data.messages.find((m: { id: string }) => m.id === topoId);
    expect(linhaTopo.replyCount).toBe(1);

    // Prova direta no banco: a reply gravou o ROOT certo (não outro id).
    const direto = await pool.query(`SELECT root_message_id FROM conversation_messages WHERE id = $1`, [reply.body.data.id]);
    expect(direto.rows[0].root_message_id).toBe(topoId);
  });

  it('3. reply-de-reply normaliza para o ROOT do root (D-03) — sem erro, replyCount do topo original sobe para 2', async () => {
    const topo = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, { body: 'msg-3' });
    const topoId = topo.body.data.id;
    const reply1 = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, {
      body: 'msg-3-reply-1',
      rootMessageId: topoId,
    });
    expect(reply1.status).toBe(201);

    // Responde à REPLY (não ao topo) — o servidor tem que normalizar para o root do root.
    const reply2 = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, {
      body: 'msg-3-reply-2-de-reply',
      rootMessageId: reply1.body.data.id,
    });
    expect(reply2.status).toBe(201); // nunca erro — é normalização, não recusa (D-03)

    const direto = await pool.query(`SELECT root_message_id FROM conversation_messages WHERE id = $1`, [reply2.body.data.id]);
    expect(direto.rows[0].root_message_id).toBe(topoId); // ROOT DO ROOT, nunca `reply1.id`

    const lista = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.autor);
    const linhaTopo = lista.body.data.messages.find((m: { id: string }) => m.id === topoId);
    expect(linhaTopo.replyCount).toBe(2); // as DUAS replies contam sob o MESMO topo
  });

  it('4. menção com uid inválido — 400', async () => {
    const res = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, {
      body: 'msg-4 <@e022-uid-que-nao-existe>',
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('MENTIONED_USER_NOT_FOUND');
  });

  it('5. editar própria — 200', async () => {
    const post = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, { body: 'msg-5' });
    const res = await chamar('PATCH', `/api/admin/patients/${PATIENT}/conversation/messages/${post.body.data.id}`, U.autor, {
      body: 'msg-5-editada',
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('6. editar alheia — 403 (D-04: só o autor, mesmo com a célula `update`)', async () => {
    const post = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, { body: 'msg-6' });
    const res = await chamar('PATCH', `/api/admin/patients/${PATIENT}/conversation/messages/${post.body.data.id}`, U.outro, {
      body: 'tentativa-de-outro',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('NOT_MESSAGE_AUTHOR');
  });

  it('7. apagar própria — 200 (soft delete: deleted_at preenchido, body_encrypted NULL)', async () => {
    const post = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, { body: 'msg-7' });
    const res = await chamar('DELETE', `/api/admin/patients/${PATIENT}/conversation/messages/${post.body.data.id}`, U.autor);
    expect(res.status).toBe(200);

    const direto = await pool.query(
      `SELECT deleted_at, body_encrypted FROM conversation_messages WHERE id = $1`,
      [post.body.data.id],
    );
    expect(direto.rows[0].deleted_at).not.toBeNull();
    expect(direto.rows[0].body_encrypted).toBeNull();
  });

  it('8. GET sem célula — 403; GET com célula (MESMA rota, MESMO run) — 200', async () => {
    const semCelula = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.semCelula);
    expect(semCelula.status).toBe(403);
    expect(semCelula.body.code).toBe('no_group');

    // Controle positivo NA MESMA rota: se os dois lados dessem 403, provaria stack quebrada, não ABAC.
    const comCelula = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.autor);
    expect(comCelula.status).toBe(200);
    expect(comCelula.body.success).toBe(true);
  });

  it('9. GET replies — 200: lista as replies de uma mensagem de TOPO, ordenadas por created_at ASC', async () => {
    const topo = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, { body: 'msg-9' });
    const topoId = topo.body.data.id;
    const reply1 = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, {
      body: 'msg-9-reply-1',
      rootMessageId: topoId,
    });
    const reply2 = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, {
      body: 'msg-9-reply-2',
      rootMessageId: topoId,
    });

    const res = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation/messages/${topoId}/replies`, U.autor);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.messages.map((m: { id: string }) => m.id)).toEqual([reply1.body.data.id, reply2.body.data.id]);
  });

  it('10. GET replies — 400 quando :mid É uma reply (thread de 1 nível, D-03)', async () => {
    const topo = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, { body: 'msg-10' });
    const reply = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, {
      body: 'msg-10-reply',
      rootMessageId: topo.body.data.id,
    });

    const res = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation/messages/${reply.body.data.id}/replies`, U.autor);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('ROOT_MESSAGE_IS_REPLY');
  });

  it('11. GET replies sem célula — 403; GET replies com célula (MESMA rota, MESMO run) — 200', async () => {
    const topo = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, { body: 'msg-11' });
    const topoId = topo.body.data.id;
    const rota = `/api/admin/patients/${PATIENT}/conversation/messages/${topoId}/replies`;

    const semCelula = await chamar('GET', rota, U.semCelula);
    expect(semCelula.status).toBe(403);
    expect(semCelula.body.code).toBe('no_group');

    // Controle positivo NA MESMA rota: se os dois lados dessem 403, provaria stack quebrada, não ABAC.
    const comCelula = await chamar('GET', rota, U.autor);
    expect(comCelula.status).toBe(200);
    expect(comCelula.body.success).toBe(true);
  });

  it('12. mentions — mensagem com <@uid> volta com mentions preenchido na listagem E na leitura de replies', async () => {
    const topo = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, {
      body: `msg-12 <@${U.outro}>`,
    });
    expect(topo.status).toBe(201);
    const topoId = topo.body.data.id;

    const lista = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.autor);
    const linhaTopo = lista.body.data.messages.find((m: { id: string }) => m.id === topoId);
    expect(linhaTopo.mentions).toEqual([U.outro]);

    const reply = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, {
      body: `msg-12-reply <@${U.outro}>`,
      rootMessageId: topoId,
    });
    expect(reply.status).toBe(201);

    const replies = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation/messages/${topoId}/replies`, U.autor);
    expect(replies.body.data.messages[0].mentions).toEqual([U.outro]);
  });

  it('12b. item 5a — authorDisplayName/mentionDisplayNames vêm do SERVIDOR, sem depender de cache do navegador (F19/F20)', async () => {
    const topo = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, {
      body: `msg-12b <@${U.outro}>`,
    });
    expect(topo.status).toBe(201);
    const topoId = topo.body.data.id;

    // U.outro nunca buscou nada no autocomplete desta sessão (não há "sessão de navegador" nenhuma
    // aqui — é HTTP puro) — se o nome aparecesse só por cache do cliente, sairia null/uid cru.
    const lista = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.outro);
    const linhaTopo = lista.body.data.messages.find((m: { id: string }) => m.id === topoId);
    expect(linhaTopo.authorDisplayName).toBe('Autor'); // display_name de U.autor, resolvido por JOIN
    expect(linhaTopo.mentionDisplayNames).toEqual({ [U.outro]: 'Outro' });

    const reply = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.outro, {
      body: `msg-12b-reply <@${U.autor}>`,
      rootMessageId: topoId,
    });
    expect(reply.status).toBe(201);

    const replies = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation/messages/${topoId}/replies`, U.autor);
    expect(replies.body.data.messages[0].authorDisplayName).toBe('Outro');
    expect(replies.body.data.messages[0].mentionDisplayNames).toEqual({ [U.autor]: 'Autor' });
  });

  it('13. GET replies com :mid de OUTRO paciente — 404 (nunca vaza a thread alheia; fecho da classe do gate revisao-pr)', async () => {
    const topoOutro = await chamar('POST', `/api/admin/patients/${PATIENT_OUTRO}/conversation/messages`, U.autor, {
      body: 'msg-13-de-outro-paciente',
    });
    expect(topoOutro.status).toBe(201);
    const topoOutroId = topoOutro.body.data.id;

    // `:id` da URL é PATIENT (não PATIENT_OUTRO); `:mid` é uma mensagem de TOPO real, com célula
    // válida e requester com a célula certa — o ÚNICO jeito de dar 404 é o cruzamento `:mid`×`:id`
    // (`assertMessageBelongsToPatientConversation`) recusando por conversa errada.
    const res = await chamar(
      'GET',
      `/api/admin/patients/${PATIENT}/conversation/messages/${topoOutroId}/replies`,
      U.autor,
    );
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Message not found');

    // Controle positivo: a MESMA mensagem, pela rota do PRÓPRIO paciente, funciona (200).
    const controle = await chamar(
      'GET',
      `/api/admin/patients/${PATIENT_OUTRO}/conversation/messages/${topoOutroId}/replies`,
      U.autor,
    );
    expect(controle.status).toBe(200);
  });

  it('14. POST com rootMessageId de OUTRO paciente — 404, e NENHUMA linha nova pendurada na thread alheia (vazamento cross-paciente do vetor BODY, achado NOVO fora do gate revisao-pr original)', async () => {
    // Mensagem de TOPO real, do PATIENT_OUTRO — é o "root" que o atacante vai citar pelo BODY.
    const topoOutro = await chamar('POST', `/api/admin/patients/${PATIENT_OUTRO}/conversation/messages`, U.autor, {
      body: 'msg-14-de-outro-paciente',
    });
    expect(topoOutro.status).toBe(201);
    const topoOutroId = topoOutro.body.data.id;

    // Contagem ANTES: quantas replies essa thread (de OUTRO paciente) já tem — prova por
    // CONTAGEM, não só pelo código HTTP (contagem zero é "não medi", nunca "sucesso").
    const antes = await pool.query(
      `SELECT COUNT(*)::int AS n FROM conversation_messages WHERE root_message_id = $1`,
      [topoOutroId],
    );
    expect(antes.rows[0].n).toBe(0);

    // `:id` da URL é PATIENT (não PATIENT_OUTRO); `rootMessageId` no BODY aponta pra mensagem de
    // OUTRO paciente. Sem o guard em `PostMessageUseCase.resolveRoot`, isto grava uma reply com
    // `conversation_id = PATIENT` e `root_message_id = topoOutroId` — o GET replies do
    // PATIENT_OUTRO devolveria essa reply, vazando corpo de mensagem entre pacientes.
    const ataque = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, {
      body: 'msg-14-tentativa-de-reply-cross-paciente',
      rootMessageId: topoOutroId,
    });
    expect(ataque.status).toBe(404);
    expect(ataque.body.success).toBe(false);
    expect(ataque.body.code).toBe('MESSAGE_NOT_FOUND');

    // Contagem DEPOIS: MESMA — nenhuma linha nova pendurada na thread do paciente alheio.
    const depois = await pool.query(
      `SELECT COUNT(*)::int AS n FROM conversation_messages WHERE root_message_id = $1`,
      [topoOutroId],
    );
    expect(depois.rows[0].n).toBe(0);

    // Prova adicional: a rota de replies do PATIENT_OUTRO (dono real do root) continua vazia —
    // é o endpoint que vazaria o corpo cifrado da tentativa, se ela tivesse sido gravada.
    const replies = await chamar(
      'GET',
      `/api/admin/patients/${PATIENT_OUTRO}/conversation/messages/${topoOutroId}/replies`,
      U.autor,
    );
    expect(replies.status).toBe(200);
    expect(replies.body.data.messages).toEqual([]);
  });

  it('15. POST com fileIds contendo um uuid INEXISTENTE em stored_files — 400 (nunca 500), e NENHUMA mensagem gravada (achado alto do gate revisao-pr, Tarefa 3: id arbitrário virava FK violation → 500, e o ON DELETE RESTRICT de conversation_message_attachments tornaria o arquivo indeletável)', async () => {
    const antes = await pool.query(`SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id IS NOT NULL`);

    const res = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, {
      body: 'msg-15-fileId-inexistente',
      fileIds: ['00000000-0000-0000-0000-000000000015'],
    });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('ATTACHED_FILE_NOT_FOUND');

    // Contagem: nenhuma linha nova em conversation_messages — a recusa aconteceu ANTES do INSERT
    // da mensagem (não é rollback de FK violation depois de já ter gravado o corpo).
    const depois = await pool.query(`SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id IS NOT NULL`);
    expect(depois.rows[0].n).toBe(antes.rows[0].n);
  });

  it('16. GET conversa — unreadCount conta mensagem de OUTRO autor (TOPO e REPLY), nunca a própria, quando o ator nunca leu (D-11, Bloco 2)', async () => {
    // Baseline por DELTA (nunca contagem absoluta): os testes 1-15 já postaram várias mensagens
    // como U.autor nesta mesma conversa (nenhuma delas de U.outro) — a régua é "quanto o
    // unreadCount SUBIU", não um número fixo (contagem zero é 'não medi', nunca 'sucesso').
    const antes = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.autor);
    expect(antes.status).toBe(200);
    expect(antes.body.data.lastReadAt).toBeNull(); // nenhum teste anterior chamou PUT read-mark

    // Mensagem PRÓPRIA (U.autor) — nunca deve contar, mesmo sendo a mais recente.
    const propria = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.autor, { body: 'msg-16-propria' });
    expect(propria.status).toBe(201);

    // Mensagem de TOPO de OUTRO autor — conta.
    const topoOutro = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.outro, { body: 'msg-16-outro-topo' });
    expect(topoOutro.status).toBe(201);

    // REPLY de OUTRO autor na thread acima — TAMBÉM conta (D-11: "topo + reply", o caso que mais escapa).
    const replyOutro = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.outro, {
      body: 'msg-16-outro-reply',
      rootMessageId: topoOutro.body.data.id,
    });
    expect(replyOutro.status).toBe(201);

    const depois = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.autor);
    expect(depois.status).toBe(200);
    // +2: o topo e a reply de U.outro — a própria mensagem de U.autor não move o contador.
    expect(depois.body.data.unreadCount).toBe(antes.body.data.unreadCount + 2);
    expect(depois.body.data.lastReadAt).toBeNull();
  });

  it('17. PUT read-mark — zera unreadCount; mensagem POSTERIOR à marca volta a contar (D-11, Bloco 2)', async () => {
    const marcar = await chamar('PUT', `/api/admin/patients/${PATIENT}/conversation/read-mark`, U.autor);
    expect(marcar.status).toBe(200);
    expect(marcar.body.success).toBe(true);

    const logoDepoisDaMarca = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.autor);
    expect(logoDepoisDaMarca.status).toBe(200);
    expect(logoDepoisDaMarca.body.data.unreadCount).toBe(0); // caiu para 0 — inclui o que o teste 16 deixou pendente
    expect(logoDepoisDaMarca.body.data.lastReadAt).not.toBeNull();

    // Mensagem de OUTRO autor gravada DEPOIS da marca — created_at > last_read_at, volta a contar.
    const posMarca = await chamar('POST', `/api/admin/patients/${PATIENT}/conversation/messages`, U.outro, { body: 'msg-17-pos-marca' });
    expect(posMarca.status).toBe(201);

    const final = await chamar('GET', `/api/admin/patients/${PATIENT}/conversation`, U.autor);
    expect(final.status).toBe(200);
    expect(final.body.data.unreadCount).toBe(1);
  });
});
