/**
 * patient-chat-roles.e2e.test.ts
 *
 * E2E do CATÁLOGO de papéis de grupo do paciente (ClickUp 86ajy1jhz,
 * migration 262):
 *
 *   GET    /api/admin/patient-chat-roles         — staff
 *   POST   /api/admin/patient-chat-roles         — ADMIN
 *   PATCH  /api/admin/patient-chat-roles/:code   — ADMIN
 *   DELETE /api/admin/patient-chat-roles/:code   — ADMIN
 *
 * SEM MOCK: Postgres real (a 262 é aplicada pelo runner do container) e a nossa
 * API real via HTTP. As constraints da migration são exercidas por SQL direto —
 * é o tipo de invariante que unit com pool falso nunca pega.
 *
 * O QUE ESTE ARQUIVO EXISTE PARA PROVAR, além do CRUD:
 *
 *   (a) as DUAS recusas que não podem ser silenciosas acontecem de verdade,
 *       COM a contagem: virar um papel compartilhado em exclusivo com dado
 *       conflitante, e desativar/apagar papel em uso;
 *   (b) trocar a política na tela atualiza a coluna DERIVADA
 *       `patient_chat_ids.is_exclusive` na mesma transação — sem isso o índice
 *       único parcial mentiria em relação ao que a tela mostra;
 *   (c) o efeito da política é REAL: com HEALTH_PLAN compartilhável, dois
 *       pacientes dividem o mesmo grupo; virando-o exclusivo, o segundo leva
 *       409. Mesmo endpoint, mesma requisição, resposta oposta — só o dado do
 *       catálogo mudou. É a prova de que papel novo não precisa de deploy.
 *
 * ⚠️ Cada teste restaura o catálogo semeado no `afterEach`: a 262 é aplicada uma
 * vez por container, e um teste que deixasse HEALTH_PLAN exclusivo contaminaria
 * o `patient-chat-ids.e2e.test.ts` que roda na mesma stack.
 */

import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { createApiClient, getMockToken, waitForBackend } from './helpers';
import { startPeriskopeStub, type PeriskopeStub, type StubChat } from './helpers/periskopeStubServer';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const GROUP_PLAN = '120363099000000001@g.us';
const GROUP_FAMILY = '120363099000000002@g.us';

/** Códigos criados pelos testes — apagados no final para não vazar entre runs. */
const TEMP_CODES = ['E2E_TEMP', 'E2E_TEMP2', 'E2E_INUSE'];

/**
 * Mesma porta do `patient-chat-ids.e2e.test.ts` — é a que o `docker-compose.
 * test.yml` aponta em PERISKOPE_BASE_URL. Não há corrida: o jest de e2e roda com
 * `maxWorkers: 1` (sequencial).
 */
const STUB_PORT = Number(process.env.PERISKOPE_STUB_PORT ?? 9911);

/**
 * Os dois grupos do MESMO paciente, com o mesmo sobrenome — o caso que produz
 * score IDÊNTICO e faz o desempate por papel existir. "Equipo" vem antes de
 * "Flia" no alfabeto, que era como o empate se resolvia antes.
 */
const STUB_CHATS: StubChat[] = [
  { chat_id: '120363099000000011@g.us', chat_name: 'Flia Rolestest Uno', chat_type: 'group', member_count: 5 },
  { chat_id: '120363099000000012@g.us', chat_name: 'Equipo Rolestest Uno', chat_type: 'group', member_count: 9 },
];
const CHAT_FAMILIA = STUB_CHATS[0].chat_id;
const CHAT_EQUIPO = STUB_CHATS[1].chat_id;

