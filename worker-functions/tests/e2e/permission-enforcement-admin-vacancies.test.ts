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
 * A QUARTA E MAIOR FAMÍLIA (task 3.5/3.8, design 6) — HTTP real, banco real.
 *
 * O contrato genérico (sem grupo, conta inativa, cache × invalidação) já é
 * provado em `permission-enforcement-admin-users`. **Aqui se prova o que é
 * específico de `admin.vacancies`:**
 *
 *  1. **As três células destrutivas separadas da escrita comum** —
 *     `vacancy:delete`, `interview:delete` e `match:execute`. Quem edita vaga
 *     não apaga vaga; quem cria slot não cancela slot; quem lê o match não roda
 *     o match. É a razão de a família ser a penúltima da ordem do design 6.
 *  2. **`funnel:write` ≠ `vacancy:write`** — mover no Kanban e editar o cadastro
 *     da vaga são decisões de papéis diferentes na operação real (a coordenação
 *     move; quem abre a vaga edita). Uma "simplificação" futura juntaria as duas.
 *  3. **`talentum:write`** — publicar num portal EXTERNO não é escrever na nossa
 *     base. É a célula que separa "mexer aqui dentro" de "expor lá fora".
 *  4. **`dashboard:read` é célula própria** — quem vê a vaga não vê
 *     necessariamente a capacidade e os alertas do coordenador.
 *  5. **D-P4 pela AÇÃO, não pelo recurso**: `vacancy` e `interview` não estão em
 *     SENSITIVE_RESOURCES, mas `delete` e `execute` estão em SENSITIVE_ACTIONS —
 *     então o ALLOW dessas três vai para a trilha, e o das leituras não vai.
 *     É o único lugar da change onde a trilha é decidida pelo verbo.
 *  6. Família fora de `PERMISSION_ENFORCED_ROUTES` não muda nada.
 *
 * ⚠️ Mock do jest é PROIBIDO aqui. A única substituição são os controllers
 * (pedem GCS/Talentum/Meet e não são o objeto do teste): devolvem 200 com um
 * marcador, então "passou" e "não passou" são inequívocos.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('família admin.vacancies sob a decisão real por célula (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const U = {
    /** `vacancy:read|write` — quem abre e edita a vaga, e NADA além. */
    editora: 'perm-vac-e2e-editora',
    /** `funnel:read|write` — a coordenação: move no Kanban, não edita a vaga. */
    coordenacao: 'perm-vac-e2e-coordenacao',
    /** as três destrutivas: `vacancy:delete`, `interview:delete`, `match:execute`. */
    destrutiva: 'perm-vac-e2e-destrutiva',
    /** `talentum:write` + `dashboard:read` — as duas células "de fronteira". */
    fronteira: 'perm-vac-e2e-fronteira',
  };
  const GRUPOS = {
    editora: 'Perm Vac E2E Editora',
    coordenacao: 'Perm Vac E2E Coordenação',
    destrutiva: 'Perm Vac E2E Destrutiva',
    fronteira: 'Perm Vac E2E Fronteira',
  };

  const envAnterior: Record<string, string | undefined> = {};
  function setEnv(chave: string, valor: string): void {
    if (!(chave in envAnterior)) envAnterior[chave] = process.env[chave];
    process.env[chave] = valor;
  }

  async function chamar(
    metodo: string,
    caminho: string,
    uid: string | null,
    alvo: AppDeFamilia = app,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${alvo.url}${caminho}`, {
      method: metodo,
      headers: {
        ...(uid ? { Authorization: tokenMock(uid) } : {}),
        'Content-Type': 'application/json',
      },
      ...(['POST', 'PUT', 'PATCH'].includes(metodo) ? { body: '{}' } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
  }

  async function semear(): Promise<void> {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'perm-vac-editora@e2e.local',     'admin', 'ACTIVE', true, $5),
         ($2, 'perm-vac-coordenacao@e2e.local', 'admin', 'ACTIVE', true, $5),
         ($3, 'perm-vac-destrutiva@e2e.local',  'admin', 'ACTIVE', true, $5),
         ($4, 'perm-vac-fronteira@e2e.local',   'admin', 'ACTIVE', true, $5)`,
      [U.editora, U.coordenacao, U.destrutiva, U.fronteira, TENANT_E2E],
    );

    await grupoComCelulas(pool, {
      nome: GRUPOS.editora,
      uid: U.editora,
      celulas: [
        ['vacancy', 'read'],
        ['vacancy', 'write'],
      ],
    });
    await grupoComCelulas(pool, {
      nome: GRUPOS.coordenacao,
      uid: U.coordenacao,
      celulas: [
        ['funnel', 'read'],
        ['funnel', 'write'],
      ],
    });
    await grupoComCelulas(pool, {
      nome: GRUPOS.destrutiva,
      uid: U.destrutiva,
      celulas: [
        ['vacancy', 'delete'],
        ['interview', 'delete'],
        ['match', 'execute'],
      ],
    });
    await grupoComCelulas(pool, {
      nome: GRUPOS.fronteira,
      uid: U.fronteira,
      celulas: [
        ['talentum', 'write'],
        ['dashboard', 'read'],
      ],
    });
  }

  /** Handlers-marcador: só dizem que chegaram. */
  function marcadores() {
    const marca = (nome: string) => (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: nome });
    const de = (prefixo: string, metodos: string[]) =>
      Object.fromEntries(metodos.map((m) => [m, marca(`${prefixo}.${m}`)]));
    return {
      vac: de('vac', ['listVacancies', 'getVacanciesStats', 'getNextVacancyNumber', 'getCasesForSelect', 'getVacancyById']),
      crud: de('crud', ['createVacancy', 'updateVacancy', 'deleteVacancy']),
      talentum: de('talentum', ['publishToTalentum', 'unpublishFromTalentum', 'generateTalentumDescription',
        'updateTalentumDescription', 'generateAIContent', 'syncFromTalentum', 'getPrescreeningConfig',
        'getTalentumStatus', 'savePrescreeningConfig']),
      match: de('match', ['getMatchResults', 'triggerMatch', 'updateEncuadreResult']),
      meet: de('meet', ['lookupMeetDatetime', 'updateMeetLinks']),
      social: de('social', ['generateSocialLink', 'getSocialLinksStats']),
      funnel: de('funnel', ['getEncuadreFunnel', 'moveEncuadre', 'rejectBlockedApplication', 'undismissBlockedApplication']),
      dash: de('dash', ['getCoordinatorCapacity', 'getAlerts', 'getConversionByChannel']),
      slots: de('slots', ['createSlots', 'getSlots', 'bookSlot', 'cancelSlot']),
      addr: de('addr', ['resolveAddressReview']),
      table: de('table', ['getEncuadreFunnelTable']),
    };
  }

  async function subirApp(familiasEnforced: string): Promise<AppDeFamilia> {
    const { createAdminVacanciesRoutes } = await import('@modules/matching');
    const c = marcadores();
    return montarAppDeFamilia({
      enforcedRoutes: familiasEnforced,
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use(
          '/api/admin',
          createAdminVacanciesRoutes(
            c.vac as never, c.crud as never, c.talentum as never, c.match as never,
            c.meet as never, c.social as never, c.funnel as never, c.dash as never,
            c.slots as never, auth, permissions, c.addr as never, c.table as never,
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
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.vacancies');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    app = await subirApp('admin.vacancies');
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

  describe('as três destrutivas, separadas da escrita comum', () => {
    it('quem EDITA vaga não APAGA vaga', async () => {
      expect(await chamar('PUT', '/api/admin/vacancies/v1', U.editora)).toMatchObject({
        status: 200,
        body: { chegou: 'crud.updateVacancy' },
      });

      const negado = await chamar('DELETE', '/api/admin/vacancies/v1', U.editora);
      expect(negado.status).toBe(403);
      expect(negado.body).toMatchObject({ code: 'missing_cell' });
    });

    it('… e quem tem vacancy:delete apaga, sem poder editar', async () => {
      expect(await chamar('DELETE', '/api/admin/vacancies/v1', U.destrutiva)).toMatchObject({
        status: 200,
        body: { chegou: 'crud.deleteVacancy' },
      });
      expect((await chamar('PUT', '/api/admin/vacancies/v1', U.destrutiva)).status).toBe(403);
    });

    it('RODAR o match é match:execute — vacancy:write inteiro não abre', async () => {
      expect((await chamar('POST', '/api/admin/vacancies/v1/match', U.editora)).status).toBe(403);
      expect(await chamar('POST', '/api/admin/vacancies/v1/match', U.destrutiva)).toMatchObject({
        status: 200,
        body: { chegou: 'match.triggerMatch' },
      });
    });

    it('CANCELAR slot é interview:delete — nem editora nem coordenação cancelam', async () => {
      for (const uid of [U.editora, U.coordenacao]) {
        expect((await chamar('DELETE', '/api/admin/interview-slots/s1', uid)).status).toBe(403);
      }
      expect(await chamar('DELETE', '/api/admin/interview-slots/s1', U.destrutiva)).toMatchObject({
        status: 200,
        body: { chegou: 'slots.cancelSlot' },
      });
    });
  });

  describe('funnel:write ≠ vacancy:write — mover no Kanban não é editar a vaga', () => {
    it('a editora da vaga NÃO move no funil', async () => {
      expect((await chamar('PUT', '/api/admin/encuadres/e1/move', U.editora)).status).toBe(403);
    });

    it('a coordenação move, e NÃO edita a vaga', async () => {
      expect(await chamar('PUT', '/api/admin/encuadres/e1/move', U.coordenacao)).toMatchObject({
        status: 200,
        body: { chegou: 'funnel.moveEncuadre' },
      });
      expect((await chamar('PUT', '/api/admin/vacancies/v1', U.coordenacao)).status).toBe(403);
    });

    it('rejeitar/restaurar candidatura bloqueada é funnel:write', async () => {
      expect(await chamar('POST', '/api/admin/vacancies/blocked-applications/b1/reject', U.coordenacao))
        .toMatchObject({ status: 200, body: { chegou: 'funnel.rejectBlockedApplication' } });
      expect((await chamar('POST', '/api/admin/vacancies/blocked-applications/b1/reject', U.editora)).status)
        .toBe(403);
    });
  });

  describe('as células de fronteira', () => {
    it('publicar no Talentum é talentum:write — expor lá fora não é escrever aqui dentro', async () => {
      expect((await chamar('POST', '/api/admin/vacancies/v1/publish-talentum', U.editora)).status).toBe(403);
      expect(await chamar('POST', '/api/admin/vacancies/v1/publish-talentum', U.fronteira)).toMatchObject({
        status: 200,
        body: { chegou: 'talentum.publishToTalentum' },
      });
    });

    it('o dashboard do coordenador é dashboard:read — ver vaga não é ver capacidade', async () => {
      expect((await chamar('GET', '/api/admin/dashboard/coordinator-capacity', U.editora)).status).toBe(403);
      expect(await chamar('GET', '/api/admin/dashboard/alerts', U.fronteira)).toMatchObject({
        status: 200,
        body: { chegou: 'dash.getAlerts' },
      });
    });
  });

  describe('trilha — aqui ela é decidida pelo VERBO, não pelo recurso', () => {
    it('o ALLOW de uma AÇÃO sensível (delete) é registrado, mesmo o recurso não sendo sensível', async () => {
      await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = $1`, [U.destrutiva]);

      await chamar('DELETE', '/api/admin/vacancies/v1', U.destrutiva);
      await new Promise((r) => setTimeout(r, 300));

      const trilha = await pool.query(
        `SELECT resource, action, decision, resource_id FROM iam.permission_audit_log WHERE user_id = $1`,
        [U.destrutiva],
      );
      expect(trilha.rows).toEqual([
        expect.objectContaining({ resource: 'vacancy', action: 'delete', decision: 'ALLOW', resource_id: 'v1' }),
      ]);
    });

    it('… e o ALLOW de uma LEITURA de vaga não enche a trilha', async () => {
      await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = $1`, [U.editora]);

      await chamar('GET', '/api/admin/vacancies', U.editora);
      await new Promise((r) => setTimeout(r, 300));

      const trilha = await pool.query(
        `SELECT count(*)::int AS n FROM iam.permission_audit_log WHERE user_id = $1`,
        [U.editora],
      );
      expect(trilha.rows[0].n).toBe(0);
    });

    it('a NEGATIVA é registrada sempre, sensível ou não', async () => {
      await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = $1`, [U.coordenacao]);

      await chamar('PUT', '/api/admin/vacancies/v1', U.coordenacao);
      await new Promise((r) => setTimeout(r, 300));

      const trilha = await pool.query(
        `SELECT resource, action, decision FROM iam.permission_audit_log WHERE user_id = $1`,
        [U.coordenacao],
      );
      expect(trilha.rows).toEqual([
        expect.objectContaining({ resource: 'vacancy', action: 'write', decision: 'DENY' }),
      ]);
    });
  });

  describe('rollout por família — o que torna este PR seguro de mergear', () => {
    it('com admin.vacancies FORA de PERMISSION_ENFORCED_ROUTES, quem não tem célula nenhuma passa', async () => {
      const outra = await subirApp('admin.users');
      try {
        const res = await fetch(`${outra.url}/api/admin/vacancies/v1`, {
          method: 'DELETE',
          headers: { Authorization: tokenMock(U.coordenacao) },
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ chegou: 'crud.deleteVacancy' });
      } finally {
        await outra.fechar();
      }
    });
  });

  it('sem credencial → 401 antes de qualquer decisão de permissão', async () => {
    expect((await chamar('GET', '/api/admin/vacancies', null)).status).toBe(401);
  });
});
