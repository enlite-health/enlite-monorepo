/**
 * clickup-rotas-removidas-nao-voltam.test.ts — TRAVA ANTI-VOLTA (gate revisao-pr).
 *
 * 11/09/2026: o webhook `POST /clickup/patient` (+ `/clickup/patient/_health`) e a rota interna
 * `POST /sync-clickup-patients` foram removidos — decisão do Gabriel: a plataforma é a fonte,
 * sem sync automático (ver commits `chore(clickup): remove o webhook...` e `chore(clickup):
 * remove o reconciliador...`).
 *
 * Este teste NÃO testa comportamento — monta os dois routers de produção
 * (`createWebhookRoutes`/`createInternalRoutes`) exatamente como `startServer.ts` monta, e
 * REPROVA se `router.stack` tiver QUALQUER rota `/clickup/patient*` ou `/sync-clickup-*`. Se
 * algum dia alguém reintroduzir o webhook ou o reconciliador (revert parcial, merge de branch
 * velha, cherry-pick errado), este teste cai ANTES de chegar em produção — é a rede de
 * segurança que os 25 testes deletados junto do webhook não são mais.
 *
 * Provado por sabotagem (não é afirmação — ver o commit desta mesma mudança, que colou a saída
 * do `npx jest` ANTES e DEPOIS de reintroduzir a rota via `cp` de um backup do arquivo
 * pré-remoção): recolocar a rota faz este teste FALHAR; tirar de novo faz PASSAR.
 */
// `createWebhookRoutes` instancia `TalentumWebhookController` na CONSTRUÇÃO (não sob demanda),
// e o construtor dele abre `DatabaseConnection.getInstance()` — que LANÇA sem DATABASE_URL no
// ambiente. Este teste não fala com banco nenhum (só inspeciona `router.stack`), então dublar a
// conexão é o que permite montar o router de verdade sem subir Postgres.
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

import { Router } from 'express';
import { createWebhookRoutes } from '../../../src/modules/integration/interfaces/webhooks/routes/webhookRoutes';
import { createInternalRoutes } from '../../../src/modules/notification/interfaces/routes/internalRoutes';
import { PartnerAuthMiddleware } from '../../../src/modules/integration/interfaces/webhooks/middleware/PartnerAuthMiddleware';
import type { GoogleApiKeyValidator } from '../../../src/modules/integration/infrastructure/GoogleApiKeyValidator';
import type { IWebhookPartnerRepository } from '../../../src/modules/integration/ports/IWebhookPartnerRepository';
import type { InternalController } from '../../../src/modules/notification/interfaces/controllers/InternalController';

/** Caminhos que `router.post/get(...)` registrou NESTE router (relativo ao mount point —
 *  `createWebhookRoutes` nunca soube que ia parar em `/api/webhooks` ou `/api/webhooks-test`,
 *  então o path que importa aqui é o que o próprio router declarou). */
function registeredPaths(router: Router): string[] {
  const stack = router.stack as unknown as Array<{ route?: { path: string | string[] } }>;
  return stack
    .filter(layer => layer.route !== undefined)
    .flatMap(layer => {
      const p = layer.route!.path;
      return Array.isArray(p) ? p : [p];
    });
}

/** Deps do webhookRoutes: `requirePartnerKey()` é chamado NA CONSTRUÇÃO do router (para pegar
 *  o middleware), então precisa ser um `PartnerAuthMiddleware` de verdade — mas os DOIS
 *  colaboradores dele (validador de API key do Google, repositório de parceiros) nunca são
 *  chamados nesse momento, então dublês bastam (o repositório real abriria pool no construtor
 *  sem DATABASE_URL — não é isso que este teste prova). */
function buildPartnerAuth(): PartnerAuthMiddleware {
  const googleValidator = { validate: jest.fn() } as unknown as GoogleApiKeyValidator;
  const partnerRepo = { findByDisplayName: jest.fn() } as unknown as IWebhookPartnerRepository;
  return new PartnerAuthMiddleware(googleValidator, partnerRepo);
}

describe('anti-volta — rotas do ClickUp removidas não podem reaparecer', () => {
  it('createWebhookRoutes() nunca registra /clickup/patient nem /clickup/patient/_health', () => {
    const router = createWebhookRoutes(buildPartnerAuth());
    const paths = registeredPaths(router);

    const proibidas = paths.filter(p => p.startsWith('/clickup/patient'));

    expect(proibidas).toEqual([]);
  });

  it('createInternalRoutes() nunca registra nenhuma rota /sync-clickup-*', () => {
    const controller = {} as unknown as InternalController;
    const router = createInternalRoutes(controller);
    const paths = registeredPaths(router);

    const proibidas = paths.filter(p => p.startsWith('/sync-clickup-'));

    expect(proibidas).toEqual([]);
  });

  it('CONTROLE POSITIVO — createWebhookRoutes() continua registrando rotas vivas (o teste não está cego)', () => {
    // Sem controle positivo, um router VAZIO por engano passaria os dois testes acima em
    // silêncio (D157: instrumento cego ao próprio buraco). Confirma que o router construído
    // é o de verdade, com as rotas que continuam existindo.
    const router = createWebhookRoutes(buildPartnerAuth());
    const paths = registeredPaths(router);

    expect(paths).toContain('/talentum/prescreening');
    expect(paths).toContain('/twilio/status');
  });

  it('CONTROLE POSITIVO — createInternalRoutes() continua registrando rotas vivas', () => {
    const controller = {} as unknown as InternalController;
    const router = createInternalRoutes(controller);
    const paths = registeredPaths(router);

    expect(paths).toContain('/vertex-health');
    expect(paths).toContain('/events/process');
  });
});
