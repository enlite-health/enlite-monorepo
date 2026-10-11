/**
 * Família `admin.recruitment`: depois da remoção do dashboard (`/admin/recruitment`) e da saúde
 * (`/admin/recruitment/health`), este router declara UMA rota — `GET /admin/recruitment/blocked-attempts`.
 *
 * O `toEqual(ESPERADO)` + `toHaveLength(1)` abaixo é o que MORRE se alguém recolocar uma das rotas
 * removidas (clickup-cases, talentum-workers, progreso, publications, encuadres, global-metrics,
 * case/:caseNumber, zones, calculate-reemplazos): o router passa a ter mais de uma rota e o mapa
 * deixa de ser igual.
 */

// ⚠️ ANTES de qualquer import de `src/`: o router constrói `RecruitmentBlockedController` DENTRO da
// fábrica, e ele pede o pool no construtor. A URL é falsa de propósito — `pg.Pool` não conecta até a
// primeira query, e este teste não faz nenhuma.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://unit:unit@127.0.0.1:1/unit';

import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createRecruitmentRoutes, ADMIN_RECRUITMENT_FAMILY } from '../recruitmentRoutes';
import { RecruitmentBlockedController } from '../../controllers/RecruitmentBlockedController';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

/** Mapa esperado. Spec 024 (D2/D401, 21/09): LOG administrativo, célula própria. */
const ESPERADO: Record<string, string> = {
  'GET /admin/recruitment/blocked-attempts': 'recruitment_blocked:read',
};

const REMOVIDAS = [
  ['get', '/api/admin/recruitment/clickup-cases'],
  ['get', '/api/admin/recruitment/talentum-workers'],
  ['get', '/api/admin/recruitment/progreso'],
  ['get', '/api/admin/recruitment/publications'],
  ['get', '/api/admin/recruitment/encuadres'],
  ['get', '/api/admin/recruitment/global-metrics'],
  ['get', '/api/admin/recruitment/case/42'],
  ['get', '/api/admin/recruitment/zones'],
  ['post', '/api/admin/recruitment/calculate-reemplazos'],
] as const;

function build(): express.Router {
  return createRecruitmentRoutes(authDouble(), permissionsDouble());
}

function declaradas(): Record<string, string | null> {
  return Object.fromEntries(
    scanExpressRouter(build()).map((r) => [
      `${r.method} ${r.path}`,
      r.cell ? cellKey(r.cell.resource, r.cell.action) : null,
    ]),
  );
}

describe('família admin.recruitment — o router declara só blocked-attempts', () => {
  it('a família é `admin.recruitment` — o nome que PERMISSION_ENFORCED_ROUTES liga', () => {
    expect(ADMIN_RECRUITMENT_FAMILY).toBe('admin.recruitment');
  });

  it('a única rota declara a célula do mapa', () => {
    expect(declaradas()).toEqual(ESPERADO);
  });

  it('nenhuma rota fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('este router tem exatamente 1 rota — recolocar uma rota do dashboard removido quebra aqui', () => {
    expect(scanExpressRouter(build())).toHaveLength(1);
  });

  it('GET /admin/recruitment/blocked-attempts chama listBlockedAttempts do controller com a request e a response', async () => {
    const espiao = jest
      .spyOn(RecruitmentBlockedController.prototype, 'listBlockedAttempts')
      .mockImplementation(async (_req, res) => {
        res.json({ m: 'listBlockedAttempts' });
      });
    const app = express();
    app.use('/api', build());

    const res = await request(app).get('/api/admin/recruitment/blocked-attempts').expect(200);

    expect(res.body.m).toBe('listBlockedAttempts');
    expect(espiao).toHaveBeenCalledTimes(1);
    expect(espiao.mock.calls[0][0].originalUrl).toBe('/api/admin/recruitment/blocked-attempts');
    espiao.mockRestore();
  });

  it.each(REMOVIDAS)('%s %s não existe mais (404)', async (metodo, caminho) => {
    const app = express();
    app.use('/api', build());

    await request(app)[metodo](caminho).expect(404);
  });
});
