/**
 * permissionFamilyDoubles — os dublês compartilhados dos testes UNIT de família
 * do painel de grupos (task 3.10b).
 *
 * Por que existe: o gate de revisão da 2ª família (19/08/2026) registrou 10
 * linhas idênticas entre `adminUsersRoutes.test.ts` e `adminPatientsRoutes.
 * test.ts` e avisou que viraria BLOCKER na 3ª. Com 7 famílias ainda por
 * declarar, seriam 9 cópias do MESMO contrato: a forma do `PermissionClient`
 * (5 métodos) e o passe-livre dos guards de papel. Um método novo no client
 * teria que ser lembrado em 9 arquivos, e o que acontece na prática é o
 * contrário — um fica para trás e o teste da família passa a construir um
 * middleware diferente do de produção sem ninguém ver.
 *
 * ⚠️ POR QUE AQUI, E NÃO EM `tests/unit/helpers/` (a decisão da 3.10b, com o
 * caminho errado tentado primeiro): os testes de família moram sob `src/`, e o
 * `tsconfig.json` tem `rootDir: src`. Um teste em `src/` importando de `tests/`
 * compila no jest (ts-jest é por arquivo) e **quebra o `tsc`** com TS6059 — o
 * build vermelho, a suíte verde. É a mesma classe de armadilha do container em
 * cache (D123): duas ferramentas, duas respostas, e a que mente é a que roda
 * primeiro.
 *
 * Dentro de `__tests__/` o arquivo fica: no rootDir (tsc ok), fora do
 * `testMatch` (`__tests__/**\/*.test.ts` — não é suíte vazia), e sem tocar em
 * nenhum glob do `coverageThreshold` (todos nomeiam arquivos, nenhum casa
 * `__tests__`). Entra em `collectCoverageFrom` como qualquer `.ts` de `src/` e
 * fica coberto pelo próprio uso — nada a excluir, `jest.config.js` intocado.
 * Fica em `identity` porque quem é dono do contrato (`PermissionMiddleware`,
 * `AuthMiddleware`) é este módulo; `case` e `worker` importam pelo alias
 * `@modules/identity/...`, como já importam o resto.
 *
 * Aqui vale import estático de `src/`: teste UNIT não depende de env de flag
 * lida no import (é o e2e que precisa escrever a env antes de carregar o
 * módulo, por isso lá os imports são dinâmicos).
 */

import type express from 'express';
import { PermissionMiddleware } from '@modules/identity/interfaces/middleware/PermissionMiddleware';
import type { AuthMiddleware } from '@modules/identity';

/**
 * `AuthMiddleware` que deixa passar. O teste de família mede DECLARAÇÃO de
 * célula e ORDEM de rota; autenticação é assunto do e2e, com banco e HTTP
 * reais. Um dublê que negasse esconderia justamente o que se quer medir.
 *
 * `requireStaffOrApiKey` está aqui porque a família `admin.workers` é a
 * primeira a usá-lo (4 rotas do triage-service).
 */
export function authDouble(): AuthMiddleware {
  const passa = () => (_req: unknown, _res: unknown, next: express.NextFunction) => next();
  return {
    requireAdmin: passa,
    requireStaff: passa,
    requireStaffOrApiKey: passa,
    requireAuth: passa,
  } as unknown as AuthMiddleware;
}

/**
 * `PermissionMiddleware` REAL (não um dublê dele) com client e trilha falsos e
 * `env: {}` — sem `PERMISSION_ENGINE_ENABLED`, todo guard cai no `next()` da
 * primeira linha. É de propósito: o que o teste de família afirma é que a rota
 * DECLARA a célula certa (`markPermissionHandler`), e quem carimba é o
 * middleware de verdade. Construir um stub aqui testaria o stub.
 */
export function permissionsDouble(): PermissionMiddleware {
  return new PermissionMiddleware({
    client: {
      resolve: jest.fn(),
      can: jest.fn(),
      isFeatureAvailable: jest.fn(),
      featureConfig: jest.fn(),
      invalidate: jest.fn(),
    },
    audit: { record: jest.fn() },
    env: {},
  });
}
