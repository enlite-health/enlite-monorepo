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
 * A ÚLTIMA família da task 3.5 (A6) — e a que ZERA o `PENDING_DECLARATIONS`.
 *
 * São as 10 rotas que o perímetro de governança não alcançava: `requireStaff`,
 * mas moram em `/api/workers/` e `/api/cases/`, fora de `GOVERNED_PREFIXES`.
 * Eram `not_governed` — invisíveis ao deny-by-default, à dívida e ao oráculo —
 * até entrarem por NOME no PR #237.
 *
 * O que este arquivo prova, e é o que justifica a família SEPARADA:
 *
 *  1. **Virar `admin.workers` NÃO vira estas rotas.** É a razão de elas não terem
 *     sido dobradas naquela família, contra a recomendação do plano: são a parte
 *     menos exercitada da superfície, e dobrá-las faria com que, na primeira vez
 *     que fossem enforçadas na vida, fossem enforçadas junto com outras 31.
 *     Célula é transversal; família é a alavanca de rollout.
 *  2. **Escrever status de funil é `worker:write`** — quem só lê o dashboard de
 *     operação não move ninguém no funil. Era exatamente o buraco: antes do #237
 *     essas rotas passariam batido no flip, e `worker:read` sozinho seguiria
 *     movendo o funil.
 *  3. **Vencimento de documento é `worker_document`, não `worker`.**
 *  4. **D-P4**: `worker_document` é recurso sensível → ALLOW também vai à trilha.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('família admin.encuadre — as 10 rotas que o perímetro não alcançava (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const U = {
    /** `worker:read` + `match:read` — vê dashboards e encuadres, não move o funil. */
    observadora: 'perm-enc-e2e-observadora',
    /** `worker:read|write` — a coordenação: move status e ocupação. */
    coordenacao: 'perm-enc-e2e-coordenacao',
    /** `worker_document:read|write` — a mesa de documentos. */
    documentos: 'perm-enc-e2e-documentos',
  };
  const GRUPOS = {
    observadora: 'Perm Enc E2E Observadora',
    coordenacao: 'Perm Enc E2E Coordenação',
    documentos: 'Perm Enc E2E Documentos',
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
      ...(metodo === 'PUT' ? { body: '{}' } : {}),
    });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  }

  async function limpar(): Promise<void> {
    await limparIamFixtures(pool, { uids: Object.values(U), grupos: Object.values(GRUPOS) });
  }

  async function semear(): Promise<void> {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, 'perm-enc-observadora@e2e.local', 'admin', 'ACTIVE', true, $4),
         ($2, 'perm-enc-coordenacao@e2e.local', 'admin', 'ACTIVE', true, $4),
         ($3, 'perm-enc-documentos@e2e.local',  'admin', 'ACTIVE', true, $4)`,
      [U.observadora, U.coordenacao, U.documentos, TENANT_E2E],
    );
    await grupoComCelulas(pool, {
      nome: GRUPOS.observadora,
      uid: U.observadora,
      celulas: [
        ['worker', 'read'],
        ['match', 'read'],
      ],
    });
    await grupoComCelulas(pool, {
      nome: GRUPOS.coordenacao,
      uid: U.coordenacao,
      celulas: [
        ['worker', 'read'],
        ['worker', 'write'],
      ],
    });
    await grupoComCelulas(pool, {
      nome: GRUPOS.documentos,
      uid: U.documentos,
      celulas: [
        ['worker_document', 'read'],
        ['worker_document', 'write'],
      ],
    });
  }

  async function subirApp(familiasEnforced: string): Promise<AppDeFamilia> {
    const { createWorkerEncuadreRoutes } = await import(
      '@modules/matching/interfaces/routes/workerEncuadreRoutes'
    );
    const marca = (nome: string) => (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: nome });
    const controller = Object.fromEntries(
      ['getStatusDashboard', 'getWorkersByStatus', 'updateWorkerStatus', 'updateOccupation',
       'getDocsExpiringSoon', 'updateDocExpiry', 'getWorkerEncuadres', 'getWorkerCases',
       'getCaseEncuadres', 'getCaseWorkers'].map((m) => [m, marca(m)]),
    );
    return montarAppDeFamilia({
      enforcedRoutes: familiasEnforced,
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api', createWorkerEncuadreRoutes(controller as never, auth, permissions)),
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await semear();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.encuadre');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    app = await subirApp('admin.encuadre');
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

  /**
   * O caso decisivo do desenho: `admin.workers` declara as MESMAS 5 células, mas
   * virar aquela família não vira estas rotas.
   */
  describe('a família é a ALAVANCA — `admin.workers` não alcança estas rotas', () => {
    it('com admin.workers enforced e admin.encuadre FORA, quem não tem célula move o funil', async () => {
      const soWorkers = await subirApp('admin.workers');
      try {
        expect(await chamar('PUT', '/api/workers/w1/status', U.documentos, soWorkers)).toMatchObject({
          status: 200,
          body: { chegou: 'updateWorkerStatus' },
        });
      } finally {
        await soWorkers.fechar();
      }
    });

    it('… e com admin.encuadre enforced, o mesmo staff é negado', async () => {
      const res = await chamar('PUT', '/api/workers/w1/status', U.documentos);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'missing_cell' });
    });
  });

  describe('escrever status de funil é worker:write — o buraco que o #237 fechou', () => {
    it('quem só LÊ o dashboard de operação não move ninguém no funil', async () => {
      expect(await chamar('GET', '/api/workers/status-dashboard', U.observadora)).toMatchObject({
        status: 200,
        body: { chegou: 'getStatusDashboard' },
      });

      for (const caminho of ['/api/workers/w1/status', '/api/workers/w1/occupation']) {
        const res = await chamar('PUT', caminho, U.observadora);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'missing_cell' });
      }
    });

    it('a coordenação move status e ocupação', async () => {
      expect(await chamar('PUT', '/api/workers/w1/status', U.coordenacao)).toMatchObject({
        status: 200,
        body: { chegou: 'updateWorkerStatus' },
      });
      expect(await chamar('PUT', '/api/workers/w1/occupation', U.coordenacao)).toMatchObject({
        status: 200,
        body: { chegou: 'updateOccupation' },
      });
    });
  });

  describe('vencimento de documento é worker_document, não worker', () => {
    it('a coordenação (worker:*) NÃO mexe em vencimento de documento', async () => {
      expect((await chamar('GET', '/api/workers/docs-expiring', U.coordenacao)).status).toBe(403);
      expect((await chamar('PUT', '/api/workers/w1/doc-expiry', U.coordenacao)).status).toBe(403);
    });

    it('a mesa de documentos mexe, e não move o funil', async () => {
      expect(await chamar('GET', '/api/workers/docs-expiring', U.documentos)).toMatchObject({
        status: 200,
        body: { chegou: 'getDocsExpiringSoon' },
      });
      expect(await chamar('PUT', '/api/workers/w1/doc-expiry', U.documentos)).toMatchObject({
        status: 200,
        body: { chegou: 'updateDocExpiry' },
      });
      expect((await chamar('PUT', '/api/workers/w1/status', U.documentos)).status).toBe(403);
    });
  });

  describe('as 4 leituras de encuadre/caso são match:read', () => {
    it.each([
      ['/api/workers/w1/encuadres', 'getWorkerEncuadres'],
      ['/api/workers/w1/cases', 'getWorkerCases'],
      ['/api/cases/42/encuadres', 'getCaseEncuadres'],
      ['/api/cases/42/workers', 'getCaseWorkers'],
    ])('%s exige match:read', async (caminho, handler) => {
      expect(await chamar('GET', caminho, U.observadora)).toMatchObject({
        status: 200,
        body: { chegou: handler },
      });
      expect((await chamar('GET', caminho, U.documentos)).status).toBe(403);
    });
  });

  describe('trilha (D-P4: worker_document é recurso sensível)', () => {
    it('o ALLOW de worker_document é registrado; o de worker:read não', async () => {
      await pool.query(`DELETE FROM iam.permission_audit_log WHERE user_id = ANY($1)`, [
        [U.documentos, U.observadora],
      ]);

      await chamar('GET', '/api/workers/docs-expiring', U.documentos);
      await chamar('GET', '/api/workers/status-dashboard', U.observadora);
      await new Promise((r) => setTimeout(r, 300));

      const trilha = await pool.query(
        `SELECT user_id, resource, action, decision FROM iam.permission_audit_log WHERE user_id = ANY($1)`,
        [[U.documentos, U.observadora]],
      );
      expect(trilha.rows).toEqual([
        expect.objectContaining({
          user_id: U.documentos,
          resource: 'worker_document',
          action: 'read',
          decision: 'ALLOW',
        }),
      ]);
    });
  });

  it('sem credencial → 401 antes de qualquer decisão de permissão', async () => {
    expect((await chamar('GET', '/api/workers/status-dashboard', null)).status).toBe(401);
  });
});
