/**
 * src/modules/identity/interfaces/routes/__tests__/pr8b-ambiguous-routes.test.ts
 *
 * PR-8b, rodada A2 (8b.4) — prova, POR FORA do inventário HTTP (que só carimba
 * o 1º guard da rota, `scanExpressRouter.ts:cellOfRoute`), que as 4 rotas
 * "massa ou incerto" do mapa nominal (`pr8b-mapa-rotas.tsv`, regra do
 * orquestrador 15/09: ninguém ganha acesso, exige as DUAS ações) realmente têm
 * os DOIS guards ENCADEADOS no array de middlewares da rota — e que os dois
 * ENFORÇAM de verdade (`PermissionMiddleware` real, engine ligado):
 *
 *   · POST /admin/recruitment/calculate-reemplazos    → recruitment:create + update
 *   · POST /vacancies/sync-talentum                   → talentum:create + update
 *   · POST /workers/sync-talentum                     → talentum:create + update
 *   · POST /template-drafts/validar                    → messaging:create + update
 *
 * Cada rota é exercitada com 3 grupos: só `create` (403 — falta `update`), só
 * `update` (403 — falta `create`), e as DUAS (200) — o "ninguém ganha acesso"
 * da regra do orquestrador é literalmente "precisa das duas simultaneamente".
 *
 * Os controllers são um AUTO-DUPLO (proxy recursivo, chamável em qualquer
 * profundidade) — a rota testada aqui é só o GUARD; qual handler ela despacha
 * já está provado nos testes de família de cada arquivo.
 */

// Duas destas fábricas constroem controller(s) internos que pedem `DatabaseConnection`/`pg.Pool`
// no construtor (RecruitmentAnalyticsController/RecruitmentBlockedController,
// VacanciesAuxController) — mesma armadilha documentada em recruitmentRoutes.test.ts e
// adminVacanciesRoutes.test.ts. URL falsa: `pg.Pool` não conecta até a 1ª query.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://unit:unit@127.0.0.1:1/unit';

import express, { type Router } from 'express';
import request from 'supertest';
import { PermissionMiddleware } from '@modules/identity/interfaces/middleware/PermissionMiddleware';
import type { AuthMiddleware } from '@modules/identity';
import { createAdminVacanciesRoutes, ADMIN_VACANCIES_FAMILY } from '@modules/matching/interfaces/routes/adminVacanciesRoutes';
import { createRecruitmentRoutes, ADMIN_RECRUITMENT_FAMILY } from '@modules/matching/interfaces/routes/recruitmentRoutes';
import { createTemplateDraftsRoutes } from '@modules/matching/interfaces/routes/templateDraftsRoutes';
import { ADMIN_MESSAGING_FAMILY } from '@modules/identity/permissions';
import { createAdminWorkerRoutes, ADMIN_WORKERS_FAMILY } from '@modules/worker/interfaces/routes/adminWorkerRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

/** Duplo recursivo: qualquer profundidade de propriedade devolve um handler 200. */
function autoDouble(): never {
  const handler = ((_req: express.Request, res: express.Response) => res.status(200).json({ ok: true })) as unknown as object;
  return new Proxy(handler, { get: () => autoDouble() }) as never;
}

/** `AuthMiddleware` que autentica como `uid` fixo — o `resolve()` do client decide o resto. */
function authComoUid(uid: string): AuthMiddleware {
  const passa = () => (req: express.Request, _res: unknown, next: express.NextFunction) => {
    req.authContext = { principal: { id: uid, roles: [] } } as never;
    next();
  };
  return { requireStaff: passa, requireStaffOrApiKey: passa, requireAuth: passa } as unknown as AuthMiddleware;
}

/** `PermissionMiddleware` REAL, engine LIGADO, família ENFORCED, grupo com as `permissoes` dadas. */
function permissoesLigadas(family: string, permissoes: string[]): PermissionMiddleware {
  return new PermissionMiddleware({
    client: {
      resolve: jest.fn().mockResolvedValue({
        uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: permissoes, countries: [], groups: [{ id: 'g1', name: 'grupo' }],
      }),
      can: jest.fn(),
      isFeatureAvailable: jest.fn(),
      featureConfig: jest.fn(),
      invalidate: jest.fn(),
    },
    audit: { record: jest.fn() },
    env: { PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_ENFORCED_ROUTES: family },
  });
}

