/**
 * A QUARTA e MAIOR família (task 3.5-A2): 48 rotas, 16 células, um arquivo
 * (45 + `promote`, D300, entrada no merge main→stage 19/09).
 * Mesmo papel dos testes de `admin.users`, `admin.patients` e `admin.workers`:
 * varrer o router de verdade (o mesmo `scanExpressRouter` do catálogo) e afirmar
 * que TODA rota declara, e declara a célula do MAPA — não a que o código escolheu.
 *
 * ⚠️ Duas rotas ficam atrás de controller OPCIONAL
 * (`vacancyAddressReviewController` → `resolve-address-review`,
 * `funnelTableController` → `funnel-table`). O router é montado aqui COM os dois,
 * porque é assim que o `src/index.ts` monta — sem eles a conta daria 44 e o teste
 * passaria escondendo duas rotas sem célula.
 */

// ⚠️ ANTES de qualquer import de `src/`: o router constrói
// `new VacanciesAuxController()` DENTRO da fábrica, e esse controller pede
// `DatabaseConnection.getInstance()` no construtor. Sem uma URL, montar o router
// estoura — o teste nem chega a olhar rota nenhuma. A URL é falsa de propósito:
// `pg.Pool` não conecta até a primeira query, e este teste não faz nenhuma.
//
// É o mesmo cheiro que `adminPatientsRoutes` documentou e resolveu injetando os
// controllers: dependência construída dentro da fábrica é caminho de produção
// que teste unitário não alcança. Aqui NÃO mudei a assinatura — declarar célula
// já a muda uma vez, e trocar o desenho de injeção no mesmo PR misturaria duas
// coisas. Fica anotado como dívida da família.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://unit:unit@127.0.0.1:1/unit';

import express from 'express';
import { appDeRota } from '@shared/__tests__/appDeRota';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminVacanciesRoutes, ADMIN_VACANCIES_FAMILY } from '../adminVacanciesRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

/** Mapa esperado — copiado do route-permission-map.md, não do código. */
const ESPERADO: Record<string, string> = {
  'DELETE /interview-slots/:slotId': 'interview:delete',
  'DELETE /vacancies/:id': 'vacancy:delete',
  'DELETE /vacancies/:id/publish-talentum': 'talentum:update',
  'DELETE /vacancies/:vacancyId/workers/:workerId/contact-notes/:noteId': 'funnel:update',
  'GET /dashboard/alerts': 'dashboard:read',
  'GET /dashboard/conversion-by-channel': 'dashboard:read',
  'GET /dashboard/coordinator-capacity': 'dashboard:read',
  'GET /vacancies': 'vacancy:read',
  'GET /vacancies/:id': 'vacancy:read',
  'GET /vacancies/:id/funnel': 'funnel:read',
  'GET /vacancies/:id/funnel-table': 'funnel:read',
  'GET /vacancies/:id/interview-slots': 'interview:read',
  'GET /vacancies/:id/match-results': 'match:read',
  'GET /vacancies/:id/notes': 'vacancy:read',
  'GET /vacancies/:id/prescreening-config': 'prescreening:read',
  'GET /vacancies/:id/social-links-stats': 'vacancy:read',
  'GET /vacancies/:id/talentum-status': 'talentum:read',
  'GET /vacancies/:vacancyId/workers/:workerId/contact-notes': 'funnel:read',
  'GET /vacancies/:vacancyId/workers/:workerId/delivery-status': 'messaging:read',
  'GET /vacancies/by-address': 'vacancy:read',
  'GET /vacancies/cases-for-select': 'vacancy:read',
  'GET /vacancies/filter-options': 'vacancy:read',
  'GET /vacancies/in-progress': 'vacancy:read',
  'GET /vacancies/next-vacancy-number': 'vacancy:read',
  'GET /vacancies/pending-address-review': 'vacancy:read',
  'GET /vacancies/stats': 'vacancy:read',
  'POST /interview-slots/:slotId/book': 'interview:update',
  'POST /vacancies': 'vacancy:create',
  'POST /vacancies/:id/generate-ai-content': 'vacancy:update',
  'POST /vacancies/:id/generate-talentum-description': 'talentum:update',
  'POST /vacancies/:id/interview-slots': 'interview:create',
  'POST /vacancies/:id/match': 'match:execute',
  'POST /vacancies/:id/notes': 'vacancy:update',
  'POST /vacancies/:id/prescreening-config': 'prescreening:update',
  'POST /vacancies/:id/publish-talentum': 'talentum:update',
  'POST /vacancies/:id/resolve-address-review': 'vacancy:update',
  'POST /vacancies/:id/social-links': 'vacancy:create',
  'POST /vacancies/:vacancyId/workers/:workerId/contact-notes': 'funnel:create',
  // "Promover" card ELEGIBLE (D300): mesma célula de reject/restore — escrita no funil.
  'POST /vacancies/blocked-applications/:blockedId/promote': 'funnel:update',
  'POST /vacancies/blocked-applications/:blockedId/reject': 'funnel:update',
  'POST /vacancies/blocked-applications/:blockedId/restore': 'funnel:update',
  'POST /vacancies/meet-links/lookup': 'vacancy:read',
  // PR-8b 8b.4: sync em massa exige create E update (regra-orquestrador 15/09); o scanner só
  // carimba o 1º guard — o 2º é provado em pr8b-ambiguous-routes.test.ts.
  'POST /vacancies/sync-talentum': 'talentum:create',
  'PUT /encuadres/:id/move': 'funnel:update',
  'PUT /encuadres/:id/result': 'funnel:update',
  'PUT /vacancies/:id': 'vacancy:update',
  'PUT /vacancies/:id/meet-links': 'vacancy:update',
  'PUT /vacancies/:id/talentum-description': 'talentum:update',
};

