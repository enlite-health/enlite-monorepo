/**
 * patient-chat-ids.e2e.test.ts
 *
 * E2E dos Chat IDs do paciente POR PAPEL (ClickUp 86ajy1jhz; antes 86ajy0859 /
 * 86ajy085a):
 *
 *   PUT /api/admin/patients/:id/chat-ids          — grava N papéis
 *   GET /api/admin/patients/:id                   — devolve o mapa gravado
 *   GET /api/admin/patients/:id/chat-candidates   — grupos ranqueados
 *   GET /api/admin/patients/chat-map              — o mapa em massa (zero PII)
 *
 * SEM MOCK: Postgres real (migration 261 aplicada pelo runner do container) e a
 * nossa API real via HTTP. As constraints da migration são exercidas por SQL
 * direto — é o tipo de invariante que unit com pool falso nunca pega.
 *
 * ÚNICA peça substituída: a API do PERISKOPE, por um servidor HTTP local
 * (`helpers/periskopeStubServer.ts`) que responde no formato real capturado de
 * produção. Teste não fala com serviço externo vivo — regra dura do repo (há
 * incidente registrado).
 *
 * ⚠️ Logo, este arquivo prova O NOSSO LADO, não o contrato com o fornecedor.
 * A validação de que o Periskope não mudou o envelope/os campos é feita por uma
 * sonda ao vivo separada, somente leitura: `scripts/probe-periskope-chats.ts`.
 * Se o Periskope mudar, é a sonda que quebra — não este teste.
 *
 * NÃO exige preparo manual: o `docker-compose.test.yml` já sobe a stack com a
 * flag ligada e o `PERISKOPE_BASE_URL` apontando para o stub local, mais o
 * `extra_hosts` que o Linux do CI precisa para achar o host.
 *
 * (Antes era preciso exportar 4 variáveis à mão. O teste passava na máquina de
 * quem sabia disso e falhava no CI, que não sabia — e o CI é justamente quem
 * precisa do gate. Teste que depende de alguém lembrar não é gate.)
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import { startPeriskopeStub, type PeriskopeStub, type StubChat } from './helpers/periskopeStubServer';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const STUB_PORT = Number(process.env.PERISKOPE_STUB_PORT ?? 9911);

const GROUP_FAMILY = '120363090000000001@g.us';
const GROUP_PROVIDERS = '120363090000000002@g.us';
const GROUP_OTHER = '5491190000000-1600000009@g.us';
const GROUP_PLAN = '120363090000000003@g.us';
const CHAT_ONE_TO_ONE = '5491162180721@c.us';

const STUB_CHATS: StubChat[] = [
  { chat_id: GROUP_FAMILY, chat_name: 'Flia Zortea Testchatid', chat_type: 'group', member_count: 6 },
  { chat_id: GROUP_PROVIDERS, chat_name: 'Prestadores Zortea Testchatid', chat_type: 'group', member_count: 11 },
  { chat_id: GROUP_OTHER, chat_name: 'Flia Nomeoutro Diferente', chat_type: 'group', member_count: 4 },
  // 1-1 no payload: a nossa camada tem de descartar mesmo que o Periskope mande.
  { chat_id: CHAT_ONE_TO_ONE, chat_name: 'Zortea Testchatid', chat_type: 'user', member_count: null },
];

describe('Patient chat IDs (Periskope) — E2E', () => {
  const api = createApiClient();
  let pool: Pool;
  let stub: PeriskopeStub;
  let staffToken: string;
  let workerToken: string;
  let patientA: string;
  let patientB: string;
  const insertedIds: string[] = [];

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  async function seedPatient(
    firstName: string,
    lastName: string,
    opts: { deleted?: boolean } = {},
  ): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, phone_whatsapp,
                             document_number, country, status, deleted_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'AR', 'ACTIVE', $7)`,
      [
        id, `e2e-chatid-${id}`, firstName, lastName,
        '+5491100000123', 'DOC-E2E-CHATID',
        opts.deleted ? new Date() : null,
      ],
    );
    insertedIds.push(id);
    return id;
  }

  /** O que está DE FATO no banco, lido da tabela de vínculos. */
  async function readChatIds(id: string): Promise<Record<string, string>> {
    const r = await pool.query<{ role: string; chat_id: string }>(
      'SELECT role, chat_id FROM patient_chat_ids WHERE patient_id = $1 ORDER BY role',
      [id],
    );
    return Object.fromEntries(r.rows.map(row => [row.role, row.chat_id]));
  }

  /** Grava direto no banco, pulando a API — para exercitar as constraints. */
  function insertLink(patientId: string, role: string, chatId: string, exclusive = true) {
    return pool.query(
      'INSERT INTO patient_chat_ids (patient_id, role, chat_id, is_exclusive) VALUES ($1,$2,$3,$4)',
      [patientId, role, chatId, exclusive],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    stub = await startPeriskopeStub(STUB_CHATS, STUB_PORT);
    await waitForBackend(api);

    staffToken = await getMockToken(api, {
      uid: 'chatid-staff-e2e', email: 'chatid-staff@e2e.local', role: 'admin',
    });
    workerToken = await getMockToken(api, {
      uid: 'chatid-worker-e2e', email: 'chatid-worker@e2e.local', role: 'worker',
    });

    patientA = await seedPatient('Zortea', 'Testchatid');
    patientB = await seedPatient('Outro', 'Pacienteid');
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await pool.query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [insertedIds]);
    }
    await pool.end();
    await stub.close();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM patient_chat_ids WHERE patient_id = ANY($1::uuid[])', [insertedIds]);
  });

  // ── Migration 261: as constraints mordem no banco real ─────────────────────

  describe('constraints da migration 261 (SQL direto)', () => {
    it('1. a tabela existe com as colunas e a nulidade esperadas', async () => {
      const r = await pool.query(
        `SELECT column_name, data_type, character_maximum_length, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'patient_chat_ids'
            AND column_name IN ('patient_id','role','chat_id','is_exclusive')
          ORDER BY column_name`,
      );
      expect(r.rows).toEqual([
        { column_name: 'chat_id', data_type: 'character varying', character_maximum_length: 64, is_nullable: 'NO' },
        { column_name: 'is_exclusive', data_type: 'boolean', character_maximum_length: null, is_nullable: 'NO' },
        { column_name: 'patient_id', data_type: 'uuid', character_maximum_length: null, is_nullable: 'NO' },
        { column_name: 'role', data_type: 'character varying', character_maximum_length: 32, is_nullable: 'NO' },
      ]);
    });

    it('2. CHECK recusa conversa 1-1 (@c.us) em qualquer papel', async () => {
      for (const role of ['FAMILY', 'PROVIDERS', 'HEALTH_PLAN']) {
        await expect(insertLink(patientA, role, CHAT_ONE_TO_ONE)).rejects.toMatchObject({
          code: '23514', constraint: 'patient_chat_ids_is_group',
        });
      }
    });

    it('3. CHECK recusa papel fora da FORMA de enum (minúsculo, espaço, hífen)', async () => {
      for (const bad of ['family', 'HEALTH PLAN', 'HEALTH-PLAN', '1FAMILY']) {
        await expect(insertLink(patientA, bad, GROUP_FAMILY)).rejects.toMatchObject({
          code: '23514', constraint: 'patient_chat_ids_role_shape',
        });
      }
    });

    it('4. UNIQUE recusa o mesmo grupo em dois papéis do MESMO paciente', async () => {
      await insertLink(patientA, 'FAMILY', GROUP_FAMILY);
      await expect(insertLink(patientA, 'PROVIDERS', GROUP_FAMILY)).rejects.toMatchObject({
        code: '23505', constraint: 'patient_chat_ids_one_role_per_chat',
      });
    });

    it('5. ÍNDICE ÚNICO impede o mesmo grupo em dois pacientes (a trava da Candela)', async () => {
      await insertLink(patientA, 'FAMILY', GROUP_FAMILY);
      await expect(insertLink(patientB, 'FAMILY', GROUP_FAMILY)).rejects.toMatchObject({ code: '23505' });
      // e também no papel CRUZADO, que na migration 260 o banco não cobria
      await expect(insertLink(patientB, 'PROVIDERS', GROUP_FAMILY)).rejects.toMatchObject({ code: '23505' });
    });

    it('6. a trava é do PAPEL: linha NÃO exclusiva pode repetir o grupo em dois pacientes', async () => {
      // É o cenário do grupo do plano de saúde, se o Marcel responder que ele é
      // um por plano. Aqui o banco já aceita — falta só virar o catálogo.
      await insertLink(patientA, 'HEALTH_PLAN', GROUP_PLAN, false);
      await expect(insertLink(patientB, 'HEALTH_PLAN', GROUP_PLAN, false)).resolves.toBeDefined();
    });

    it('7. UNIQUE (patient_id, role) — um paciente não tem dois grupos no mesmo papel', async () => {
      await insertLink(patientA, 'FAMILY', GROUP_FAMILY);
      await expect(insertLink(patientA, 'FAMILY', GROUP_OTHER)).rejects.toMatchObject({
        code: '23505', constraint: 'patient_chat_ids_one_per_role',
      });
    });

    it('8. aceita os dois formatos reais de chat_id de grupo, e um papel NOVO sem migration', async () => {
      await insertLink(patientA, 'FAMILY', GROUP_FAMILY);      // 18 dígitos
      await insertLink(patientA, 'PROVIDERS', GROUP_OTHER);    // criador-timestamp
      // MANAGEMENT não existe no catálogo do código — e o banco aceita, que é
      // exatamente o requisito: papel novo não pode exigir migration.
      await insertLink(patientA, 'MANAGEMENT', GROUP_PLAN);

      expect(await readChatIds(patientA)).toEqual({
        FAMILY: GROUP_FAMILY, PROVIDERS: GROUP_OTHER, MANAGEMENT: GROUP_PLAN,
      });
    });

    it('9. as colunas ANTIGAS continuam no banco (expand/contract: nada foi derrubado)', async () => {
      const r = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'patients'
            AND column_name IN ('family_chat_id','providers_chat_id')
          ORDER BY column_name`,
      );
      expect(r.rows.map(x => x.column_name)).toEqual(['family_chat_id', 'providers_chat_id']);
    });

    it('10. a migration de dados é IDEMPOTENTE — re-rodar não duplica nem estoura', async () => {
      await pool.query('UPDATE patients SET family_chat_id = $2 WHERE id = $1', [patientA, GROUP_FAMILY]);
      try {
        const copy = `INSERT INTO patient_chat_ids (patient_id, role, chat_id, is_exclusive)
                      SELECT id, 'FAMILY', family_chat_id, TRUE FROM patients
                       WHERE family_chat_id IS NOT NULL AND deleted_at IS NULL
                      ON CONFLICT DO NOTHING`;
        await pool.query(copy);
        await pool.query(copy); // segunda vez: sem erro, sem linha nova
        const n = await pool.query<{ n: string }>(
          'SELECT COUNT(*)::text AS n FROM patient_chat_ids WHERE patient_id = $1',
          [patientA],
        );
        expect(Number(n.rows[0].n)).toBe(1);
        expect(await readChatIds(patientA)).toEqual({ FAMILY: GROUP_FAMILY });
      } finally {
        await pool.query('UPDATE patients SET family_chat_id = NULL WHERE id = $1', [patientA]);
      }
    });

    it('11. apagar o paciente leva os vínculos junto (CASCADE) — grupo não fica preso', async () => {
      const doomed = await seedPatient('Apagavel', 'Cascade');
      await insertLink(doomed, 'FAMILY', GROUP_PLAN);
      await pool.query('DELETE FROM patients WHERE id = $1', [doomed]);

      const left = await pool.query('SELECT 1 FROM patient_chat_ids WHERE patient_id = $1', [doomed]);
      expect(left.rowCount).toBe(0);
      // e o grupo volta a estar livre para outro paciente
      await expect(insertLink(patientA, 'FAMILY', GROUP_PLAN)).resolves.toBeDefined();
    });
  });

  // ── PUT /chat-ids ──────────────────────────────────────────────────────────

  describe('PUT /api/admin/patients/:id/chat-ids', () => {
    it('12. grava os TRÊS papéis de uma vez e devolve 200', async () => {
      const res = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { FAMILY: GROUP_FAMILY, PROVIDERS: GROUP_PROVIDERS, HEALTH_PLAN: GROUP_PLAN } },
        authHeaders(staffToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.chatIds).toEqual({
        FAMILY: GROUP_FAMILY, PROVIDERS: GROUP_PROVIDERS, HEALTH_PLAN: GROUP_PLAN,
      });
      expect(await readChatIds(patientA)).toEqual({
        FAMILY: GROUP_FAMILY, PROVIDERS: GROUP_PROVIDERS, HEALTH_PLAN: GROUP_PLAN,
      });
    });

    it('13. GET /patients/:id devolve o mapa gravado (o join da Candela)', async () => {
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { FAMILY: GROUP_FAMILY, HEALTH_PLAN: GROUP_PLAN } },
        authHeaders(staffToken),
      );

      const res = await api.get(`/api/admin/patients/${patientA}`, authHeaders(staffToken));
      expect(res.status).toBe(200);
      expect(res.data.data.chatIds).toEqual({ FAMILY: GROUP_FAMILY, HEALTH_PLAN: GROUP_PLAN });
    });

    it('14. EXPAND: o detalhe ainda traz os aliases antigos (bundle em cache não mente)', async () => {
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { FAMILY: GROUP_FAMILY, PROVIDERS: GROUP_PROVIDERS } },
        authHeaders(staffToken),
      );

      const res = await api.get(`/api/admin/patients/${patientA}`, authHeaders(staffToken));
      expect(res.data.data.familyChatId).toBe(GROUP_FAMILY);
      expect(res.data.data.providersChatId).toBe(GROUP_PROVIDERS);
    });

    it('15. papel AUSENTE do body fica INALTERADO (versão antiga não apaga o que não conhece)', async () => {
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { FAMILY: GROUP_FAMILY, HEALTH_PLAN: GROUP_PLAN } },
        authHeaders(staffToken),
      );

      // body LEGADO da migration 260: só conhece família e prestadores
      const legacy = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { familyChatId: GROUP_FAMILY, providersChatId: GROUP_PROVIDERS },
        authHeaders(staffToken),
      );

      expect(legacy.status).toBe(200);
      expect(await readChatIds(patientA)).toEqual({
        FAMILY: GROUP_FAMILY, PROVIDERS: GROUP_PROVIDERS, HEALTH_PLAN: GROUP_PLAN,
      });
    });

    it('16. null desvincula só aquele papel, e libera o grupo para outro paciente', async () => {
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { FAMILY: GROUP_FAMILY, PROVIDERS: GROUP_PROVIDERS } },
        authHeaders(staffToken),
      );

      const clear = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { FAMILY: null } },
        authHeaders(staffToken),
      );
      expect(clear.status).toBe(200);
      expect(await readChatIds(patientA)).toEqual({ PROVIDERS: GROUP_PROVIDERS });

      const reuse = await api.put(
        `/api/admin/patients/${patientB}/chat-ids`,
        { chatIds: { FAMILY: GROUP_FAMILY } },
        authHeaders(staffToken),
      );
      expect(reuse.status).toBe(200);
    });

    it('17. 409 quando o grupo já é de outro paciente no MESMO papel', async () => {
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { FAMILY: GROUP_FAMILY } },
        authHeaders(staffToken),
      );

      const res = await api.put(
        `/api/admin/patients/${patientB}/chat-ids`,
        { chatIds: { FAMILY: GROUP_FAMILY } },
        authHeaders(staffToken),
      );

      expect(res.status).toBe(409);
      expect(res.data.code).toBe('CHAT_ID_ALREADY_LINKED');
      expect(res.data.details.conflicts).toEqual([
        { chatId: GROUP_FAMILY, patientId: patientA, role: 'FAMILY', exclusive: true },
      ]);
      expect(await readChatIds(patientB)).toEqual({});
    });

    it('18. 409 na colisão CRUZADA — basta UM lado ser exclusivo', async () => {
      // HEALTH_PLAN é compartilhável no catálogo (27 pagadores), mas o grupo
      // alvo já é a FAMÍLIA de outro paciente — e esse lado é exclusivo.
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { FAMILY: GROUP_FAMILY } },
        authHeaders(staffToken),
      );

      const res = await api.put(
        `/api/admin/patients/${patientB}/chat-ids`,
        { chatIds: { HEALTH_PLAN: GROUP_FAMILY } },
        authHeaders(staffToken),
      );

      expect(res.status).toBe(409);
      expect(res.data.details.conflicts[0]).toMatchObject({ role: 'FAMILY', patientId: patientA });
    });

    it('19. 400 para conversa 1-1 (@c.us) — nunca chega ao banco', async () => {
      const res = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { FAMILY: CHAT_ONE_TO_ONE } },
        authHeaders(staffToken),
      );
      expect(res.status).toBe(400);
      expect(await readChatIds(patientA)).toEqual({});
    });

    it('20. 400 para o mesmo grupo em dois papéis do mesmo paciente', async () => {
      const res = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { FAMILY: GROUP_FAMILY, HEALTH_PLAN: GROUP_FAMILY } },
        authHeaders(staffToken),
      );
      expect(res.status).toBe(400);
      expect(await readChatIds(patientA)).toEqual({});
    });

    it('21. 400 para PAPEL fora do CATÁLOGO, com código próprio', async () => {
      // ⚠️ Esta recusa MUDOU DE LUGAR na migration 262: quais papéis existem é
      // dado, não schema, então quem barra é o serviço (depois de ler o
      // catálogo) e não mais o Zod. O código próprio existe para a tela poder
      // dizer "esse papel não está cadastrado" em vez de um erro de validação.
      const desconhecido = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { NEIGHBOURS: GROUP_FAMILY } },
        authHeaders(staffToken),
      );
      expect(desconhecido.status).toBe(400);
      expect(desconhecido.data.code).toBe('UNKNOWN_CHAT_ROLE');
      expect(desconhecido.data.details.roles).toEqual(['NEIGHBOURS']);
      expect(await readChatIds(patientA)).toEqual({});

      // A FORMA da chave continua sendo lei do schema.
      const bad = [
        { chatIds: { family: GROUP_FAMILY } },
        { chatIds: { 'HEALTH PLAN': GROUP_FAMILY } },
        { chatIds: {}, foo: 'x' },
        {},
      ];
      for (const body of bad) {
        const res = await api.put(`/api/admin/patients/${patientA}/chat-ids`, body, authHeaders(staffToken));
        expect(res.status).toBe(400);
      }
      expect(await readChatIds(patientA)).toEqual({});
    });

    it('22. 404 para paciente inexistente', async () => {
      const res = await api.put(
        `/api/admin/patients/${randomUUID()}/chat-ids`,
        { chatIds: { FAMILY: GROUP_FAMILY } },
        authHeaders(staffToken),
      );
      expect(res.status).toBe(404);
    });

    it('23. 401 sem token e 403 para worker', async () => {
      const body = { chatIds: { FAMILY: null } };
      expect((await api.put(`/api/admin/patients/${patientA}/chat-ids`, body)).status).toBe(401);
      expect(
        (await api.put(`/api/admin/patients/${patientA}/chat-ids`, body, authHeaders(workerToken))).status,
      ).toBe(403);
    });
  });

  // ── GET /chat-candidates ───────────────────────────────────────────────────

  describe('GET /api/admin/patients/:id/chat-candidates', () => {
    it('24. devolve os grupos parecidos com o nome do paciente, ranqueados', async () => {
      const res = await api.get(
        `/api/admin/patients/${patientA}/chat-candidates`,
        authHeaders(staffToken),
      );

      expect(res.status).toBe(200);
      const ids = res.data.data.candidates.map((c: { chatId: string }) => c.chatId);
      expect(ids).toContain(GROUP_FAMILY);
      expect(ids).toContain(GROUP_PROVIDERS);
      // Grupo de outro nome não entra; conversa 1-1 nunca entra.
      expect(ids).not.toContain(GROUP_OTHER);
      expect(ids).not.toContain(CHAT_ONE_TO_ONE);
      expect(res.data.data.totalGroups).toBe(3); // só os @g.us do payload
    });

    it('25. a nossa API pede ao Periskope só GRUPOS, com Bearer e SEM escopo de número', async () => {
      // ⚠️ A AUSÊNCIA do `x-phone` é deliberada e é o ponto do teste.
      //
      // Esse header escopa a leitura a UM número conectado. A org tem mais de
      // um, e um grupo vinculável pode estar em qualquer um deles — com o
      // escopo ligado, os grupos dos outros números simplesmente não existiam
      // para nós, sem erro nenhum: a tela dizia "nenhum candidato".
      //
      // Medido contra a API real em 09/08: 774 grupos com o header, 788 brutos
      // sem ele (775 após deduplicar por chat_id). E é o que faz conectar um
      // número novo passar a valer — com o escopo, conectar não mudaria nada.
      //
      // LER é da org; ENVIAR é de um número. O `x-phone` continua obrigatório
      // nos serviços de envio, onde ele escolhe de qual número a mensagem sai.
      stub.requests.length = 0;
      await api.get(`/api/admin/patients/${patientA}/chat-candidates`, authHeaders(staffToken));

      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].path).toContain('chat_type=group');
      expect(stub.requests[0].auth).toMatch(/^Bearer /);
      expect(stub.requests[0].phone).toBeUndefined();
    });

    it('26. NENHUMA requisição de escrita chega ao Periskope em todo o fluxo', () => {
      const escritas = stub.requests.filter(r => !r.path.startsWith('/v1/chats'));
      expect(escritas).toEqual([]);
    });

    it('27. marca o candidato já preso a outro paciente', async () => {
      await api.put(
        `/api/admin/patients/${patientB}/chat-ids`,
        { chatIds: { FAMILY: GROUP_PROVIDERS } },
        authHeaders(staffToken),
      );

      const res = await api.get(
        `/api/admin/patients/${patientA}/chat-candidates`,
        authHeaders(staffToken),
      );

      const taken = res.data.data.candidates.find((c: { chatId: string }) => c.chatId === GROUP_PROVIDERS);
      const free = res.data.data.candidates.find((c: { chatId: string }) => c.chatId === GROUP_FAMILY);
      expect(taken.linkedToOtherPatient).toBe(true);
      expect(free.linkedToOtherPatient).toBe(false);
    });

    it('28. respeita o limit', async () => {
      const res = await api.get(
        `/api/admin/patients/${patientA}/chat-candidates?limit=1`,
        authHeaders(staffToken),
      );
      expect(res.data.data.candidates).toHaveLength(1);
    });

    it('29. 400 para limit fora da faixa', async () => {
      const res = await api.get(
        `/api/admin/patients/${patientA}/chat-candidates?limit=999`,
        authHeaders(staffToken),
      );
      expect(res.status).toBe(400);
    });

    it('30. 404 para paciente inexistente', async () => {
      const res = await api.get(
        `/api/admin/patients/${randomUUID()}/chat-candidates`,
        authHeaders(staffToken),
      );
      expect(res.status).toBe(404);
    });

    it('31. 401 sem token e 403 para worker', async () => {
      expect((await api.get(`/api/admin/patients/${patientA}/chat-candidates`)).status).toBe(401);
      expect(
        (await api.get(`/api/admin/patients/${patientA}/chat-candidates`, authHeaders(workerToken))).status,
      ).toBe(403);
    });

    it('32. fluxo completo: buscar → escolher → salvar → ler de volta', async () => {
      const search = await api.get(
        `/api/admin/patients/${patientA}/chat-candidates`,
        authHeaders(staffToken),
      );
      const candidates = search.data.data.candidates as Array<{ chatId: string; chatName: string }>;

      // O humano escolhe; o sistema não decide papel.
      const familia = candidates.find(c => c.chatName.startsWith('Flia'))!;
      const prestadores = candidates.find(c => c.chatName.startsWith('Prestadores'))!;

      const save = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { FAMILY: familia.chatId, PROVIDERS: prestadores.chatId } },
        authHeaders(staffToken),
      );
      expect(save.status).toBe(200);

      const detail = await api.get(`/api/admin/patients/${patientA}`, authHeaders(staffToken));
      expect(detail.data.data.chatIds).toEqual({
        FAMILY: GROUP_FAMILY, PROVIDERS: GROUP_PROVIDERS,
      });
    });
  });

  // ── GET /chat-map — a ponte de três pontas, em massa ───────────────────────

  describe('GET /api/admin/patients/chat-map', () => {
    let deletedPatient: string;

    beforeAll(async () => {
      deletedPatient = await seedPatient('Apagado', 'Softdeleted', { deleted: true });
    });

    async function link(patientId: string, family: string | null, providers: string | null) {
      const res = await api.put(
        `/api/admin/patients/${patientId}/chat-ids`,
        { chatIds: { FAMILY: family, PROVIDERS: providers, HEALTH_PLAN: null } },
        authHeaders(staffToken),
      );
      expect(res.status).toBe(200);
    }

    it('33. a rota NÃO é capturada por /patients/:id (é estática e vem antes)', async () => {
      const res = await api.get('/api/admin/patients/chat-map', authHeaders(staffToken));
      // Se o Express tratasse 'chat-map' como :id, seria 400 de UUID inválido.
      expect(res.status).toBe(200);
      expect(res.data.data).toHaveProperty('patients');
    });

    it('34. devolve as TRÊS pontas juntas: patientId + clickupTaskId + os papéis', async () => {
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { FAMILY: GROUP_FAMILY, PROVIDERS: GROUP_PROVIDERS, HEALTH_PLAN: GROUP_PLAN } },
        authHeaders(staffToken),
      );

      const res = await api.get(
        '/api/admin/patients/chat-map?filter=linked&limit=1000',
        authHeaders(staffToken),
      );

      expect(res.status).toBe(200);
      const mine = res.data.data.patients.find((p: { patientId: string }) => p.patientId === patientA);
      expect(mine).toEqual({
        patientId: patientA,
        clickupTaskId: expect.stringContaining('e2e-chatid-'),
        chatIds: {
          FAMILY: GROUP_FAMILY,
          PROVIDERS: GROUP_PROVIDERS,
          HEALTH_PLAN: GROUP_PLAN,
        },
      });
    });

    it('35. ZERO PII no payload — nem nome, nem telefone, nem documento', async () => {
      await link(patientA, GROUP_FAMILY, GROUP_PROVIDERS);

      const res = await api.get(
        '/api/admin/patients/chat-map?filter=all&limit=1000',
        authHeaders(staffToken),
      );

      // (a) nenhuma CHAVE de PII em nenhuma linha
      const PII_KEYS = [
        'firstName', 'lastName', 'phoneWhatsapp', 'documentNumber', 'birthDate',
        'first_name', 'last_name', 'phone_whatsapp', 'document_number', 'sex',
        'contactEmail', 'diagnosis',
      ];
      for (const row of res.data.data.patients) {
        expect(Object.keys(row).sort()).toEqual(['chatIds', 'clickupTaskId', 'patientId']);
        for (const k of PII_KEYS) expect(row).not.toHaveProperty(k);
      }

      // (b) nenhum VALOR de PII semeado aparece no corpo cru da resposta
      const raw = JSON.stringify(res.data);
      expect(raw).not.toContain('Zortea');
      expect(raw).not.toContain('+5491100000123');
      expect(raw).not.toContain('DOC-E2E-CHATID');
    });

    it('36. filter=unlinked devolve a fila de trabalho do backfill', async () => {
      await link(patientA, GROUP_FAMILY, null);
      await link(patientB, null, null);

      const res = await api.get(
        '/api/admin/patients/chat-map?filter=unlinked&limit=1000',
        authHeaders(staffToken),
      );

      const ids = res.data.data.patients.map((p: { patientId: string }) => p.patientId);
      expect(ids).toContain(patientB);
      expect(ids).not.toContain(patientA);
      for (const row of res.data.data.patients) {
        expect(row.chatIds).toEqual({});
      }
    });

    it('37. paciente soft-deleted nunca aparece, em nenhum filtro', async () => {
      for (const filter of ['linked', 'unlinked', 'all']) {
        const res = await api.get(
          `/api/admin/patients/chat-map?filter=${filter}&limit=1000`,
          authHeaders(staffToken),
        );
        const ids = res.data.data.patients.map((p: { patientId: string }) => p.patientId);
        expect(ids).not.toContain(deletedPatient);
      }
    });

    it('38. DIREÇÃO REVERSA: chatId devolve o paciente e o papel', async () => {
      await link(patientA, GROUP_FAMILY, GROUP_PROVIDERS);

      const familia = await api.get(
        `/api/admin/patients/chat-map?chatId=${encodeURIComponent(GROUP_FAMILY)}`,
        authHeaders(staffToken),
      );
      expect(familia.status).toBe(200);
      expect(familia.data.data.patients).toEqual([
        {
          patientId: patientA,
          clickupTaskId: expect.any(String),
          chatIds: { FAMILY: GROUP_FAMILY, PROVIDERS: GROUP_PROVIDERS },
          matchedRole: 'FAMILY',
        },
      ]);

      const prestadores = await api.get(
        `/api/admin/patients/chat-map?chatId=${encodeURIComponent(GROUP_PROVIDERS)}`,
        authHeaders(staffToken),
      );
      expect(prestadores.data.data.patients[0].matchedRole).toBe('PROVIDERS');
    });

    it('39. reverso de grupo sem dono devolve lista vazia, não erro', async () => {
      const res = await api.get(
        `/api/admin/patients/chat-map?chatId=${encodeURIComponent(GROUP_OTHER)}`,
        authHeaders(staffToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.data).toMatchObject({ patients: [], total: 0, hasMore: false });
    });

    it('40. paginação: total é o do recorte e hasMore acompanha', async () => {
      await link(patientA, GROUP_FAMILY, null);
      await link(patientB, GROUP_PROVIDERS, null);

      const page1 = await api.get(
        '/api/admin/patients/chat-map?filter=linked&limit=1&offset=0',
        authHeaders(staffToken),
      );
      expect(page1.data.data.patients).toHaveLength(1);
      expect(page1.data.data.total).toBeGreaterThanOrEqual(2);
      expect(page1.data.data.hasMore).toBe(true);

      const page2 = await api.get(
        `/api/admin/patients/chat-map?filter=linked&limit=1&offset=${page1.data.data.total - 1}`,
        authHeaders(staffToken),
      );
      expect(page2.data.data.hasMore).toBe(false);
      // páginas diferentes não repetem paciente (ordem estável por id)
      expect(page2.data.data.patients[0].patientId)
        .not.toBe(page1.data.data.patients[0].patientId);
    });

    it('41. 400 para chatId 1-1, filter inválido, limit fora da faixa e campo desconhecido', async () => {
      const bad = [
        'chatId=5491162180721%40c.us',
        'filter=todos',
        'limit=5000',
        'offset=-1',
        'foo=bar',
      ];
      for (const qs of bad) {
        const res = await api.get(`/api/admin/patients/chat-map?${qs}`, authHeaders(staffToken));
        expect(res.status).toBe(400);
      }
    });

    it('42. REVERSA do TERCEIRO papel: o grupo do plano acha o paciente', async () => {
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { HEALTH_PLAN: GROUP_PLAN } },
        authHeaders(staffToken),
      );

      const res = await api.get(
        `/api/admin/patients/chat-map?chatId=${encodeURIComponent(GROUP_PLAN)}`,
        authHeaders(staffToken),
      );
      expect(res.data.data.patients).toEqual([
        {
          patientId: patientA,
          clickupTaskId: expect.any(String),
          chatIds: { HEALTH_PLAN: GROUP_PLAN },
          matchedRole: 'HEALTH_PLAN',
        },
      ]);
    });

    it('43. papel que o CÓDIGO não conhece atravessa a leitura (mapa e reversa)', async () => {
      // A leitura tem de ser aberta: o banco aceita qualquer papel na forma de
      // enum, então uma linha de uma versão mais nova não pode derrubar o mapa.
      await insertLink(patientA, 'MANAGEMENT', GROUP_PLAN);

      const mapa = await api.get(
        '/api/admin/patients/chat-map?filter=linked&limit=1000',
        authHeaders(staffToken),
      );
      const mine = mapa.data.data.patients.find((p: { patientId: string }) => p.patientId === patientA);
      expect(mine.chatIds).toEqual({ MANAGEMENT: GROUP_PLAN });

      const reversa = await api.get(
        `/api/admin/patients/chat-map?chatId=${encodeURIComponent(GROUP_PLAN)}`,
        authHeaders(staffToken),
      );
      expect(reversa.data.data.patients[0].matchedRole).toBe('MANAGEMENT');

      const detalhe = await api.get(`/api/admin/patients/${patientA}`, authHeaders(staffToken));
      expect(detalhe.status).toBe(200);
      expect(detalhe.data.data.chatIds).toEqual({ MANAGEMENT: GROUP_PLAN });
      // e os aliases legados não inventam nada
      expect(detalhe.data.data.familyChatId).toBeNull();
    });

    it('44. 401 sem token e 403 para worker', async () => {
      expect((await api.get('/api/admin/patients/chat-map')).status).toBe(401);
      expect(
        (await api.get('/api/admin/patients/chat-map', authHeaders(workerToken))).status,
      ).toBe(403);
    });
  });

});
