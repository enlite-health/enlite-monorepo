import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  limparTrilhaDrenada,
  aguardarTrilhaQuieta,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

/**
 * DUAS famílias num PR (task 3.5-A3) — HTTP real, banco real.
 *
 * Duas famílias pequenas juntas é desvio deliberado do "uma família por PR"
 * (design 6): 15 + 11 rotas com o padrão já fixado por quatro famílias não
 * justificam dois PRs. O que este arquivo prova, e é o que interessa aqui:
 *
 *  1. **As duas famílias são ligadas SEPARADAMENTE.** É a razão de a família
 *     existir como conceito: `PERMISSION_ENFORCED_ROUTES` liga uma e não a
 *     outra, e o app se comporta diferente nos dois prefixos ao mesmo tempo.
 *     Nenhuma família anterior pôde provar isso — todas as suítes tinham uma só.
 *  2. **`dedup:execute` mora em `admin.analytics`** — a célula destrutiva do A5
 *     aparece nesta família, e virar `admin.dedup` não a alcança.
 *  3. **Células "vizinhas" não se cobrem**: `analytics:read` não abre o
 *     dashboard, `recruitment:read` não abre a lista de encuadres (`match:read`)
 *     nem a do Talentum (`talentum:read`).
 *  4. **D-P4 pela AÇÃO**: `dedup:execute` é ação sensível → ALLOW vai à trilha,
 *     enquanto `analytics:read` não vai.
 *
 * ⚠️ Mock do jest é PROIBIDO aqui. A única substituição são os controllers.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('famílias admin.analytics e admin.recruitment sob decisão por célula (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const U = {
    /** `analytics:read` apenas — vê os relatórios, não o dashboard. */
    analista: 'perm-a3-e2e-analista',
    /** `dashboard:read` apenas. */
    gestao: 'perm-a3-e2e-gestao',
    /** `recruitment:read|write` — a operação de recrutamento, sem match nem talentum. */
    recrutamento: 'perm-a3-e2e-recrutamento',
    /** `dedup:read|execute` — a fusão de cadastros. */
    dedup: 'perm-a3-e2e-dedup',
  };
  const GRUPOS = {
    analista: 'Perm A3 E2E Analista',
    gestao: 'Perm A3 E2E Gestão',
    recrutamento: 'Perm A3 E2E Recrutamento',
    dedup: 'Perm A3 E2E Dedup',
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
      ...(metodo === 'POST' ? { body: '{}' } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
  }

  async function semear(): Promise<void> {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'perm-a3-analista@e2e.local',     'admin', 'ACTIVE', true, $5),
         ($2, 'perm-a3-gestao@e2e.local',       'admin', 'ACTIVE', true, $5),
         ($3, 'perm-a3-recrutamento@e2e.local', 'admin', 'ACTIVE', true, $5),
         ($4, 'perm-a3-dedup@e2e.local',        'admin', 'ACTIVE', true, $5)`,
      [U.analista, U.gestao, U.recrutamento, U.dedup, TENANT_E2E],
    );

    await grupoComCelulas(pool, { nome: GRUPOS.analista, uid: U.analista, celulas: [['analytics', 'read']] });
    await grupoComCelulas(pool, { nome: GRUPOS.gestao, uid: U.gestao, celulas: [['dashboard', 'read']] });
    await grupoComCelulas(pool, {
      nome: GRUPOS.recrutamento,
      uid: U.recrutamento,
      celulas: [
        ['recruitment', 'read'],
        ['recruitment', 'create'],
        ['recruitment', 'update'],
      ],
    });
    await grupoComCelulas(pool, {
      nome: GRUPOS.dedup,
      uid: U.dedup,
      celulas: [
        ['dedup', 'read'],
        ['dedup', 'execute'],
      ],
    });
  }

  function marcadores() {
    const marca = (nome: string) => (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: nome });
    const de = (ms: string[]) => Object.fromEntries(ms.map((m) => [m, marca(m)]));
    return {
      analytics: de(['getWorkerStats', 'getWorkersMissingDocuments', 'getWorkerVacancyEngagement',
        'listVacancies', 'getVacancyByCaseNumber', 'getVacancyIncompleteRegistrations', 'getVacancyById',
        'getDedupCandidates', 'runDeduplication', 'getGlobalMetrics', 'getZoneMetrics',
        'getReemplazosMetrics', 'getManagementMetrics', 'getZoneAnalytics', 'getCaseMetrics']),
      recruitment: de(['getClickUpCases', 'getTalentumWorkers', 'getProgresoWorkers',
        'getPublications', 'getEncuadres']),
    };
  }

  async function subirApp(familiasEnforced: string): Promise<AppDeFamilia> {
    const { createAnalyticsRoutes, createRecruitmentRoutes } = await import('@modules/matching');
    const c = marcadores();
    return montarAppDeFamilia({
      enforcedRoutes: familiasEnforced,
      montarRotas: ({ app: express, auth, permissions }) => {
        express.use('/analytics', createAnalyticsRoutes(c.analytics as never, auth, permissions));
        express.use('/api', createRecruitmentRoutes(c.recruitment as never, auth, permissions));
      },
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await semear();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.analytics;admin.recruitment');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    app = await subirApp('admin.analytics;admin.recruitment');
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

  describe('células vizinhas não se cobrem', () => {
    it('analytics:read abre os relatórios', async () => {
      expect(await chamar('GET', '/analytics/workers', U.analista)).toMatchObject({
        status: 200,
        body: { chegou: 'getWorkerStats' },
      });
    });

    it('… e NÃO abre o dashboard — dashboard:read é célula própria', async () => {
      const res = await chamar('GET', '/analytics/dashboard/global', U.analista);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'missing_cell' });
    });

    it('… e quem tem dashboard:read abre o dashboard e não os relatórios', async () => {
      expect(await chamar('GET', '/analytics/dashboard/global', U.gestao)).toMatchObject({
        status: 200,
        body: { chegou: 'getGlobalMetrics' },
      });
      expect((await chamar('GET', '/analytics/workers', U.gestao)).status).toBe(403);
    });

    it('recruitment:read NÃO abre a lista de encuadres — aquilo é match:read', async () => {
      expect(await chamar('GET', '/api/admin/recruitment/progreso', U.recrutamento)).toMatchObject({
        status: 200,
        body: { chegou: 'getProgresoWorkers' },
      });
      expect((await chamar('GET', '/api/admin/recruitment/encuadres', U.recrutamento)).status).toBe(403);
    });

    it('… nem a lista do Talentum — aquilo é talentum:read', async () => {
      expect((await chamar('GET', '/api/admin/recruitment/talentum-workers', U.recrutamento)).status).toBe(403);
    });

    it('calcular reemplazos exige recruitment:write', async () => {
      expect(await chamar('POST', '/api/admin/recruitment/calculate-reemplazos', U.recrutamento))
        .toMatchObject({ status: 200 });
      expect((await chamar('POST', '/api/admin/recruitment/calculate-reemplazos', U.analista)).status)
        .toBe(403);
    });
  });

  describe('dedup:execute mora em admin.analytics', () => {
    it('quem lê analytics não roda a deduplicação', async () => {
      const res = await chamar('POST', '/analytics/dedup/run', U.analista);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'missing_cell' });
    });

    it('quem tem dedup:execute roda — e quem só tem dedup:read vê os candidatos', async () => {
      expect(await chamar('POST', '/analytics/dedup/run', U.dedup)).toMatchObject({
        status: 200,
        body: { chegou: 'runDeduplication' },
      });
      expect(await chamar('GET', '/analytics/dedup/candidates', U.dedup)).toMatchObject({
        status: 200,
        body: { chegou: 'getDedupCandidates' },
      });
    });
  });

  describe('trilha — D-P4 pela ação', () => {
    it('o ALLOW de dedup:execute é registrado; o de analytics:read não', async () => {
      await limparTrilhaDrenada(pool, [U.dedup, U.analista]);

      await chamar('POST', '/analytics/dedup/run', U.dedup);
      await chamar('GET', '/analytics/workers', U.analista);
      const trilha = await aguardarTrilhaQuieta(
        pool,
        [U.dedup, U.analista],
        1,
        'user_id, resource, action, decision',
      );
      expect(trilha).toEqual([
        expect.objectContaining({ user_id: U.dedup, resource: 'dedup', action: 'execute', decision: 'ALLOW' }),
      ]);
    });
  });

  /**
   * O caso que só DUAS famílias no mesmo app conseguem provar: a flag liga uma e
   * não a outra, e o app se comporta diferente nos dois prefixos ao mesmo tempo.
   */
  describe('as duas famílias ligam SEPARADAMENTE — o que "família" significa', () => {
    it('com só admin.analytics enforced, recruitment passa para quem não tem célula nenhuma', async () => {
      const soAnalytics = await subirApp('admin.analytics');
      try {
        expect((await chamar('GET', '/analytics/dashboard/global', U.recrutamento, soAnalytics)).status)
          .toBe(403);
        expect(await chamar('GET', '/api/admin/recruitment/encuadres', U.recrutamento, soAnalytics))
          .toMatchObject({ status: 200, body: { chegou: 'getEncuadres' } });
      } finally {
        await soAnalytics.fechar();
      }
    });

    it('e o inverso: com só admin.recruitment enforced, analytics passa', async () => {
      const soRecruitment = await subirApp('admin.recruitment');
      try {
        expect(await chamar('GET', '/analytics/dashboard/global', U.recrutamento, soRecruitment))
          .toMatchObject({ status: 200, body: { chegou: 'getGlobalMetrics' } });
        expect((await chamar('GET', '/api/admin/recruitment/encuadres', U.recrutamento, soRecruitment)).status)
          .toBe(403);
      } finally {
        await soRecruitment.fechar();
      }
    });

    it('com NENHUMA das duas enforced, tudo passa — o que torna este PR seguro de mergear', async () => {
      const nenhuma = await subirApp('admin.users');
      try {
        expect(await chamar('POST', '/analytics/dedup/run', U.analista, nenhuma)).toMatchObject({
          status: 200,
          body: { chegou: 'runDeduplication' },
        });
      } finally {
        await nenhuma.fechar();
      }
    });
  });

  it('sem credencial → 401 antes de qualquer decisão de permissão', async () => {
    expect((await chamar('GET', '/analytics/workers', null)).status).toBe(401);
  });
});