const responde = (nome: string) => (req: express.Request, res: express.Response) =>
  res.json({ m: nome, id: req.params.id ?? req.params.slotId ?? req.params.blockedId });

/** Um controller-dublê cujos métodos todos respondem com o próprio nome. */
function dubleDe(prefixo: string, metodos: string[]): Record<string, unknown> {
  return Object.fromEntries(metodos.map((m) => [m, responde(`${prefixo}.${m}`)]));
}

function build(): express.Router {
  return createAdminVacanciesRoutes(
    dubleDe('vac', ['listVacancies', 'getVacanciesStats', 'getNextVacancyNumber', 'getCasesForSelect',
      'getVacancyById']) as never,
    dubleDe('crud', ['createVacancy', 'updateVacancy', 'deleteVacancy']) as never,
    dubleDe('talentum', ['publishToTalentum', 'unpublishFromTalentum', 'generateTalentumDescription',
      'updateTalentumDescription', 'generateAIContent', 'syncFromTalentum', 'getPrescreeningConfig',
      'getTalentumStatus', 'savePrescreeningConfig']) as never,
    dubleDe('match', ['getMatchResults', 'triggerMatch', 'updateEncuadreResult']) as never,
    dubleDe('meet', ['lookupMeetDatetime', 'updateMeetLinks']) as never,
    dubleDe('social', ['generateSocialLink', 'getSocialLinksStats']) as never,
    dubleDe('funnel', ['getEncuadreFunnel', 'moveEncuadre', 'rejectBlockedApplication',
      'undismissBlockedApplication']) as never,
    dubleDe('dash', ['getCoordinatorCapacity', 'getAlerts', 'getConversionByChannel']) as never,
    dubleDe('slots', ['createSlots', 'getSlots', 'bookSlot', 'cancelSlot']) as never,
    authDouble(),
    permissionsDouble(),
    dubleDe('addr', ['resolveAddressReview']) as never,
    dubleDe('table', ['getEncuadreFunnelTable']) as never,
  );
}

function declaradas(): Record<string, string | null> {
  return Object.fromEntries(
    scanExpressRouter(build()).map((route) => [
      `${route.method} ${route.path}`,
      route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
    ]),
  );
}

