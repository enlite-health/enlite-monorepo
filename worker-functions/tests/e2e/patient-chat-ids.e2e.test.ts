/**
 * patient-chat-ids.e2e.test.ts
 *
 * E2E das duas tasks de Chat ID do paciente (ClickUp 86ajy0859 / 86ajy085a):
 *
 *   PUT /api/admin/patients/:id/chat-ids          — grava o par família/prestadores
 *   GET /api/admin/patients/:id                   — devolve o par gravado
 *   GET /api/admin/patients/:id/chat-candidates   — grupos ranqueados
 *
 * SEM MOCK: Postgres real (migration 260 aplicada pelo runner do container) e a
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
 * Requer a stack com:
 *   PATIENT_CHAT_LOOKUP_ENABLED=true
 *   PERISKOPE_API_KEY / PERISKOPE_PHONE (valores fake, só para o cliente existir)
 *   PERISKOPE_BASE_URL=http://host.docker.internal:9911/v1
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

  async function seedPatient(firstName: string, lastName: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, $2, $3, $4, 'AR', 'ACTIVE')`,
      [id, `e2e-chatid-${id}`, firstName, lastName],
    );
    insertedIds.push(id);
    return id;
  }

  async function readChatIds(id: string) {
    const r = await pool.query<{ family: string | null; providers: string | null }>(
      'SELECT family_chat_id AS family, providers_chat_id AS providers FROM patients WHERE id = $1',
      [id],
    );
    return r.rows[0];
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
    await pool.query(
      'UPDATE patients SET family_chat_id = NULL, providers_chat_id = NULL WHERE id = ANY($1::uuid[])',
      [insertedIds],
    );
  });

  // ── Migration 260: as constraints mordem no banco real ─────────────────────

  describe('constraints da migration 260 (SQL direto)', () => {
    it('1. colunas existem com o tipo e a nulidade esperados', async () => {
      const r = await pool.query(
        `SELECT column_name, data_type, character_maximum_length, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'patients'
            AND column_name IN ('family_chat_id','providers_chat_id')
          ORDER BY column_name`,
      );
      expect(r.rows).toEqual([
        { column_name: 'family_chat_id', data_type: 'character varying', character_maximum_length: 64, is_nullable: 'YES' },
        { column_name: 'providers_chat_id', data_type: 'character varying', character_maximum_length: 64, is_nullable: 'YES' },
      ]);
    });

    it('2. CHECK recusa conversa 1-1 (@c.us) em family_chat_id', async () => {
      await expect(
        pool.query('UPDATE patients SET family_chat_id = $2 WHERE id = $1', [patientA, CHAT_ONE_TO_ONE]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'patients_family_chat_id_is_group' });
    });

    it('3. CHECK recusa conversa 1-1 (@c.us) em providers_chat_id', async () => {
      await expect(
        pool.query('UPDATE patients SET providers_chat_id = $2 WHERE id = $1', [patientA, CHAT_ONE_TO_ONE]),
      ).rejects.toMatchObject({ code: '23514', constraint: 'patients_providers_chat_id_is_group' });
    });

    it('4. CHECK recusa o mesmo grupo nos dois papéis do MESMO paciente', async () => {
      await expect(
        pool.query(
          'UPDATE patients SET family_chat_id = $2, providers_chat_id = $2 WHERE id = $1',
          [patientA, GROUP_FAMILY],
        ),
      ).rejects.toMatchObject({ code: '23514', constraint: 'patients_chat_ids_distinct' });
    });

    it('5. ÍNDICE ÚNICO impede o mesmo grupo em dois pacientes (a trava da Candela)', async () => {
      await pool.query('UPDATE patients SET family_chat_id = $2 WHERE id = $1', [patientA, GROUP_FAMILY]);
      await expect(
        pool.query('UPDATE patients SET family_chat_id = $2 WHERE id = $1', [patientB, GROUP_FAMILY]),
      ).rejects.toMatchObject({ code: '23505' });
    });

    it('6. NULL não colide com NULL — vários pacientes sem vínculo convivem', async () => {
      const r = await pool.query(
        'SELECT COUNT(*)::int AS n FROM patients WHERE id = ANY($1::uuid[]) AND family_chat_id IS NULL',
        [insertedIds],
      );
      expect(r.rows[0].n).toBe(insertedIds.length);
    });

    it('7. aceita os dois formatos reais de chat_id de grupo', async () => {
      await pool.query(
        'UPDATE patients SET family_chat_id = $2, providers_chat_id = $3 WHERE id = $1',
        [patientA, GROUP_FAMILY, GROUP_OTHER],
      );
      expect(await readChatIds(patientA)).toEqual({ family: GROUP_FAMILY, providers: GROUP_OTHER });
    });
  });

  // ── PUT /chat-ids ──────────────────────────────────────────────────────────

  describe('PUT /api/admin/patients/:id/chat-ids', () => {
    it('8. grava o par e devolve 200', async () => {
      const res = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { familyChatId: GROUP_FAMILY, providersChatId: GROUP_PROVIDERS },
        authHeaders(staffToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data).toMatchObject({
        id: patientA, familyChatId: GROUP_FAMILY, providersChatId: GROUP_PROVIDERS,
      });
      expect(await readChatIds(patientA)).toEqual({ family: GROUP_FAMILY, providers: GROUP_PROVIDERS });
    });

    it('9. GET /patients/:id devolve os chat IDs gravados (o join da Candela)', async () => {
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { familyChatId: GROUP_FAMILY, providersChatId: GROUP_PROVIDERS },
        authHeaders(staffToken),
      );

      const res = await api.get(`/api/admin/patients/${patientA}`, authHeaders(staffToken));
      expect(res.status).toBe(200);
      expect(res.data.data).toMatchObject({
        familyChatId: GROUP_FAMILY, providersChatId: GROUP_PROVIDERS,
      });
    });

    it('10. null desvincula e libera o grupo para outro paciente', async () => {
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { familyChatId: GROUP_FAMILY, providersChatId: null },
        authHeaders(staffToken),
      );

      const clear = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { familyChatId: null, providersChatId: null },
        authHeaders(staffToken),
      );
      expect(clear.status).toBe(200);
      expect(await readChatIds(patientA)).toEqual({ family: null, providers: null });

      const reuse = await api.put(
        `/api/admin/patients/${patientB}/chat-ids`,
        { familyChatId: GROUP_FAMILY, providersChatId: null },
        authHeaders(staffToken),
      );
      expect(reuse.status).toBe(200);
    });

    it('11. 409 quando o grupo já é de outro paciente no MESMO papel', async () => {
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { familyChatId: GROUP_FAMILY, providersChatId: null },
        authHeaders(staffToken),
      );

      const res = await api.put(
        `/api/admin/patients/${patientB}/chat-ids`,
        { familyChatId: GROUP_FAMILY, providersChatId: null },
        authHeaders(staffToken),
      );

      expect(res.status).toBe(409);
      expect(res.data.code).toBe('CHAT_ID_ALREADY_LINKED');
      expect(res.data.details.conflicts).toEqual([
        { chatId: GROUP_FAMILY, patientId: patientA, role: 'family' },
      ]);
      expect(await readChatIds(patientB)).toEqual({ family: null, providers: null });
    });

    it('12. 409 na colisão CRUZADA (família de um == prestadores de outro)', async () => {
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { familyChatId: GROUP_FAMILY, providersChatId: null },
        authHeaders(staffToken),
      );

      const res = await api.put(
        `/api/admin/patients/${patientB}/chat-ids`,
        { familyChatId: null, providersChatId: GROUP_FAMILY },
        authHeaders(staffToken),
      );

      expect(res.status).toBe(409);
      expect(res.data.details.conflicts[0]).toMatchObject({ role: 'family', patientId: patientA });
    });

    it('13. 400 para conversa 1-1 (@c.us) — nunca chega ao banco', async () => {
      const res = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { familyChatId: CHAT_ONE_TO_ONE, providersChatId: null },
        authHeaders(staffToken),
      );
      expect(res.status).toBe(400);
      expect(await readChatIds(patientA)).toEqual({ family: null, providers: null });
    });

    it('14. 400 para o mesmo grupo nos dois papéis', async () => {
      const res = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { familyChatId: GROUP_FAMILY, providersChatId: GROUP_FAMILY },
        authHeaders(staffToken),
      );
      expect(res.status).toBe(400);
    });

    it('15. 400 para campo desconhecido no body', async () => {
      const res = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { familyChatId: null, providersChatId: null, chatId: GROUP_FAMILY },
        authHeaders(staffToken),
      );
      expect(res.status).toBe(400);
    });

    it('16. 404 para paciente inexistente', async () => {
      const res = await api.put(
        `/api/admin/patients/${randomUUID()}/chat-ids`,
        { familyChatId: GROUP_FAMILY, providersChatId: null },
        authHeaders(staffToken),
      );
      expect(res.status).toBe(404);
    });

    it('17. 401 sem token e 403 para worker', async () => {
      const body = { familyChatId: null, providersChatId: null };
      expect((await api.put(`/api/admin/patients/${patientA}/chat-ids`, body)).status).toBe(401);
      expect(
        (await api.put(`/api/admin/patients/${patientA}/chat-ids`, body, authHeaders(workerToken))).status,
      ).toBe(403);
    });
  });

  // ── GET /chat-candidates ───────────────────────────────────────────────────

  describe('GET /api/admin/patients/:id/chat-candidates', () => {
    it('18. devolve os grupos parecidos com o nome do paciente, ranqueados', async () => {
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

    it('19. a nossa API pede ao Periskope só GRUPOS, com auth de Bearer + x-phone', async () => {
      stub.requests.length = 0;
      await api.get(`/api/admin/patients/${patientA}/chat-candidates`, authHeaders(staffToken));

      expect(stub.requests).toHaveLength(1);
      expect(stub.requests[0].path).toContain('chat_type=group');
      expect(stub.requests[0].auth).toMatch(/^Bearer /);
      expect(stub.requests[0].phone).toBeTruthy();
    });

    it('20. NENHUMA requisição de escrita chega ao Periskope em todo o fluxo', () => {
      const escritas = stub.requests.filter(r => !r.path.startsWith('/v1/chats'));
      expect(escritas).toEqual([]);
    });

    it('21. marca o candidato já preso a outro paciente', async () => {
      await api.put(
        `/api/admin/patients/${patientB}/chat-ids`,
        { familyChatId: GROUP_PROVIDERS, providersChatId: null },
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

    it('22. respeita o limit', async () => {
      const res = await api.get(
        `/api/admin/patients/${patientA}/chat-candidates?limit=1`,
        authHeaders(staffToken),
      );
      expect(res.data.data.candidates).toHaveLength(1);
    });

    it('23. 400 para limit fora da faixa', async () => {
      const res = await api.get(
        `/api/admin/patients/${patientA}/chat-candidates?limit=999`,
        authHeaders(staffToken),
      );
      expect(res.status).toBe(400);
    });

    it('24. 404 para paciente inexistente', async () => {
      const res = await api.get(
        `/api/admin/patients/${randomUUID()}/chat-candidates`,
        authHeaders(staffToken),
      );
      expect(res.status).toBe(404);
    });

    it('25. 401 sem token e 403 para worker', async () => {
      expect((await api.get(`/api/admin/patients/${patientA}/chat-candidates`)).status).toBe(401);
      expect(
        (await api.get(`/api/admin/patients/${patientA}/chat-candidates`, authHeaders(workerToken))).status,
      ).toBe(403);
    });

    it('26. fluxo completo: buscar → escolher → salvar → ler de volta', async () => {
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
        { familyChatId: familia.chatId, providersChatId: prestadores.chatId },
        authHeaders(staffToken),
      );
      expect(save.status).toBe(200);

      const detail = await api.get(`/api/admin/patients/${patientA}`, authHeaders(staffToken));
      expect(detail.data.data.familyChatId).toBe(GROUP_FAMILY);
      expect(detail.data.data.providersChatId).toBe(GROUP_PROVIDERS);
    });
  });
});
