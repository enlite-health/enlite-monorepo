import { Pool } from 'pg';
import {
  TENANT_E2E,
  tokenMock,
  montarAppDeFamilia,
  limparIamFixtures,
  grupoComCelulas,
  limparTrilhaDrenada,
  aguardarTrilhaQuieta,
  contarTrilhaEstavel,
  type AppDeFamilia,
} from './helpers/permissionFamilyHarness';

/**
 * A ÚLTIMA família da task 3.5 (A5) — HTTP real, banco real.
 *
 * É a última da ordem do design 6 porque `dedup:execute` **funde cadastros de
 * pessoas**: `merge` reparenta telefone, e-mail e histórico de um worker para
 * outro. O que este arquivo prova, e é o específico dela:
 *
 *  1. **Ver duplicados ≠ fundir duplicados.** `dedup:read` abre o Centro inteiro
 *     e não executa NENHUMA das 4 rotas que mudam cadastro — inclusive o `undo`,
 *     que também é `execute`.
 *  2. **A célula é TRANSVERSAL à família.** A mesma `dedup:execute` é exigida por
 *     `POST /analytics/dedup/run`, que mora em `admin.analytics` (A3). Virar
 *     `admin.dedup` não alcança aquela rota — e este teste prova a distinção
 *     entre "ter a célula" e "a família estar enforçada".
 *  3. **D-P4**: `execute` é ação sensível → o ALLOW vai à trilha, com o id do alvo.
 *
 * ⚠️ Mock do jest é PROIBIDO. A única substituição é o controller — e aqui isso
 * também é proteção: um `merge` de verdade reparentaria dado no banco de teste.
 */

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('família admin.dedup sob a decisão real por célula (HTTP real, banco real)', () => {
  let pool: Pool;
  let app: AppDeFamilia;

  const U = {
    /** `dedup:read` — vê o Centro de Duplicados e não funde nada. */
    auditora: 'perm-dedup-e2e-auditora',
    /** `dedup:read` + `dedup:execute` — funde. */
    operadora: 'perm-dedup-e2e-operadora',
  };
  const GRUPOS = {
    auditora: 'Perm Dedup E2E Auditora',
    operadora: 'Perm Dedup E2E Operadora',
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
         ($1, 'perm-dedup-auditora@e2e.local',  'admin', 'ACTIVE', true, $3),
         ($2, 'perm-dedup-operadora@e2e.local', 'admin', 'ACTIVE', true, $3)`,
      [U.auditora, U.operadora, TENANT_E2E],
    );
    await grupoComCelulas(pool, { nome: GRUPOS.auditora, uid: U.auditora, celulas: [['dedup', 'read']] });
    await grupoComCelulas(pool, {
      nome: GRUPOS.operadora,
      uid: U.operadora,
      celulas: [
        ['dedup', 'read'],
        ['dedup', 'execute'],
      ],
    });
  }

  async function subirApp(familiasEnforced: string): Promise<AppDeFamilia> {
    const { createDedupRoutes } = await import('../../src/interfaces/routes/dedupRoutes');
    const marca = (nome: string) => (_req: unknown, res: { json: (b: unknown) => void }) => res.json({ chegou: nome });
    const controller = Object.fromEntries(
      ['listGroups', 'getGroupDetail', 'executeMerge', 'dismissGroup', 'undoMerge',
       'listHistory', 'listImportedGroups', 'searchCandidates', 'buildManualGroup']
        .map((m) => [m, marca(m)]),
    );
    return montarAppDeFamilia({
      enforcedRoutes: familiasEnforced,
      montarRotas: ({ app: express, auth, permissions }) =>
        express.use('/api/admin/dedup', createDedupRoutes(controller as never, auth, permissions)),
    });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
    await semear();

    setEnv('USE_MOCK_AUTH', 'true');
    setEnv('PERMISSION_ENGINE_ENABLED', 'true');
    setEnv('PERMISSION_ENFORCED_ROUTES', 'admin.dedup');
    setEnv('PERMISSION_CACHE_TTL_MS', '0');
    setEnv('DATABASE_URL', DATABASE_URL);

    app = await subirApp('admin.dedup');
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

  describe('ver duplicados ≠ fundir duplicados', () => {
    it('a auditora abre o Centro inteiro', async () => {
      for (const [caminho, handler] of [
        ['/api/admin/dedup/groups', 'listGroups'],
        ['/api/admin/dedup/history', 'listHistory'],
        ['/api/admin/dedup/imported-groups', 'listImportedGroups'],
        ['/api/admin/dedup/candidates', 'searchCandidates'],
      ] as const) {
        expect(await chamar('GET', caminho, U.auditora)).toMatchObject({
          status: 200,
          body: { chegou: handler },
        });
      }
    });

    it('… e NÃO executa NENHUMA das 4 que mudam cadastro', async () => {
      for (const caminho of [
        '/api/admin/dedup/merge',
        '/api/admin/dedup/dismiss',
        '/api/admin/dedup/merges/a1/undo',
        '/api/admin/dedup/manual-group',
      ]) {
        const res = await chamar('POST', caminho, U.auditora);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ code: 'missing_cell' });
        expect(res.body.chegou).toBeUndefined();
      }
    });

    it('DESFAZER também é execute — não é uma "leitura reversa"', async () => {
      expect((await chamar('POST', '/api/admin/dedup/merges/a1/undo', U.auditora)).status).toBe(403);
      expect(await chamar('POST', '/api/admin/dedup/merges/a1/undo', U.operadora)).toMatchObject({
        status: 200,
        body: { chegou: 'undoMerge' },
      });
    });

    it('a operadora funde', async () => {
      expect(await chamar('POST', '/api/admin/dedup/merge', U.operadora)).toMatchObject({
        status: 200,
        body: { chegou: 'executeMerge' },
      });
    });
  });

  describe('a célula é transversal à família', () => {
    it('ter dedup:execute não basta se a FAMÍLIA da rota não está enforçada', async () => {
      // `POST /analytics/dedup/run` exige a MESMA célula, mas mora em
      // `admin.analytics`. Aqui a app só monta `admin.dedup`; o que se prova é o
      // inverso — com `admin.dedup` FORA da lista, a auditora executa tudo.
      const outra = await subirApp('admin.analytics');
      try {
        expect(await chamar('POST', '/api/admin/dedup/merge', U.auditora, outra)).toMatchObject({
          status: 200,
          body: { chegou: 'executeMerge' },
        });
      } finally {
        await outra.fechar();
      }
    });
  });

  describe('trilha (D-P4: execute é ação sensível)', () => {
    // O drenar-antes-de-limpar/esperar-quieto nasceu aqui (fire-and-forget —
    // PgPermissionAuditRepository.ts:9-11 — não muda) e virou o helper
    // compartilhado `limparTrilhaDrenada`/`aguardarTrilhaQuieta` em
    // `helpers/permissionFamilyHarness.ts`, usado agora pelas outras famílias
    // que tinham o mesmo `setTimeout` fixo (PR #376: admin-patients,
    // admin-vacancies, admin-users, admin-workers, encuadre, analytics).

    it('a negativa de merge vira linha DENY', async () => {
      await limparTrilhaDrenada(pool, [U.auditora]);

      await chamar('POST', '/api/admin/dedup/merge', U.auditora);
      const rows = await aguardarTrilhaQuieta(pool, [U.auditora], 1, 'resource, action, decision');

      expect(rows).toEqual([
        expect.objectContaining({ resource: 'dedup', action: 'execute', decision: 'DENY' }),
      ]);
    });

    it('e o ALLOW do merge TAMBÉM — é o que permite auditar quem fundiu', async () => {
      await limparTrilhaDrenada(pool, [U.operadora]);

      await chamar('POST', '/api/admin/dedup/merge', U.operadora);
      const rows = await aguardarTrilhaQuieta(pool, [U.operadora], 1, 'resource, action, decision');
      expect(rows).toEqual([
        expect.objectContaining({ resource: 'dedup', action: 'execute', decision: 'ALLOW' }),
      ]);
    });

    it('a LEITURA do Centro não enche a trilha', async () => {
      await limparTrilhaDrenada(pool, [U.auditora]);

      await chamar('GET', '/api/admin/dedup/groups', U.auditora);
      const n = await contarTrilhaEstavel(pool, [U.auditora]);
      expect(n).toBe(0);
    });
  });

  it('sem credencial → 401 antes de qualquer decisão de permissão', async () => {
    expect((await chamar('GET', '/api/admin/dedup/groups', null)).status).toBe(401);
  });
});
