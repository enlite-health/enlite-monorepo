/**
 * adminAiPromptRoutes.test.ts (spec 029, T013/T019b — fechamento da T015)
 *
 * Mesmo contrato dos vizinhos de família (`adminServiceTeamRoutes.test.ts`,
 * `adminTherapeuticProjectsRoutes.test.ts`, e o vizinho DIRETO deste módulo
 * `adminIntegrationsRoutes.test.ts`): varre o router de VERDADE com
 * `scanExpressRouter` e afirma a célula de cada rota contra um MAPA escrito à
 * mão (não contra o código do próprio router — senão o teste concordaria com
 * qualquer erro de declaração).
 *
 * `AiPromptController` (T012/T019b) já tem prova própria de comportamento HTTP
 * (200/400/403/404/409/422/500) em `AiPromptController.test.ts` — aqui o alvo é só
 * a MONTAGEM: caminho, método, célula declarada, e que a rota de fato chega no
 * método certo do controller.
 *
 * ⚠️ Cobre só este router. O oráculo do app inteiro é o e2e
 * `permission-route-inventory`; o fluxo real (banco + HTTP) é o e2e
 * `tests/e2e/aiPrompts.e2e.test.ts`.
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminAiPromptRoutes } from '../adminAiPromptRoutes';
import type { AiPromptController } from '../../controllers/AiPromptController';

const AI_PROMPT_READ = 'ai_prompt:read';
const AI_PROMPT_UPDATE = 'ai_prompt:update';

/** O mapa esperado, escrito à mão a partir do cabeçalho do router (T013/T019b). */
const ESPERADO: Record<string, string> = {
  'GET /ai-prompts': AI_PROMPT_READ,
  'GET /ai-prompts/:slug': AI_PROMPT_READ,
  'PUT /ai-prompts/:slug': AI_PROMPT_UPDATE,
  'POST /ai-prompts/:slug/undo': AI_PROMPT_UPDATE,
  'POST /ai-prompts/:slug/preview': AI_PROMPT_UPDATE,
};

/** Cada handler devolve o próprio nome — é o que identifica quem foi chamado (e com que params). */
function controllerDuble(): AiPromptController {
  const responde = (nome: string) => (req: express.Request, res: express.Response) =>
    res.json({ m: nome, slug: req.params.slug });
  return {
    list: responde('list'),
    get: responde('get'),
    update: responde('update'),
    undo: responde('undo'),
    preview: responde('preview'),
  } as unknown as AiPromptController;
}

const build = () => createAdminAiPromptRoutes(controllerDuble(), authDouble(), permissionsDouble());

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', build());
  return a;
}

describe('createAdminAiPromptRoutes', () => {
  it('TODA rota do router declara célula — nenhuma passa sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('cada uma das 5 rotas declara a célula do mapa (T013/T019b)', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build()).map((route) => [
        `${route.method} ${route.path}`,
        route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
      ]),
    );
    expect(declarado).toEqual(ESPERADO);
  });

  it('são exatamente 5 rotas: 2 leituras (list/get) + 3 escritas (update/undo/preview) — restore é de fase posterior', () => {
    expect(scanExpressRouter(build())).toHaveLength(5);
  });

  it('exatamente 2 `router.get(`, 1 `router.put(` e 2 `router.post(` — nenhum patch/delete', () => {
    const rotas = scanExpressRouter(build());
    expect(rotas.filter((r) => r.method === 'GET')).toHaveLength(2);
    expect(rotas.filter((r) => r.method === 'PUT')).toHaveLength(1);
    expect(rotas.filter((r) => r.method === 'POST')).toHaveLength(2);
    expect(rotas.map((r) => r.method)).not.toContain('PATCH');
    expect(rotas.map((r) => r.method)).not.toContain('DELETE');
  });

  // Despacho real (supertest): a rota chega no método certo do controller, com o :slug certo.
  it.each([
    ['get', '/api/admin/ai-prompts', 'list', undefined],
    ['get', '/api/admin/ai-prompts/VACANCY_DESCRIPTION', 'get', 'VACANCY_DESCRIPTION'],
    ['put', '/api/admin/ai-prompts/VACANCY_DESCRIPTION', 'update', 'VACANCY_DESCRIPTION'],
    ['post', '/api/admin/ai-prompts/VACANCY_DESCRIPTION/undo', 'undo', 'VACANCY_DESCRIPTION'],
    ['post', '/api/admin/ai-prompts/PRESCREENING_AT/preview', 'preview', 'PRESCREENING_AT'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado, slugEsperado) => {
    const res = await request(app())
      [metodo](caminho)
      .send({})
      .expect(200);

    expect(res.body.m).toBe(esperado);
    expect(res.body.slug).toBe(slugEsperado);
  });

  // Invariante: nenhuma rota fora das 4 declaradas (restore é de fase posterior).
  it.each([
    ['post', '/api/admin/ai-prompts/VACANCY_DESCRIPTION/restore'],
    ['delete', '/api/admin/ai-prompts/VACANCY_DESCRIPTION'],
    ['patch', '/api/admin/ai-prompts/VACANCY_DESCRIPTION'],
  ] as const)('%s %s → 404 (rota não declarada)', async (metodo, caminho) => {
    await request(app())[metodo](caminho).expect(404);
  });
});