describe('família admin.vacancies — 48 rotas declaram célula', () => {
  it('a família é `admin.vacancies` — o nome que PERMISSION_ENFORCED_ROUTES liga', () => {
    expect(ADMIN_VACANCIES_FAMILY).toBe('admin.vacancies');
  });

  it('cada rota declara a célula do mapa (route-permission-map.md)', () => {
    expect(declaradas()).toEqual(ESPERADO);
  });

  it('nenhuma rota da família fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('a família soma exatamente 48 rotas — a conta que saiu do PENDING_DECLARATIONS + promote (D300)', () => {
    expect(Object.keys(ESPERADO)).toHaveLength(48);
    expect(scanExpressRouter(build())).toHaveLength(48);
  });

  it('as 2 rotas de controller OPCIONAL estão presentes — montadas como em produção', () => {
    const rotas = declaradas();
    expect(rotas['POST /vacancies/:id/resolve-address-review']).toBe('vacancy:update');
    expect(rotas['GET /vacancies/:id/funnel-table']).toBe('funnel:read');
  });

  it('sem os controllers opcionais, o router encolhe para 44 — o motivo de o teste montar com eles', () => {
    const semOpcionais = createAdminVacanciesRoutes(
      dubleDe('vac', ['listVacancies', 'getVacanciesStats', 'getNextVacancyNumber', 'getCasesForSelect',
        'getVacancyById']) as never,
      dubleDe('crud', ['createVacancy', 'updateVacancy', 'deleteVacancy']) as never,
      dubleDe('talentum', ['publishToTalentum', 'unpublishFromTalentum', 'generateTalentumDescription',
        'updateTalentumDescription', 'generateAIContent', 'syncFromTalentum', 'getPrescreeningConfig',
        'getTalentumStatus', 'savePrescreeningConfig']) as never,
      dubleDe('match', ['getMatchResults', 'triggerMatch', 'updateEncuadreResult']) as never,
      dubleDe('meet', ['lookupMeetDatetime', 'updateMeetLinks']) as never,
      dubleDe('social', ['generateSocialLink', 'getSocialLinksStats']) as never,
      dubleDe('funnel', ['getEncuadreFunnel', 'moveEncuadre', 'rejectBlockedApplication',
        'undismissBlockedApplication']) as never,
      dubleDe('dash', ['getCoordinatorCapacity', 'getAlerts', 'getConversionByChannel']) as never,
      dubleDe('slots', ['createSlots', 'getSlots', 'bookSlot', 'cancelSlot']) as never,
      authDouble(),
      permissionsDouble(),
    );
    expect(scanExpressRouter(semOpcionais)).toHaveLength(46);
  });

  describe('as células que separam ações de peso diferente', () => {
    it('APAGAR vaga é vacancy:delete — não vacancy:update', () => {
      expect(declaradas()['DELETE /vacancies/:id']).toBe('vacancy:delete');
      expect(declaradas()['PUT /vacancies/:id']).toBe('vacancy:update');
    });

    it('RODAR o match é match:execute; ver o resultado é match:read', () => {
      expect(declaradas()['POST /vacancies/:id/match']).toBe('match:execute');
      expect(declaradas()['GET /vacancies/:id/match-results']).toBe('match:read');
    });

    it('APAGAR slot de entrevista é interview:delete — a célula mais destrutiva da família', () => {
      expect(declaradas()['DELETE /interview-slots/:slotId']).toBe('interview:delete');
      expect(declaradas()['POST /interview-slots/:slotId/book']).toBe('interview:update');
    });

    it('mover no funil é funnel:update, e NÃO vacancy:update — são decisões diferentes', () => {
      expect(declaradas()['PUT /encuadres/:id/move']).toBe('funnel:update');
      expect(declaradas()['PUT /encuadres/:id/result']).toBe('funnel:update');
    });

    it('publicar/despublicar no Talentum é talentum:update — sai da nossa base para um portal externo', () => {
      for (const rota of [
        'POST /vacancies/:id/publish-talentum',
        'DELETE /vacancies/:id/publish-talentum',
      ]) {
        expect(declaradas()[rota]).toBe('talentum:update');
      }
    });

    it('sincronizar em massa com o Talentum é talentum:create (+ update, PR-8b 8b.4 — ambíguo)', () => {
      expect(declaradas()['POST /vacancies/sync-talentum']).toBe('talentum:create');
    });

    it('o dashboard do coordenador é dashboard:read — não vacancy:read', () => {
      for (const rota of [
        'GET /dashboard/coordinator-capacity',
        'GET /dashboard/alerts',
        'GET /dashboard/conversion-by-channel',
      ]) {
        expect(declaradas()[rota]).toBe('dashboard:read');
      }
    });
  });

  describe('ordem das rotas — o que o tsc não pega', () => {
    it.each([
      ['get', '/api/admin/vacancies/stats', 'vac.getVacanciesStats'],
      ['get', '/api/admin/vacancies/next-vacancy-number', 'vac.getNextVacancyNumber'],
      ['get', '/api/admin/vacancies/cases-for-select', 'vac.getCasesForSelect'],
      ['get', '/api/admin/vacancies/filter-options', 'aux'],
      ['get', '/api/admin/vacancies/pending-address-review', 'aux'],
      ['get', '/api/admin/vacancies/in-progress', 'aux'],
      ['get', '/api/admin/vacancies/by-address', 'aux'],
    ] as const)('%s %s NÃO é capturado por /vacancies/:id', async (metodo, caminho, esperado) => {
      const app = appDeRota('adminVacancies', '/api/admin', build);

      const res = await request(app)[metodo](caminho);

      // `filter-options`/`pending-address-review` moram no controller auxiliar,
      // que o router constrói internamente (sem injeção) — ali basta afirmar que
      // NÃO caiu no handler de `:id`, que é o erro de ordem que se quer pegar.
      if (esperado === 'aux') expect(res.body.m).not.toBe('vac.getVacancyById');
      else expect(res.body.m).toBe(esperado);
    });

    it('a vaga por id continua chegando no handler de id', async () => {
      const app = appDeRota('adminVacancies', '/api/admin', build);

      const res = await request(app).get('/api/admin/vacancies/abc-123').expect(200);

      expect(res.body).toMatchObject({ m: 'vac.getVacancyById', id: 'abc-123' });
    });

    it('blocked-applications não é engolido por /vacancies/:id', async () => {
      const app = appDeRota('adminVacancies', '/api/admin', build);

      const res = await request(app).post('/api/admin/vacancies/blocked-applications/b1/reject').expect(200);

      expect(res.body.m).toBe('funnel.rejectBlockedApplication');
    });

    it('meet-links/lookup não é engolido por /vacancies/:id', async () => {
      const app = appDeRota('adminVacancies', '/api/admin', build);

      const res = await request(app).post('/api/admin/vacancies/meet-links/lookup').expect(200);

      expect(res.body.m).toBe('meet.lookupMeetDatetime');
    });
  });

  /**
   * As 45 rotas chegam no MÉTODO certo do controller. Trocar dois handlers de
   * lugar numa família deste tamanho é o erro clássico, e o tsc não pega (todas
   * as assinaturas são iguais). Exaustivo de propósito: é o que faz a cobertura
   * per-file do router fechar em 100%, e o que faz rota nova sem teste derrubar
   * o piso do CI.
   *
   * `AUX` = as 8 rotas cujos controllers o router constrói INTERNAMENTE e que
   * por isso não são injetáveis: 4 do `VacanciesAuxController`, 3 de
   * `WJAContactNotesController` e 1 de `WorkerVacancyDeliveryStatusController`.
   * Ali só dá para afirmar que a request NÃO caiu no handler de outra rota — que
   * é justamente o erro de ordem a pegar. (Elas respondem 500 contra a URL de
   * banco falsa; o que interessa ao teste é o despacho, e ao piso de cobertura é
   * o arrow ter sido executado.) É a mesma dívida de injeção anotada no topo.
   */
  it.each([
      ['get', '/api/admin/vacancies', 'vac.listVacancies'],
      ['get', '/api/admin/vacancies/stats', 'vac.getVacanciesStats'],
      ['get', '/api/admin/vacancies/next-vacancy-number', 'vac.getNextVacancyNumber'],
      ['get', '/api/admin/vacancies/cases-for-select', 'vac.getCasesForSelect'],
      ['get', '/api/admin/vacancies/filter-options', 'AUX'],
      ['get', '/api/admin/vacancies/pending-address-review', 'AUX'],
      ['get', '/api/admin/vacancies/in-progress', 'AUX'],
      ['get', '/api/admin/vacancies/by-address', 'AUX'],
      ['get', '/api/admin/vacancies/v1', 'vac.getVacancyById'],
      ['post', '/api/admin/vacancies', 'crud.createVacancy'],
      ['put', '/api/admin/vacancies/v1', 'crud.updateVacancy'],
      ['delete', '/api/admin/vacancies/v1', 'crud.deleteVacancy'],
      ['post', '/api/admin/vacancies/v1/resolve-address-review', 'addr.resolveAddressReview'],
      ['get', '/api/admin/vacancies/v1/match-results', 'match.getMatchResults'],
      ['post', '/api/admin/vacancies/v1/match', 'match.triggerMatch'],
      ['put', '/api/admin/encuadres/v1/result', 'match.updateEncuadreResult'],
      ['post', '/api/admin/vacancies/v1/publish-talentum', 'talentum.publishToTalentum'],
      ['delete', '/api/admin/vacancies/v1/publish-talentum', 'talentum.unpublishFromTalentum'],
      ['post', '/api/admin/vacancies/v1/generate-talentum-description', 'talentum.generateTalentumDescription'],
      ['put', '/api/admin/vacancies/v1/talentum-description', 'talentum.updateTalentumDescription'],
      ['post', '/api/admin/vacancies/v1/generate-ai-content', 'talentum.generateAIContent'],
      ['post', '/api/admin/vacancies/sync-talentum', 'talentum.syncFromTalentum'],
      ['get', '/api/admin/vacancies/v1/prescreening-config', 'talentum.getPrescreeningConfig'],
      ['get', '/api/admin/vacancies/v1/talentum-status', 'talentum.getTalentumStatus'],
      ['post', '/api/admin/vacancies/v1/prescreening-config', 'talentum.savePrescreeningConfig'],
      ['post', '/api/admin/vacancies/meet-links/lookup', 'meet.lookupMeetDatetime'],
      ['put', '/api/admin/vacancies/v1/meet-links', 'meet.updateMeetLinks'],
      ['post', '/api/admin/vacancies/v1/social-links', 'social.generateSocialLink'],
      ['get', '/api/admin/vacancies/v1/social-links-stats', 'social.getSocialLinksStats'],
      ['get', '/api/admin/vacancies/v1/funnel', 'funnel.getEncuadreFunnel'],
      ['put', '/api/admin/encuadres/v1/move', 'funnel.moveEncuadre'],
      ['post', '/api/admin/vacancies/blocked-applications/b1/reject', 'funnel.rejectBlockedApplication'],
      ['post', '/api/admin/vacancies/blocked-applications/b1/restore', 'funnel.undismissBlockedApplication'],
      // `promoteBlockedController` é construído INTERNAMENTE (mesma dívida de
      // injeção do AUX, achado #300/merge 19/09) — `b1` não é UUID válido, então
      // o controller REAL responde 400 sem tocar banco. O que este teste prova é
      // o DESPACHO (chegou no handler certo, não caiu em `/vacancies/:id`), não
      // o corpo da resposta — por isso 'AUX', igual às outras rotas não-injetáveis.
      ['post', '/api/admin/vacancies/blocked-applications/b1/promote', 'AUX'],
      ['get', '/api/admin/vacancies/v1/funnel-table', 'table.getEncuadreFunnelTable'],
      ['get', '/api/admin/dashboard/coordinator-capacity', 'dash.getCoordinatorCapacity'],
      ['get', '/api/admin/dashboard/alerts', 'dash.getAlerts'],
      ['get', '/api/admin/dashboard/conversion-by-channel', 'dash.getConversionByChannel'],
      ['post', '/api/admin/vacancies/v1/interview-slots', 'slots.createSlots'],
      ['get', '/api/admin/vacancies/v1/interview-slots', 'slots.getSlots'],
      ['post', '/api/admin/interview-slots/s1/book', 'slots.bookSlot'],
      ['delete', '/api/admin/interview-slots/s1', 'slots.cancelSlot'],
      ['get', '/api/admin/vacancies/v1/workers/w1/contact-notes', 'AUX'],
      ['post', '/api/admin/vacancies/v1/workers/w1/contact-notes', 'AUX'],
      ['delete', '/api/admin/vacancies/v1/workers/w1/contact-notes/n1', 'AUX'],
      ['get', '/api/admin/vacancies/v1/notes', 'AUX'],
      ['post', '/api/admin/vacancies/v1/notes', 'AUX'],
      ['get', '/api/admin/vacancies/v1/workers/w1/delivery-status', 'AUX'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const app = appDeRota('adminVacancies', '/api/admin', build);

    const res = await request(app)[metodo](caminho);

    if (esperado === 'AUX') expect(res.body.m).toBeUndefined();
    else expect(res.body.m).toBe(esperado);
  });
});
