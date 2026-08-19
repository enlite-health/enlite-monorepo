import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

/**
 * A SEGUNDA FAMÍLIA VIRADA — HTTP REAL, BANCO REAL (task 3.5/3.8, design 6).
 *
 * O contrato genérico (sem grupo → `no_group`, conta em admissão →
 * `account_not_active`, cache × invalidação) já é provado em
 * `permission-enforcement-admin-users`. Repetir aqui seria custo sem informação.
 * **Este arquivo prova o que é ESPECÍFICO de `admin.patients`:**
 *
 *  1. a granularidade read × write dentro do mesmo recurso;
 *  2. as três células que NÃO são o óbvio `patient:*` — `vacancy:read` na lista
 *     de vagas do paciente e `messaging:read` nas duas rotas de conversa —, que
 *     são exatamente as que uma "uniformização" futura apagaria;
 *  3. `patient:delete`, a célula NOVA da D116, que só existe no banco depois do
 *     sync do catálogo (aqui ela é semeada à mão — ver `semear()`);
 *  4. que ALLOW em recurso sensível também vira linha na trilha (D-P4): `patient`
 *     está em SENSITIVE_RESOURCES, então aqui o acesso PERMITIDO é registrado —
 *     o contrário do que acontece em `admin.users`;
 *  5. que a família FORA de `PERMISSION_ENFORCED_ROUTES` não muda nada — que é o
 *     argumento de segurança deste PR: ele entra na `stage` sem virar ninguém.
 *
 * ⚠️ Mock do jest é PROIBIDO aqui: mockar qualquer peça apagaria a camada sob
 * teste. A única substituição são os controllers (precisam de Firebase/ClickUp/
 * Periskope, e não são o objeto do teste): os handlers devolvem 200 com um
 * marcador, então "passou" e "não passou" são inequívocos.
 *
 * O wiring real (pools, ordem dos middlewares, limpeza do `iam.*`) vem de
 * `helpers/permissionFamilyHarness` — é o mesmo contrato das outras famílias, e
 * por isso mora num lugar só.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('família admin.patients sob a decisão real por célula (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const U = {
    /** `patient:read` apenas — a pessoa que consulta ficha e não edita. */
    leitora: 'perm-pac-e2e-leitora',
    /** `patient:read|write|delete` — a admissão completa, sem vaga nem conversa. */
    admissao: 'perm-pac-e2e-admissao',
    /** `vacancy:read` + `messaging:read`, e NADA de paciente. */
    vizinha: 'perm-pac-e2e-vizinha',
  };
  const GRUPOS = {
    leitura: 'Perm Pac E2E Leitura',
    admissao: 'Perm Pac E2E Admissão',
    vizinha: 'Perm Pac E2E Vizinha',
  };

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(chave: string, valor: string): void {
    envAnterior[chave] = process.env[chave];
    process.env[chave] = valor;
  }

  async function chamar(
    metodo: string,
    caminho: string,
    uid: string | null,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${app.url}${caminho}`, {
      method: metodo,
      headers: {
        ...(uid ? { Authorization: tokenMock(uid) } : {}),
        'Content-Type': 'application/json',
      },
      ...(metodo === 'POST' || metodo === 'PUT' || metodo === 'PATCH' ? { body: '{}' } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  /**
   * `patient:delete` é a célula NOVA da D116: o seed da migration 206 só tem
   * read/write. Em produção ela nasce pelo sync do catálogo (`iam.sync_permission_cell`,
   * mig 281) quando `PERMISSION_CATALOG_SYNC_ENABLED` ligar, no fim da task 3.5.
   * Aqui a semeadura é direta porque o objeto do teste é o enforcement, não o sync.
   *
   * Removida na ENTRADA e na SAÍDA de propósito: se um processo morrer no meio
   * (OOM, Ctrl-C, timeout duro), a linha sobreviveria e `permissions-iam-schema`
   * — que afirma a matriz exata de 41 células — passaria a falhar em toda rodada
   * seguinte, sem se curar sozinha. Apagar na entrada torna a suíte idempotente.
   */
  async function removerCelulaDelete(): Promise<void> {
    await pool.query(
      `DELETE FROM iam.group_permissions
         WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = 'patient' AND action = 'delete')`,
    );
    await pool.query(`DELETE FROM iam.permissions WHERE resource = 'patient' AND action = 'delete'`);
  }

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
    await removerCelulaDelete();
  }

  async function semear(): Promise<void> {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'perm-pac-leitora@e2e.local',  'admin', 'ACTIVE', true, $4),
         ($2, 'perm-pac-admissao@e2e.local', 'admin', 'ACTIVE', true, $4),
         ($3, 'perm-pac-vizinha@e2e.local',  'admin', 'ACTIVE', true, $4)`,
      [U.leitora, U.admissao, U.vizinha, TENANT_E2E],
    );

    await pool.query(
      `INSERT INTO iam.permissions (resource, action, description, category)
         VALUES ('patient', 'delete', 'Remover pacientes de teste', 'Pacientes')`,
    );

    await grupoComCelulas(pool, { nome: GRUPOS.leitura, uid: U.leitora, celulas: [['patient', 'read']] });
    await grupoComCelulas(pool, {
      nome: GRUPOS.admissao,
      uid: U.admissao,
      celulas: [
        ['patient', 'read'],
        ['patient', 'write'],
        ['patient', 'delete'],
      ],
    });
    await grupoComCelulas(pool, {
      nome: GRUPOS.vizinha,
      uid: U.vizinha,
      celulas: [
        ['vacancy', 'read'],
        ['messaging', 'read'],
      ],
    });
  }

  /** Handlers-marcador: só dizem que chegaram. */
  function controllersMarcadores() {
    const marca = (nome: string) => (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: nome });
    return {
      patients: {
        getPatientStats: marca('getPatientStats'),
        getPatientFunnel: marca('getPatientFunnel'),
        listPatients: marca('listPatients'),
        createPatient: marca('createPatient'),
        getPatientById: marca('getPatientById'),
        listPatientAddresses: marca('listPatientAddresses'),
        createPatientAddress: marca('createPatientAddress'),
        listPatientVacancies: marca('listPatientVacancies'),
        updatePatientStatus: marca('updatePatientStatus'),
        activatePatient: marca('activatePatient'),
        updatePatientTestFlag: marca('updatePatientTestFlag'),
        purgeTestPatient: marca('purgeTestPatient'),
        updatePatientSection: marca('updatePatientSection'),
      },
      chatIds: {
        getChatGroups: marca('getChatGroups'),
        getChatMap: marca('getChatMap'),
        getChatCandidates: marca('getChatCandidates'),
        updateChatIds: marca('updateChatIds'),
      },
      chatRoles: {
        list: marca('chatRoles.list'),
        create: marca('chatRoles.create'),
        update: marca('chatRoles.update'),
        delete: marca('chatRoles.delete'),
      },
    };
  }

  async function subirApp(familiasEnforced: string): Promise<AppDeFamilia> {
    const { createAdminPatientsRoutes } = await import('@modules/case');
    const c = controllersMarcadores();
    return montarAppDeFamilia({
      enforcedRoutes: familiasEnforced,
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use(
          '/api/admin',
          createAdminPatientsRoutes(
            c.patients as never,
            auth,
            permissions,
            c.chatIds as never,
            c.chatRoles as never,
          ),
        ),
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await semear();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.patients');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    app = await subirApp('admin.patients');
  }, 30000);

  afterAll(async () => {
    await app?.fechar();
    const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
    await DatabaseConnection.getInstance().close();
    await limpar();
    await pool.end();
    for (const [chave, valor] of Object.entries(envAnterior)) {
      if (valor === undefined) delete process.env[chave];
      else process.env[chave] = valor;
    }
  });

  describe('leitura × escrita no mesmo recurso', () => {
    it('quem tem patient:read lê a lista e chega no handler', async () => {
      const res = await chamar('GET', '/api/admin/patients', U.leitora);
      expect(res).toMatchObject({ status: 200, body: { chegou: 'listPatients' } });
    });

    it('quem só lê NÃO cria paciente — read não implica write', async () => {
      const res = await chamar('POST', '/api/admin/patients', U.leitora);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'missing_cell' });
      expect(res.body.chegou).toBeUndefined();
    });

    it('quem só lê NÃO move o paciente no kanban', async () => {
      const res = await chamar('PUT', '/api/admin/patients/abc-123/status', U.leitora);
      expect(res.status).toBe(403);
    });

    it('a admissão, que tem write, cria e move', async () => {
      expect(await chamar('POST', '/api/admin/patients', U.admissao)).toMatchObject({
        status: 200,
        body: { chegou: 'createPatient' },
      });
      expect(await chamar('PUT', '/api/admin/patients/abc-123/status', U.admissao)).toMatchObject({
        status: 200,
        body: { chegou: 'updatePatientStatus' },
      });
    });
  });

  describe('as células que NÃO são patient:* (as que uma uniformização apagaria)', () => {
    it('a lista de vagas do paciente exige vacancy:read — patient:read inteiro não abre', async () => {
      const res = await chamar('GET', '/api/admin/patients/abc-123/vacancies', U.admissao);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'missing_cell' });
    });

    it('… e quem tem vacancy:read passa, mesmo sem nenhuma célula de paciente', async () => {
      const res = await chamar('GET', '/api/admin/patients/abc-123/vacancies', U.vizinha);
      expect(res).toMatchObject({ status: 200, body: { chegou: 'listPatientVacancies' } });
    });

    it.each([
      ['/api/admin/chat-groups', 'getChatGroups'],
      ['/api/admin/patients/abc-123/chat-candidates', 'getChatCandidates'],
    ])('%s exige messaging:read', async (caminho, handler) => {
      expect((await chamar('GET', caminho, U.admissao)).status).toBe(403);
      expect(await chamar('GET', caminho, U.vizinha)).toMatchObject({ status: 200, body: { chegou: handler } });
    });

    it('GRAVAR o chat-id é patient:write, não messaging — muda o cadastro do paciente', async () => {
      expect((await chamar('PUT', '/api/admin/patients/abc-123/chat-ids', U.vizinha)).status).toBe(403);
      expect(await chamar('PUT', '/api/admin/patients/abc-123/chat-ids', U.admissao)).toMatchObject({
        status: 200,
        body: { chegou: 'updateChatIds' },
      });
    });
  });

  describe('patient:delete — a célula nova da D116', () => {
    it('quem tem read mas não delete NÃO purga', async () => {
      const res = await chamar('DELETE', '/api/admin/patients/abc-123', U.leitora);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'missing_cell' });
    });

    it('quem tem a célula purga', async () => {
      const res = await chamar('DELETE', '/api/admin/patients/abc-123', U.admissao);
      expect(res).toMatchObject({ status: 200, body: { chegou: 'purgeTestPatient' } });
    });
  });

  describe('trilha (D-P4: paciente é recurso sensível)', () => {
    it('a NEGATIVA vira linha DENY com quem, o quê e sobre qual id', async () => {
      await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = $1`, [U.leitora]);

      await chamar('DELETE', '/api/admin/patients/abc-123', U.leitora);
      // A trilha é assíncrona fail-safe (nunca segura a request) — daí a espera curta.
      await new Promise((r) => setTimeout(r, 300));

      const trilha = await pool.query(
        `SELECT resource, action, decision, resource_id FROM iam.permission_audit_log WHERE user_id = $1`,
        [U.leitora],
      );
      expect(trilha.rows).toEqual([
        expect.objectContaining({
          resource: 'patient',
          action: 'delete',
          decision: 'DENY',
          resource_id: 'abc-123',
        }),
      ]);
    });

    it('o acesso PERMITIDO a paciente também é registrado — o contrário de admin.users', async () => {
      await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = $1`, [U.leitora]);

      await chamar('GET', '/api/admin/patients/abc-123', U.leitora);
      await new Promise((r) => setTimeout(r, 300));

      const trilha = await pool.query(
        `SELECT resource, action, decision FROM iam.permission_audit_log WHERE user_id = $1`,
        [U.leitora],
      );
      expect(trilha.rows).toEqual([
        expect.objectContaining({ resource: 'patient', action: 'read', decision: 'ALLOW' }),
      ]);
    });

    it('nenhuma coluna da trilha carrega PII do paciente', async () => {
      const colunas = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'iam' AND table_name = 'permission_audit_log'`,
      );
      const nomes = colunas.rows.map((r) => r.column_name);
      expect(nomes).not.toContain('patient_name');
      expect(nomes).not.toContain('email');
      expect(nomes).not.toContain('phone');
    });
  });

  describe('rollout por família — o que torna este PR seguro de mergear', () => {
    it('com admin.patients FORA de PERMISSION_ENFORCED_ROUTES, quem não tem célula nenhuma passa', async () => {
      const outra = await subirApp('admin.users');
      try {
        const res = await fetch(`${outra.url}/api/admin/patients`, {
          headers: { Authorization: tokenMock(U.vizinha) },
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ chegou: 'listPatients' });
      } finally {
        await outra.fechar();
      }
    });
  });

  it('sem credencial → 401 antes de qualquer decisão de permissão', async () => {
    expect((await chamar('GET', '/api/admin/patients', null)).status).toBe(401);
  });
});
