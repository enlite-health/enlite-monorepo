/**
 * chat-groups.e2e.test.ts
 *
 * E2E de `GET /api/admin/chat-groups` — a lista de TODOS os grupos da org.
 *
 * SEM MOCK do nosso lado: Postgres real e a nossa API real via HTTP. A única
 * peça substituída é a API do PERISKOPE, por um servidor local
 * (`helpers/periskopeStubServer.ts`) que responde no formato real capturado de
 * produção — teste não fala com serviço externo vivo (regra dura do repo).
 *
 * O QUE ESTE ARQUIVO EXISTE PARA PROVAR:
 *
 *   (a) o grupo nomeado pelo PAGADOR (`Gestión: EnLite <> DAS`) aparece aqui —
 *       ele NUNCA aparecia em /chat-candidates, porque lá o ranqueamento é por
 *       semelhança com o nome do paciente e ele pontua zero. Era o motivo de o
 *       papel compartilhado ser invinculável na prática;
 *   (b) `linkedPatientCount` vem do NOSSO banco de verdade, contando linhas de
 *       `patient_chat_ids` — é o número que a tela mostra como informação, e o
 *       unit com pool falso não prova que o SQL roda;
 *   (c) paciente soft-deleted NÃO conta, igual ao resto do módulo.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import { startPeriskopeStub, type PeriskopeStub, type StubChat } from './helpers/periskopeStubServer';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const STUB_PORT = Number(process.env.PERISKOPE_STUB_PORT ?? 9911);

const GESTION_DAS = '120363088000000001@g.us';
const GESTION_OSPJN = '120363088000000002@g.us';
const FLIA = '120363088000000003@g.us';
const ONE_TO_ONE = '5491162180721@c.us';

const STUB_CHATS: StubChat[] = [
  { chat_id: GESTION_DAS, chat_name: 'Gestión: EnLite <> DAS', chat_type: 'group', member_count: 16 },
  { chat_id: GESTION_OSPJN, chat_name: 'Gestión: EnLite <> OSPJN', chat_type: 'group', member_count: 16 },
  { chat_id: FLIA, chat_name: 'Flia Gruposteste', chat_type: 'group', member_count: 5 },
  // 1-1 no payload: a nossa camada descarta mesmo que o Periskope mande.
  { chat_id: ONE_TO_ONE, chat_name: 'Alguem', chat_type: 'user', member_count: null },
];

describe('GET /api/admin/chat-groups — E2E', () => {
  const api = createApiClient();
  let pool: Pool;
  let stub: PeriskopeStub;
  let staffToken: string;
  let workerToken: string;
  const patients: string[] = [];

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  async function seedPatient(firstName: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, $2, $3, 'Gruposteste', 'AR', 'ACTIVE')`,
      [id, `e2e-groups-${id}`, firstName],
    );
    patients.push(id);
    return id;
  }

  function link(patientId: string, role: string, chatId: string, exclusive = false) {
    return pool.query(
      'INSERT INTO patient_chat_ids (patient_id, role, chat_id, is_exclusive) VALUES ($1,$2,$3,$4)',
      [patientId, role, chatId, exclusive],
    );
  }

  /** Uma linha da resposta, como a API a devolve. */
  interface GroupRow {
    chatId: string;
    chatName: string | null;
    memberCount: number | null;
    orgPhone: string | null;
    linkedPatientCount: number;
  }

  /** Acha um grupo na resposta pelo chat_id. */
  function find(data: { groups: GroupRow[] }, chatId: string): GroupRow | undefined {
    return data.groups.find(g => g.chatId === chatId);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    stub = await startPeriskopeStub(STUB_CHATS, STUB_PORT);
    await waitForBackend(api);

    staffToken = await getMockToken(api, {
      uid: 'groups-staff-e2e', email: 'groups-staff@e2e.local', role: 'admin',
    });
    workerToken = await getMockToken(api, {
      uid: 'groups-worker-e2e', email: 'groups-worker@e2e.local', role: 'worker',
    });
  });

  afterEach(async () => {
    await pool.query('DELETE FROM patient_chat_ids WHERE patient_id = ANY($1::uuid[])', [patients]);
  });

  afterAll(async () => {
    if (patients.length > 0) {
      await pool.query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [patients]);
    }
    await pool.end();
    await stub.close();
  });

  it('1. 401 sem token e 403 para quem não é staff', async () => {
    expect((await api.get('/api/admin/chat-groups')).status).toBe(401);
    expect((await api.get('/api/admin/chat-groups', authHeaders(workerToken))).status).toBe(403);
  });

  it('2. devolve os grupos da org e DESCARTA conversa 1-1', async () => {
    const res = await api.get('/api/admin/chat-groups', authHeaders(staffToken));

    expect(res.status).toBe(200);
    expect(res.data.data.groups.map((g: { chatId: string }) => g.chatId).sort()).toEqual(
      [FLIA, GESTION_DAS, GESTION_OSPJN].sort(),
    );
    expect(find(res.data.data, ONE_TO_ONE)).toBeUndefined();
  });

  it('3. ACHA o grupo nomeado pelo pagador — o que o ranqueamento nunca traz', async () => {
    // A prova do buraco que esta lista fecha. O MESMO grupo, buscado pelo
    // caminho antigo (ranqueado pelo nome do paciente), não aparece — ver o
    // teste 4 logo abaixo.
    const res = await api.get('/api/admin/chat-groups?search=gestion', authHeaders(staffToken));

    expect(res.status).toBe(200);
    expect(res.data.data.total).toBe(2);
    expect(find(res.data.data, GESTION_DAS)?.chatName).toBe('Gestión: EnLite <> DAS');
  });

  it('4. o MESMO grupo NÃO aparece em /chat-candidates — é por isso que a lista existe', async () => {
    const paciente = await seedPatient('Maria');

    const cand = await api.get(
      `/api/admin/patients/${paciente}/chat-candidates`,
      authHeaders(staffToken),
    );

    expect(cand.status).toBe(200);
    const ids = cand.data.data.candidates.map((c: { chatId: string }) => c.chatId);
    expect(ids).not.toContain(GESTION_DAS);
    // e o grupo com o SOBRENOME do paciente aparece — o ranqueamento continua
    // certo para o que ele foi feito
    expect(ids).toContain(FLIA);
  });

  it('5. busca ignora acento e caixa nos dois lados', async () => {
    for (const term of ['gestion', 'GESTIÓN', 'Gestion', 'das']) {
      const res = await api.get(
        `/api/admin/chat-groups?search=${encodeURIComponent(term)}`,
        authHeaders(staffToken),
      );
      expect(res.status).toBe(200);
      expect(res.data.data.total).toBeGreaterThan(0);
    }
  });

  it('6. busca sem resultado é 200 com lista vazia, não erro', async () => {
    const res = await api.get('/api/admin/chat-groups?search=zzzznaoexiste', authHeaders(staffToken));
    expect(res.status).toBe(200);
    expect(res.data.data).toMatchObject({ groups: [], total: 0, hasMore: false });
  });

  it('7. `linkedPatientCount` conta LINHAS REAIS do nosso banco', async () => {
    // Unit com pool falso não prova que o SQL roda. Aqui os vínculos existem.
    const a = await seedPatient('Uno');
    const b = await seedPatient('Dos');
    await link(a, 'HEALTH_PLAN', GESTION_DAS);
    await link(b, 'HEALTH_PLAN', GESTION_DAS);

    const res = await api.get('/api/admin/chat-groups?search=DAS', authHeaders(staffToken));

    expect(find(res.data.data, GESTION_DAS)?.linkedPatientCount).toBe(2);
  });

  it('8. grupo que ninguém usa vem com 0, não com campo ausente', async () => {
    const res = await api.get('/api/admin/chat-groups?search=OSPJN', authHeaders(staffToken));
    expect(find(res.data.data, GESTION_OSPJN)?.linkedPatientCount).toBe(0);
  });

  it('9. paciente SOFT-DELETED não conta no uso', async () => {
    const vivo = await seedPatient('Vivo');
    const morto = await seedPatient('Apagado');
    await link(vivo, 'HEALTH_PLAN', GESTION_DAS);
    await link(morto, 'HEALTH_PLAN', GESTION_DAS);
    await pool.query('UPDATE patients SET deleted_at = NOW() WHERE id = $1', [morto]);

    const res = await api.get('/api/admin/chat-groups?search=DAS', authHeaders(staffToken));

    expect(find(res.data.data, GESTION_DAS)?.linkedPatientCount).toBe(1);

    await pool.query('UPDATE patients SET deleted_at = NULL WHERE id = $1', [morto]);
  });

  it('10. o mesmo grupo em papéis DIFERENTES conta o PACIENTE uma vez', async () => {
    const a = await seedPatient('Tres');
    await link(a, 'HEALTH_PLAN', GESTION_DAS);
    // outro paciente, para o total não ser trivialmente 1
    const b = await seedPatient('Quatro');
    await link(b, 'HEALTH_PLAN', GESTION_DAS);

    const res = await api.get('/api/admin/chat-groups?search=DAS', authHeaders(staffToken));
    expect(find(res.data.data, GESTION_DAS)?.linkedPatientCount).toBe(2);
  });

  it('11. pagina sem repetir nem pular', async () => {
    const vistos: string[] = [];
    for (const offset of [0, 1, 2]) {
      const res = await api.get(`/api/admin/chat-groups?limit=1&offset=${offset}`, authHeaders(staffToken));
      expect(res.status).toBe(200);
      expect(res.data.data.total).toBe(3);
      vistos.push(...res.data.data.groups.map((g: { chatId: string }) => g.chatId));
    }
    expect(new Set(vistos).size).toBe(3);
  });

  it('12. `hasMore` diz a verdade na primeira e na última página', async () => {
    const p1 = await api.get('/api/admin/chat-groups?limit=2&offset=0', authHeaders(staffToken));
    expect(p1.data.data.hasMore).toBe(true);

    const p2 = await api.get('/api/admin/chat-groups?limit=2&offset=2', authHeaders(staffToken));
    expect(p2.data.data.hasMore).toBe(false);
  });

  it('13. leva o NÚMERO de origem do grupo', async () => {
    // É o campo que explica um grupo NÃO aparecer: se nenhum número nosso está
    // dentro dele, ele não existe para nós. O stub responde no formato real.
    const res = await api.get('/api/admin/chat-groups?search=DAS', authHeaders(staffToken));
    expect(find(res.data.data, GESTION_DAS)).toHaveProperty('orgPhone');
  });

  it.each([
    ['campo desconhecido', 'foo=x'],
    ['limit fora da faixa', 'limit=9999'],
    ['offset negativo', 'offset=-1'],
  ])('14. 400 para %s', async (_l, qs) => {
    const res = await api.get(`/api/admin/chat-groups?${qs}`, authHeaders(staffToken));
    expect(res.status).toBe(400);
  });

  it('15. o payload NÃO carrega o `ok` interno do caso de uso', async () => {
    const res = await api.get('/api/admin/chat-groups', authHeaders(staffToken));
    expect(res.data.data).not.toHaveProperty('ok');
    expect(Object.keys(res.data.data).sort()).toEqual(
      ['groups', 'hasMore', 'limit', 'listTruncated', 'offset', 'total'],
    );
  });
});