describe('Catálogo de papéis de chat do paciente — E2E', () => {
  const api = createApiClient();
  let pool: Pool;
  let stub: PeriskopeStub;
  let adminToken: string;
  let recruiterToken: string;
  let workerToken: string;
  let patientA: string;
  let patientB: string;
  const insertedPatients: string[] = [];

  function authHeaders(token: string) {
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  async function seedPatient(firstName: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO patients (id, clickup_task_id, first_name, last_name, phone_whatsapp,
                             document_number, country, status)
       VALUES ($1, $2, $3, 'Rolestest', '+5491100000456', 'DOC-E2E-ROLE', 'AR', 'ACTIVE')`,
      [id, `e2e-chatrole-${id}`, firstName],
    );
    insertedPatients.push(id);
    return id;
  }

  /** Lê a linha do catálogo direto do banco — não pela API que estamos testando. */
  async function readRole(code: string) {
    const r = await pool.query(
      `SELECT code, label_es, label_pt_br, is_exclusive, display_order, is_active, match_keywords
         FROM patient_chat_roles WHERE code = $1`,
      [code],
    );
    return r.rows[0] ?? null;
  }

  /** A coluna DERIVADA nas linhas de vínculo. */
  async function readLinkExclusivity(role: string): Promise<boolean[]> {
    const r = await pool.query<{ is_exclusive: boolean }>(
      'SELECT is_exclusive FROM patient_chat_ids WHERE role = $1 ORDER BY patient_id',
      [role],
    );
    return r.rows.map(row => row.is_exclusive);
  }

  function insertLink(patientId: string, role: string, chatId: string, exclusive: boolean) {
    return pool.query(
      'INSERT INTO patient_chat_ids (patient_id, role, chat_id, is_exclusive) VALUES ($1,$2,$3,$4)',
      [patientId, role, chatId, exclusive],
    );
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    stub = await startPeriskopeStub(STUB_CHATS, STUB_PORT);
    await waitForBackend(api);

    adminToken = await getMockToken(api, {
      uid: 'chatrole-admin-e2e', email: 'chatrole-admin@e2e.local', role: 'admin',
    });
    recruiterToken = await getMockToken(api, {
      uid: 'chatrole-recruiter-e2e', email: 'chatrole-recruiter@e2e.local', role: 'recruiter',
    });
    workerToken = await getMockToken(api, {
      uid: 'chatrole-worker-e2e', email: 'chatrole-worker@e2e.local', role: 'worker',
    });

    patientA = await seedPatient('Uno');
    patientB = await seedPatient('Dos');
  });

  /**
   * O estado semeado pela 262, palavra por palavra.
   *
   * ⚠️ Restaurar TUDO, não só as flags. Uma versão anterior deste arquivo
   * restaurava só `is_exclusive`/`is_active`, e o rótulo trocado pelo teste 23
   * sobreviveu ao run — apareceu como "Só o rótulo pt" na prova visual da tela,
   * que roda contra o mesmo container. Teste que suja o banco compartilhado é
   * um falso-negativo esperando acontecer no vizinho.
   */
  const SEEDED = [
    { code: 'FAMILY', es: 'Grupo de la familia', pt: 'Grupo da família', excl: true, ord: 1,
      kw: ['flia', 'familia', 'family', 'fam', 'familiares'] },
    { code: 'PROVIDERS', es: 'Grupo de los prestadores', pt: 'Grupo dos prestadores', excl: true, ord: 2,
      kw: ['equipo', 'equipe', 'prestadores', 'prestador', 'acompanantes', 'ats'] },
    { code: 'HEALTH_PLAN', es: 'Grupo de la obra social / prepaga', pt: 'Grupo do plano de saúde', excl: false, ord: 3,
      kw: ['obra', 'social', 'prepaga', 'osde', 'swiss', 'galeno', 'plan'] },
  ];

  afterEach(async () => {
    await pool.query('DELETE FROM patient_chat_ids WHERE patient_id = ANY($1::uuid[])', [insertedPatients]);
    await pool.query('DELETE FROM patient_chat_roles WHERE code = ANY($1::text[])', [TEMP_CODES]);
    for (const r of SEEDED) {
      await pool.query(
        `UPDATE patient_chat_roles
            SET label_es = $2, label_pt_br = $3, is_exclusive = $4,
                display_order = $5, is_active = TRUE, match_keywords = $6
          WHERE code = $1`,
        [r.code, r.es, r.pt, r.excl, r.ord, r.kw],
      );
    }
  });

  afterAll(async () => {
    if (insertedPatients.length > 0) {
      await pool.query('DELETE FROM patients WHERE id = ANY($1::uuid[])', [insertedPatients]);
    }
    await pool.end();
    await stub.close();
  });

  // ── Migration 262: as constraints mordem no banco real ─────────────────────

  describe('constraints da migration 262 (SQL direto)', () => {
    it('1. a tabela existe com as colunas e a nulidade esperadas', async () => {
      const r = await pool.query(
        `SELECT column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_name = 'patient_chat_roles'
            AND column_name IN ('code','label_es','label_pt_br','is_exclusive','display_order','is_active','match_keywords')
          ORDER BY column_name`,
      );
      expect(r.rows.map(row => row.column_name)).toEqual([
        'code', 'display_order', 'is_active', 'is_exclusive', 'label_es', 'label_pt_br', 'match_keywords',
      ]);
      expect(r.rows.every(row => row.is_nullable === 'NO')).toBe(true);
    });

    it('2. a 262 SEMEIA os três papéis, e HEALTH_PLAN nasce COMPARTILHÁVEL', async () => {
      // 27 pagadores para 236 pacientes: se existe um grupo por pagador, ele
      // serve dezenas de pacientes e uma trava global recusaria do 2º em diante.
      expect(await readRole('FAMILY')).toMatchObject({ is_exclusive: true });
      expect(await readRole('PROVIDERS')).toMatchObject({ is_exclusive: true });
      expect(await readRole('HEALTH_PLAN')).toMatchObject({ is_exclusive: false });
    });

    it('3. CHECK recusa código fora da FORMA de enum — a MESMA da 261', async () => {
      for (const bad of ['family', 'HEALTH PLAN', 'HEALTH-PLAN', '1FAMILY']) {
        await expect(
          pool.query(
            `INSERT INTO patient_chat_roles (code, label_es, label_pt_br) VALUES ($1, 'a', 'b')`,
            [bad],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'patient_chat_roles_code_shape' });
      }
    });

    it('4. CHECK recusa rótulo em BRANCO — rótulo vazio é o mesmo que ausente', async () => {
      for (const [es, pt] of [['   ', 'ok'], ['ok', ''], ['', '']]) {
        await expect(
          pool.query(
            `INSERT INTO patient_chat_roles (code, label_es, label_pt_br) VALUES ('E2E_TEMP', $1, $2)`,
            [es, pt],
          ),
        ).rejects.toMatchObject({ code: '23514', constraint: 'patient_chat_roles_labels_not_blank' });
      }
    });

    it('5. a PK recusa código repetido', async () => {
      await expect(
        pool.query(`INSERT INTO patient_chat_roles (code, label_es, label_pt_br) VALUES ('FAMILY','a','b')`),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  // ── Permissão: leitura é staff, escrita é ADMIN ────────────────────────────

  describe('gate de permissão', () => {
    it('6. sem token: 401 nos quatro verbos', async () => {
      expect((await api.get('/api/admin/patient-chat-roles')).status).toBe(401);
      expect((await api.post('/api/admin/patient-chat-roles', {})).status).toBe(401);
      expect((await api.patch('/api/admin/patient-chat-roles/FAMILY', {})).status).toBe(401);
      expect((await api.delete('/api/admin/patient-chat-roles/FAMILY')).status).toBe(401);
    });

    it('7. worker (não-staff) não lê o catálogo', async () => {
      const res = await api.get('/api/admin/patient-chat-roles', authHeaders(workerToken));
      expect(res.status).toBe(403);
    });

    it('8. recruiter LÊ — a ficha do paciente precisa dos rótulos', async () => {
      const res = await api.get('/api/admin/patient-chat-roles', authHeaders(recruiterToken));
      expect(res.status).toBe(200);
      expect(res.data.data.roles.map((r: { code: string }) => r.code)).toContain('FAMILY');
    });

    it('9. recruiter NÃO escreve — mudar o catálogo é configuração do sistema', async () => {
      // Muda a política de unicidade de TODOS os pacientes de uma vez; não é
      // edição de um registro.
      const post = await api.post(
        '/api/admin/patient-chat-roles',
        { code: 'E2E_TEMP', labelEs: 'a', labelPtBr: 'b' },
        authHeaders(recruiterToken),
      );
      expect(post.status).toBe(403);

      const patch = await api.patch(
        '/api/admin/patient-chat-roles/FAMILY',
        { labelEs: 'hackeado' },
        authHeaders(recruiterToken),
      );
      expect(patch.status).toBe(403);

      const del = await api.delete('/api/admin/patient-chat-roles/FAMILY', authHeaders(recruiterToken));
      expect(del.status).toBe(403);

      // e nada mudou no banco
      expect(await readRole('FAMILY')).toMatchObject({ label_es: 'Grupo de la familia' });
    });
  });

  // ── Leitura ────────────────────────────────────────────────────────────────

  describe('GET', () => {
    it('10. sem query devolve só os ATIVOS e SEM contagem de uso', async () => {
      await api.post(
        '/api/admin/patient-chat-roles',
        { code: 'E2E_TEMP', labelEs: 'a', labelPtBr: 'b' },
        authHeaders(adminToken),
      );
      await api.patch('/api/admin/patient-chat-roles/E2E_TEMP', { isActive: false }, authHeaders(adminToken));

      const res = await api.get('/api/admin/patient-chat-roles', authHeaders(adminToken));

      expect(res.status).toBe(200);
      expect(res.data.data.roles.map((r: { code: string }) => r.code)).not.toContain('E2E_TEMP');
      expect(res.data.data.usage).toBeUndefined();
    });

    it('11. ?includeInactive=true traz os desativados MAIS a contagem de uso', async () => {
      await api.post(
        '/api/admin/patient-chat-roles',
        { code: 'E2E_TEMP', labelEs: 'a', labelPtBr: 'b' },
        authHeaders(adminToken),
      );
      await api.patch('/api/admin/patient-chat-roles/E2E_TEMP', { isActive: false }, authHeaders(adminToken));
      await insertLink(patientA, 'FAMILY', GROUP_FAMILY, true);

      const res = await api.get('/api/admin/patient-chat-roles?includeInactive=true', authHeaders(adminToken));

      expect(res.data.data.roles.map((r: { code: string }) => r.code)).toContain('E2E_TEMP');
      expect(res.data.data.usage.FAMILY).toBe(1);
      expect(res.data.data.usage.PROVIDERS).toBe(0);
    });

    it('12. devolve na ORDEM de exibição, não alfabética', async () => {
      const res = await api.get('/api/admin/patient-chat-roles', authHeaders(adminToken));
      const codes = res.data.data.roles.map((r: { code: string }) => r.code);
      expect(codes.indexOf('FAMILY')).toBeLessThan(codes.indexOf('PROVIDERS'));
      expect(codes.indexOf('PROVIDERS')).toBeLessThan(codes.indexOf('HEALTH_PLAN'));
    });

    it('13. query desconhecida é 400 — não é ignorada em silêncio', async () => {
      const res = await api.get('/api/admin/patient-chat-roles?includeInactve=true', authHeaders(adminToken));
      expect(res.status).toBe(400);
    });
  });

  // ── Criação ────────────────────────────────────────────────────────────────

  describe('POST', () => {
    it('14. cria papel NOVO sem migration e sem deploy — é o ponto da mudança', async () => {
      const res = await api.post(
        '/api/admin/patient-chat-roles',
        {
          code: 'E2E_TEMP',
          labelEs: 'Grupo de gestión',
          labelPtBr: 'Grupo de gestão',
          isExclusive: false,
          displayOrder: 9,
          matchKeywords: ['Gestión', 'GESTION', ' gestao '],
        },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(201);
      expect(await readRole('E2E_TEMP')).toMatchObject({
        label_es: 'Grupo de gestión',
        label_pt_br: 'Grupo de gestão',
        is_exclusive: false,
        display_order: 9,
        is_active: true,
        // normalizadas e sem duplicata: "Gestión" e "GESTION" viram uma coisa só
        match_keywords: ['gestion', 'gestao'],
      });
    });

    it('15. o papel novo passa a ser GRAVÁVEL no paciente na hora', async () => {
      await api.post(
        '/api/admin/patient-chat-roles',
        { code: 'E2E_TEMP', labelEs: 'a', labelPtBr: 'b' },
        authHeaders(adminToken),
      );

      const res = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { E2E_TEMP: GROUP_FAMILY } },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(res.data.data.chatIds).toEqual({ E2E_TEMP: GROUP_FAMILY });
    });

    it('16. defaults: exclusivo, ordem 0, sem palavras — o conservador', async () => {
      await api.post(
        '/api/admin/patient-chat-roles',
        { code: 'E2E_TEMP', labelEs: 'a', labelPtBr: 'b' },
        authHeaders(adminToken),
      );
      expect(await readRole('E2E_TEMP')).toMatchObject({
        is_exclusive: true, display_order: 0, match_keywords: [],
      });
    });

    it('17. código repetido é 409 CHAT_ROLE_ALREADY_EXISTS', async () => {
      const res = await api.post(
        '/api/admin/patient-chat-roles',
        { code: 'FAMILY', labelEs: 'a', labelPtBr: 'b' },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(409);
      expect(res.data.code).toBe('CHAT_ROLE_ALREADY_EXISTS');
    });

    it('18. 400 e NADA gravado para corpo inválido', async () => {
      const bad = [
        { code: 'e2e_temp', labelEs: 'a', labelPtBr: 'b' },
        { code: 'E2E TEMP', labelEs: 'a', labelPtBr: 'b' },
        { code: 'E2E_TEMP', labelEs: '   ', labelPtBr: 'b' },
        { code: 'E2E_TEMP', labelEs: 'a' },
        { code: 'E2E_TEMP', labelEs: 'a', labelPtBr: 'b', cor: 'vermelho' },
      ];
      for (const body of bad) {
        const res = await api.post('/api/admin/patient-chat-roles', body, authHeaders(adminToken));
        expect(res.status).toBe(400);
      }
      expect(await readRole('E2E_TEMP')).toBeNull();
    });
  });

  // ── TRAVA 1: compartilhado → exclusivo ─────────────────────────────────────

  describe('PATCH — virar a política de unicidade', () => {
    it('19. atualiza a coluna DERIVADA dos vínculos na MESMA transação', async () => {
      // Sem isto, a tela diria "compartilhável" e o índice parcial continuaria
      // trancando — ou, pior, deixaria de trancar sem ninguém saber.
      await insertLink(patientA, 'HEALTH_PLAN', GROUP_PLAN, false);
      expect(await readLinkExclusivity('HEALTH_PLAN')).toEqual([false]);

      const res = await api.patch(
        '/api/admin/patient-chat-roles/HEALTH_PLAN',
        { isExclusive: true },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(await readRole('HEALTH_PLAN')).toMatchObject({ is_exclusive: true });
      expect(await readLinkExclusivity('HEALTH_PLAN')).toEqual([true]);
    });

    it('20. RECUSA a virada quando já há grupo dividido, com a CONTAGEM', async () => {
      // Deixar bater no índice devolveria 23505 sem explicação; e "resolver"
      // apagando um vínculo seria o software escolhendo qual paciente perde a
      // conversa — não é decisão de software.
      await insertLink(patientA, 'HEALTH_PLAN', GROUP_PLAN, false);
      await insertLink(patientB, 'HEALTH_PLAN', GROUP_PLAN, false);

      const res = await api.patch(
        '/api/admin/patient-chat-roles/HEALTH_PLAN',
        { isExclusive: true },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(409);
      expect(res.data.code).toBe('CHAT_ROLE_EXCLUSIVITY_CONFLICT');
      expect(res.data.details).toMatchObject({ groupCount: 1, patientCount: 2 });
      expect(res.data.details.conflicts).toEqual([{ chatId: GROUP_PLAN, patientCount: 2 }]);

      // e NADA mudou: nem o catálogo, nem a coluna derivada
      expect(await readRole('HEALTH_PLAN')).toMatchObject({ is_exclusive: false });
      expect(await readLinkExclusivity('HEALTH_PLAN')).toEqual([false, false]);
    });

    it('21. o EFEITO da política é real: mesma requisição, resposta oposta', async () => {
      // Esta é a prova de ponta a ponta de que a política mora no DADO.
      // (a) compartilhável: os dois pacientes ficam com o mesmo grupo
      const first = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { HEALTH_PLAN: GROUP_PLAN } },
        authHeaders(adminToken),
      );
      expect(first.status).toBe(200);

      const second = await api.put(
        `/api/admin/patients/${patientB}/chat-ids`,
        { chatIds: { HEALTH_PLAN: GROUP_PLAN } },
        authHeaders(adminToken),
      );
      expect(second.status).toBe(200);

      // (b) admin vira o papel para exclusivo (agora dá, porque vamos limpar um)
      await pool.query('DELETE FROM patient_chat_ids WHERE patient_id = $1', [patientB]);
      const flip = await api.patch(
        '/api/admin/patient-chat-roles/HEALTH_PLAN',
        { isExclusive: true },
        authHeaders(adminToken),
      );
      expect(flip.status).toBe(200);

      // (c) a MESMA requisição de antes agora é 409
      const again = await api.put(
        `/api/admin/patients/${patientB}/chat-ids`,
        { chatIds: { HEALTH_PLAN: GROUP_PLAN } },
        authHeaders(adminToken),
      );
      expect(again.status).toBe(409);
      expect(again.data.code).toBe('CHAT_ID_ALREADY_LINKED');
    });

    it('22. afrouxar (exclusivo → compartilhado) nunca é barrado', async () => {
      await insertLink(patientA, 'FAMILY', GROUP_FAMILY, true);

      const res = await api.patch(
        '/api/admin/patient-chat-roles/FAMILY',
        { isExclusive: false },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      expect(await readLinkExclusivity('FAMILY')).toEqual([false]);
    });

    it('23. campo ausente fica INALTERADO (é PATCH, não PUT)', async () => {
      await api.patch(
        '/api/admin/patient-chat-roles/FAMILY',
        { labelPtBr: 'Só o rótulo pt' },
        authHeaders(adminToken),
      );

      expect(await readRole('FAMILY')).toMatchObject({
        label_pt_br: 'Só o rótulo pt',
        label_es: 'Grupo de la familia',
        is_exclusive: true,
      });
    });

    it('24. mandar `code` no body é 400 — o código é imutável', async () => {
      const res = await api.patch(
        '/api/admin/patient-chat-roles/FAMILY',
        { code: 'FAMILIA' },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(400);
      expect(await readRole('FAMILIA')).toBeNull();
      expect(await readRole('FAMILY')).not.toBeNull();
    });

    it('25. body vazio é 400 e papel inexistente é 404', async () => {
      expect((await api.patch('/api/admin/patient-chat-roles/FAMILY', {}, authHeaders(adminToken))).status).toBe(400);

      const res = await api.patch(
        '/api/admin/patient-chat-roles/NAO_EXISTE',
        { labelEs: 'x' },
        authHeaders(adminToken),
      );
      expect(res.status).toBe(404);
      expect(res.data.code).toBe('CHAT_ROLE_NOT_FOUND');
    });
  });

  // ── TRAVA 2: desativar / apagar papel em uso ───────────────────────────────

  describe('desativar e apagar', () => {
    it('26. RECUSA desativar papel EM USO, dizendo quantos pacientes dependem', async () => {
      await insertLink(patientA, 'FAMILY', GROUP_FAMILY, true);
      await insertLink(patientB, 'FAMILY', GROUP_PLAN, true);

      const res = await api.patch(
        '/api/admin/patient-chat-roles/FAMILY',
        { isActive: false },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(409);
      expect(res.data.code).toBe('CHAT_ROLE_IN_USE');
      expect(res.data.details).toMatchObject({ patientCount: 2, operation: 'deactivate' });
      expect(await readRole('FAMILY')).toMatchObject({ is_active: true });
    });

    it('27. RECUSA apagar papel EM USO — nada de cascata', async () => {
      // Os vínculos são a chave de join da auditoria da Candela: apagá-los junto
      // com uma linha de catálogo seria perder dado operacional por um clique.
      await insertLink(patientA, 'FAMILY', GROUP_FAMILY, true);

      const res = await api.delete('/api/admin/patient-chat-roles/FAMILY', authHeaders(adminToken));

      expect(res.status).toBe(409);
      expect(res.data.code).toBe('CHAT_ROLE_IN_USE');
      expect(res.data.details).toMatchObject({ patientCount: 1, operation: 'delete' });
      // o VÍNCULO continua lá — é o que a auditoria lê
      expect(await readLinkExclusivity('FAMILY')).toHaveLength(1);
      expect(await readRole('FAMILY')).not.toBeNull();
    });

    it('28. paciente SOFT-DELETED não segura o papel', async () => {
      const gone = await seedPatient('Apagado');
      await insertLink(gone, 'FAMILY', GROUP_FAMILY, true);
      await pool.query('UPDATE patients SET deleted_at = NOW() WHERE id = $1', [gone]);

      const res = await api.patch(
        '/api/admin/patient-chat-roles/FAMILY',
        { isActive: false },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(200);
      await pool.query('DELETE FROM patient_chat_ids WHERE patient_id = $1', [gone]);
    });

    it('29. desativar tira o papel da ESCRITA, mas não apaga vínculo nenhum', async () => {
      await api.post(
        '/api/admin/patient-chat-roles',
        { code: 'E2E_TEMP', labelEs: 'a', labelPtBr: 'b' },
        authHeaders(adminToken),
      );
      await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { E2E_TEMP: GROUP_FAMILY } },
        authHeaders(adminToken),
      );
      // desativa depois de esvaziar o uso, para passar pela trava
      await pool.query('DELETE FROM patient_chat_ids WHERE role = $1', ['E2E_TEMP']);
      await api.patch('/api/admin/patient-chat-roles/E2E_TEMP', { isActive: false }, authHeaders(adminToken));

      const res = await api.put(
        `/api/admin/patients/${patientA}/chat-ids`,
        { chatIds: { E2E_TEMP: GROUP_FAMILY } },
        authHeaders(adminToken),
      );

      expect(res.status).toBe(400);
      expect(res.data.code).toBe('UNKNOWN_CHAT_ROLE');
      expect(res.data.details.roles).toEqual(['E2E_TEMP']);
    });

    it('30. apaga papel que ninguém usa, e ele some do catálogo', async () => {
      await api.post(
        '/api/admin/patient-chat-roles',
        { code: 'E2E_TEMP', labelEs: 'a', labelPtBr: 'b' },
        authHeaders(adminToken),
      );

      const res = await api.delete('/api/admin/patient-chat-roles/E2E_TEMP', authHeaders(adminToken));

      expect(res.status).toBe(204);
      expect(await readRole('E2E_TEMP')).toBeNull();
    });

    it('31. apagar papel inexistente é 404', async () => {
      const res = await api.delete('/api/admin/patient-chat-roles/NAO_EXISTE', authHeaders(adminToken));
      expect(res.status).toBe(404);
    });

    it('32. código malformado no path é 400, não 404 enganoso', async () => {
      const res = await api.delete('/api/admin/patient-chat-roles/nao-existe', authHeaders(adminToken));
      expect(res.status).toBe(400);
    });
  });

  // ── O desempate por papel chega até a resposta da API ──────────────────────

  it('33. o desempate por papel atravessa banco → use case → HTTP', async () => {
    // O teste do ranking em si é unitário. Aqui a prova é que as
    // `match_keywords` do CATÁLOGO chegam até a resposta da API, e que cada
    // papel recebe a SUA ordem — os dois grupos têm score idêntico (mesmo
    // sobrenome), então sem o desempate os dois seletores abririam no mesmo.
    const res = await api.get(
      `/api/admin/patients/${patientA}/chat-candidates`,
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    expect(res.data.data.candidates).toHaveLength(2);

    const byRole = res.data.data.candidatesByRole as Record<string, string[]>;
    expect(Object.keys(byRole).sort()).toEqual(['FAMILY', 'HEALTH_PLAN', 'PROVIDERS']);

    // cada papel abre no grupo que se declara dele
    expect(byRole.FAMILY[0]).toBe(CHAT_FAMILIA);
    expect(byRole.PROVIDERS[0]).toBe(CHAT_EQUIPO);

    // e nenhum candidato entrou ou saiu — o desempate reordena, não filtra
    for (const ordered of Object.values(byRole)) {
      expect([...ordered].sort()).toEqual([CHAT_EQUIPO, CHAT_FAMILIA].sort());
    }
  });

  it('34. mudar as PALAVRAS na tela muda a ordem — sem deploy', async () => {
    // A prova de que o desempate é dado, não código: tiro "flia" do papel
    // FAMILY e ponho no PROVIDERS, e a ordem se inverte na mesma stack.
    await api.patch(
      '/api/admin/patient-chat-roles/FAMILY',
      { matchKeywords: ['equipo'] },
      authHeaders(adminToken),
    );
    await api.patch(
      '/api/admin/patient-chat-roles/PROVIDERS',
      { matchKeywords: ['flia'] },
      authHeaders(adminToken),
    );

    const res = await api.get(
      `/api/admin/patients/${patientA}/chat-candidates`,
      authHeaders(adminToken),
    );

    expect(res.status).toBe(200);
    const byRole = res.data.data.candidatesByRole as Record<string, string[]>;
    expect(byRole.FAMILY[0]).toBe(CHAT_EQUIPO);
    expect(byRole.PROVIDERS[0]).toBe(CHAT_FAMILIA);

    // o afterEach devolve o catálogo ao estado semeado
  });
});
