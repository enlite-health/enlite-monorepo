/**
 * Lista dourada das rotas do evento de enquadre (spec 052, T-30b e T-30c): 12 rotas, 5 células, família `admin.vacancies`.
 * Mesmo molde de `adminVacanciesRoutes.test.ts`: varre o router de verdade (o `scanExpressRouter` do catálogo) e afirma que TODA
 * rota declara, e declara a célula do MAPA — não a que o código escolheu.
 */
import express from 'express';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import {
  authDouble,
  permissionsDouble,
} from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminEnquadreEventRoutes } from '../adminEnquadreEventRoutes';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
}));

/** Mapa esperado — escrito à mão a partir do plano (Fase 2, desenho 7), não lido do código. */
const ESPERADO: Record<string, string> = {
  'GET /vacancies/:vacancyId/enquadre-events': 'enquadre_event:read',
  'GET /vacancies/:vacancyId/enquadre-events/available-workers': 'enquadre_event:create',
  'GET /vacancies/:vacancyId/enquadre-events/hosts': 'enquadre_event:create',
  'GET /vacancies/:vacancyId/enquadre-events/hosts/:hostId/free-slots': 'enquadre_event:create',
  'GET /vacancies/:vacancyId/enquadre-events/:eventId': 'enquadre_event:read',
  'POST /vacancies/:vacancyId/enquadre-events': 'enquadre_event:create',
  'POST /vacancies/:vacancyId/enquadre-events/:eventId/participants': 'enquadre_event:update',
  'POST /vacancies/:vacancyId/enquadre-events/:eventId/participants/:participantId/remove': 'enquadre_event:update',
  'POST /vacancies/:vacancyId/enquadre-events/:eventId/cancel': 'enquadre_event:update',
  'PUT /vacancies/:vacancyId/enquadre-events/:eventId/participants/:participantId/move': 'enquadre_result:update',
  'POST /vacancies/:vacancyId/enquadre-events/:eventId/close': 'enquadre_result:update',
  // Fase 3 (T-36c): o download do resumo — a quinta célula, atrás da qual o campo e o selo do resumo também ficam
  'GET /vacancies/:vacancyId/enquadre-events/:eventId/summary/url': 'enquadre_summary:read',
};

const responde = (nome: string) => (_req: express.Request, res: express.Response) => res.json({ m: nome });
const controllerDuble = Object.fromEntries(
  ['list', 'get', 'availableWorkers', 'hosts', 'freeSlots', 'create', 'addParticipants', 'removeParticipant', 'cancel', 'moveParticipant', 'close', 'summaryUrl'].map((m) => [m, responde(m)]),
);

function build(): express.Router {
  return createAdminEnquadreEventRoutes(authDouble(), permissionsDouble(), controllerDuble as never);
}

function declaradas(): Record<string, string | null> {
  return Object.fromEntries(
    scanExpressRouter(build()).map((route) => [
      `${route.method} ${route.path}`,
      route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
    ]),
  );
}

describe('rotas do evento de enquadre — 12 rotas declaram célula', () => {
  it('cada rota declara a célula do mapa', () => {
    expect(declaradas()).toEqual(ESPERADO);
  });

  it('nenhuma rota fica sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('o router soma exatamente 12 rotas', () => {
    expect(Object.keys(ESPERADO)).toHaveLength(12);
    expect(scanExpressRouter(build())).toHaveLength(12);
  });

  it('as rotas ESTÁTICAS vêm antes de /:eventId (senão o parâmetro as captura)', () => {
    const ordem = scanExpressRouter(build())
      .filter((r) => r.method === 'GET')
      .map((r) => r.path);
    const iDetalhe = ordem.indexOf('/vacancies/:vacancyId/enquadre-events/:eventId');
    expect(iDetalhe).toBeGreaterThan(ordem.indexOf('/vacancies/:vacancyId/enquadre-events/available-workers'));
    expect(iDetalhe).toBeGreaterThan(ordem.indexOf('/vacancies/:vacancyId/enquadre-events/hosts'));
    expect(ordem.indexOf('/vacancies/:vacancyId/enquadre-events/available-workers')).toBeGreaterThan(-1);
  });

  it('mudar o evento é enquadre_event:update; marcar resultado e encerrar é enquadre_result:update', () => {
    const d = declaradas();
    const eventos = Object.entries(d).filter(([, c]) => c === 'enquadre_event:update').map(([k]) => k);
    const resultados = Object.entries(d).filter(([, c]) => c === 'enquadre_result:update').map(([k]) => k);
    expect(eventos).toHaveLength(3);
    expect(resultados).toHaveLength(2);
  });

  it('ler é read; tudo que prepara ou faz a criação é create', () => {
    const d = declaradas();
    expect(d['GET /vacancies/:vacancyId/enquadre-events']).toBe('enquadre_event:read');
    expect(d['GET /vacancies/:vacancyId/enquadre-events/:eventId']).toBe('enquadre_event:read');
    expect(d['POST /vacancies/:vacancyId/enquadre-events']).toBe('enquadre_event:create');
  });
});