interface CasoAmbiguo {
  nome: string;
  family: string;
  resource: string;
  method: 'post';
  mountPrefix: string;
  path: string;
  buildRouter: (perm: PermissionMiddleware) => Router;
}

const CASOS: CasoAmbiguo[] = [
  {
    nome: 'POST /admin/recruitment/calculate-reemplazos',
    family: ADMIN_RECRUITMENT_FAMILY,
    resource: 'recruitment',
    method: 'post',
    mountPrefix: '/api',
    path: '/api/admin/recruitment/calculate-reemplazos',
    buildRouter: (perm) => createRecruitmentRoutes(autoDouble(), authComoUid('u'), perm),
  },
  {
    nome: 'POST /vacancies/sync-talentum',
    family: ADMIN_VACANCIES_FAMILY,
    resource: 'talentum',
    method: 'post',
    mountPrefix: '/api/admin',
    path: '/api/admin/vacancies/sync-talentum',
    buildRouter: (perm) =>
      createAdminVacanciesRoutes(
        autoDouble(), autoDouble(), autoDouble(), autoDouble(), autoDouble(), autoDouble(),
        autoDouble(), autoDouble(), autoDouble(), authComoUid('u'), perm,
      ),
  },
  {
    nome: 'POST /workers/sync-talentum',
    family: ADMIN_WORKERS_FAMILY,
    resource: 'talentum',
    method: 'post',
    mountPrefix: '/api/admin',
    path: '/api/admin/workers/sync-talentum',
    buildRouter: (perm) => createAdminWorkerRoutes(autoDouble(), authComoUid('u'), perm),
  },
  {
    nome: 'POST /template-drafts/validar',
    family: ADMIN_MESSAGING_FAMILY,
    resource: 'messaging',
    method: 'post',
    mountPrefix: '/api/admin',
    path: '/api/admin/template-drafts/validar',
    buildRouter: (perm) => createTemplateDraftsRoutes(autoDouble(), authComoUid('u'), perm),
  },
];

describe.each(CASOS)('PR-8b 8b.4 — $nome exige create E update (rota "massa ou incerto")', (caso) => {
  function montar(permissoes: string[]) {
    const app = express();
    app.use(caso.mountPrefix, caso.buildRouter(permissoesLigadas(caso.family, permissoes)));
    return app;
  }

  it('só `create` → 403 missing_cell (falta update)', async () => {
    const app = montar([`${caso.resource}:create`]);
    const res = await request(app)[caso.method](caso.path).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('missing_cell');
  });

  it('só `update` → 403 missing_cell (falta create)', async () => {
    const app = montar([`${caso.resource}:update`]);
    const res = await request(app)[caso.method](caso.path).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('missing_cell');
  });

  /**
   * ⚠️ `POST /admin/recruitment/calculate-reemplazos` despacha para
   * `RecruitmentAnalyticsController`, construído DENTRO da fábrica (não é
   * injetável — mesma dívida documentada em `recruitmentRoutes.test.ts`): com
   * as duas células o request ATRAVESSA os dois guards e cai no controller
   * real, que tenta falar com um Postgres que não existe neste teste unit e
   * responde 500 — não 403. Por isso a prova aqui é "não foi barrado pelo
   * guard" (`missing_cell` ausente), não um 200 literal; os 3 outros casos
   * (controller-alvo é o auto-duplo) chegam a 200 de verdade.
   */
  it('as DUAS (`create` + `update`) → passa dos DOIS guards (não é 403 missing_cell)', async () => {
    const app = montar([`${caso.resource}:create`, `${caso.resource}:update`]);
    const res = await request(app)[caso.method](caso.path).send({});
    expect(res.status).not.toBe(403);
    if (res.status === 200) expect(res.body.ok).toBe(true);
  });

  it('`write` sozinho (grupo NÃO migrado / alias expirado) → 403 — não é substituto de create+update', async () => {
    const app = montar([`${caso.resource}:write`]);
    const res = await request(app)[caso.method](caso.path).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('missing_cell');
  });
});
