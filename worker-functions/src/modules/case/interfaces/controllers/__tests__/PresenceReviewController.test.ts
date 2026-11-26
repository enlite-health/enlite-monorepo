/**
 * PresenceReviewController (emenda 077 §6, T-806-56) — a fila de revisão de presença e a decisão da coordenação.
 * Roda o router de VERDADE com o `PermissionMiddleware` REAL em modo enforçado (client falso devolvendo as células), o caso de uso real e dublês só nas
 * duas bordas (attendance e banco). Prova: a célula declarada que o scanner do catálogo enxerga; 403 sem a célula e o enriquecimento (nome, caso) NÃO
 * acontecendo para quem não a tem; Master (que recebe a célula pelo sync D338) passa; decisão sem código → 400; 409 do attendance repassado; log sem PII.
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import { PermissionMiddleware } from '@modules/identity/interfaces/middleware/PermissionMiddleware';
import { authDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { logger } from '@shared/logging';
import { PresenceReviewController } from '../PresenceReviewController';
import { createAdminPresenceReviewRoutes } from '../../routes/adminPresenceReviewRoutes';
import { PresenceReviewUseCase } from '../../../application/PresenceReviewUseCase';
import { PresenceUnavailableError } from '../../../application/ports/PresenceReaderPort';
import { PresenceReviewUpstreamError, type PresenceReviewGateway, type ReviewItemEnricher, type ReviewQueueEntry } from '../../../application/ports/PresenceReviewPorts';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
  reportError: jest.fn(),
  toSafeError: (e: unknown) => e,
}));

// supertest + ts-jest a frio, com duas suítes em paralelo, estourou os 5 s padrão em 2 de ~6 rodadas (uma rodada, 1 teste).
jest.setTimeout(20_000);

const CELL = 'presence_exception:review';
const UID = 'coord-1';
const EVENT = '5b0f1f0e-3a1c-4f55-9a43-0d2d4a3a9c11';
const WORKER_NAME = 'Fulana De Tal';

const entry = (over: Partial<ReviewQueueEntry> = {}): ReviewQueueEntry => ({
  kind: 'EXCEPTION_PENDING', id: EVENT, occurrenceId: 'a1b2c3d4-0000-4000-8000-000000000001', workerId: 'a1b2c3d4-0000-4000-8000-000000000002', slotId: null,
  onDate: '2026-11-25', occurredAt: '2026-11-25T14:00:00.000Z', reason: 'GPS_INDOOR', exceptionKind: 'GEO_DECLARED', distanceM: 180, accuracyM: 40, ...over,
});

function harness(opts: { cells: string[]; groups?: string[]; countries?: string[]; gateway?: Partial<PresenceReviewGateway> }) {
  const gateway: PresenceReviewGateway = {
    queue: jest.fn().mockResolvedValue({ items: [entry()], nextCursor: null }),
    decide: jest.fn().mockResolvedValue({ eventId: EVENT, decision: 'APPROVED', resolutionCode: 'INDOOR_CONFIRMED' }),
    ...opts.gateway,
  };
  const enricher: ReviewItemEnricher = {
    enrich: jest.fn().mockImplementation(async (items: ReviewQueueEntry[]) =>
      new Map(items.map((i) => [`${i.kind}:${i.id}`, { workerName: WORKER_NAME, caseNumber: 1234, startTime: '08:00', endTime: '16:00', onDate: i.onDate }]))),
  };
  const useCase = new PresenceReviewUseCase(gateway, enricher, async () => opts.countries ?? ['AR']);
  const permissions = new PermissionMiddleware({
    client: {
      resolve: jest.fn().mockResolvedValue({
        uid: UID, tenantId: 't', status: 'ACTIVE', permissions: opts.cells, countries: ['AR'], groups: (opts.groups ?? ['Coordinación']).map((name, i) => ({ id: `g${i}`, name })),
        canSimulate: false, simulation: null,
      }),
      can: jest.fn(), isFeatureAvailable: jest.fn(), featureConfig: jest.fn(), invalidate: jest.fn(),
    },
    audit: { record: jest.fn() },
    env: { PERMISSION_ENGINE_ENABLED: 'true', PERMISSION_ENFORCED_ROUTES: 'admin.patients' },
  });
  const router = createAdminPresenceReviewRoutes(new PresenceReviewController(useCase), authDouble(), permissions);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.authContext = { principal: { id: UID, roles: ['admin'] } } as never; next(); });
  app.use('/api/admin', router);
  return { app, router, gateway, enricher };
}

const decision = { decision: 'APPROVED', resolution_code: 'INDOOR_CONFIRMED' };

describe('PresenceReviewController — a célula declarada', () => {
  it('as DUAS rotas declaram presence_exception:review LITERAL no array, e o scanner do catálogo as vê (célula nunca em closure)', () => {
    const { router } = harness({ cells: [CELL] });
    const rotas = scanExpressRouter(router);
    expect(undeclaredRoutes(rotas, () => true)).toEqual([]);
    expect(rotas.map((r) => `${r.method} ${r.path} ${(r.cells ?? []).map((c) => cellKey(c.resource, c.action)).join(' + ')}`)).toEqual([
      `GET /presence/review-queue ${CELL}`,
      `POST /presence/exceptions/:eventId/decision ${CELL}`,
    ]);
  });
});

describe('PresenceReviewController — sem a célula', () => {
  it('leitura → 403 e o enriquecimento (nome do prestador, nº do caso) NÃO roda, nem o attendance é chamado', async () => {
    const { app, gateway, enricher } = harness({ cells: ['patient_itinerary:update'] });
    const res = await request(app).get('/api/admin/presence/review-queue').expect(403);
    expect(JSON.stringify(res.body)).not.toContain(WORKER_NAME);
    expect(enricher.enrich).not.toHaveBeenCalled();
    expect(gateway.queue).not.toHaveBeenCalled();
  });

  it('decisão → 403 e nada é gravado no attendance', async () => {
    const { app, gateway } = harness({ cells: [] });
    await request(app).post(`/api/admin/presence/exceptions/${EVENT}/decision`).send(decision).expect(403);
    expect(gateway.decide).not.toHaveBeenCalled();
  });
});

describe('PresenceReviewController — com a célula (e o Acesso Master, que a recebe do sync D338)', () => {
  it('com a célula → 200 com o item enriquecido (nome e caso resolvidos na leitura)', async () => {
    const { app, enricher } = harness({ cells: [CELL] });
    const res = await request(app).get('/api/admin/presence/review-queue?kind=EXCEPTION_PENDING').expect(200);
    expect(enricher.enrich).toHaveBeenCalledTimes(1);
    expect(res.body.data).toMatchObject({ country: 'AR', countries: ['AR'], nextCursor: null });
    expect(res.body.data.items[0]).toMatchObject({ kind: 'EXCEPTION_PENDING', id: EVENT, workerName: WORKER_NAME, caseNumber: 1234, startTime: '08:00', reason: 'GPS_INDOOR', distanceM: 180, accuracyM: 40 });
  });

  it('Master (grupo Acesso Master com a célula concedida pelo sync) → 200 na leitura e na decisão', async () => {
    const { app } = harness({ cells: [CELL, 'funnel:read'], groups: ['Acesso Master'] });
    await request(app).get('/api/admin/presence/review-queue').expect(200);
    await request(app).post(`/api/admin/presence/exceptions/${EVENT}/decision`).send(decision).expect(200);
  });

  it('o país vem do escopo do ator: pedir país fora do escopo → 403; ator sem país → 403; sem ?country usa o 1º do escopo', async () => {
    const { app, gateway } = harness({ cells: [CELL], countries: ['BR', 'AR'] });
    await request(app).get('/api/admin/presence/review-queue?country=CL').expect(403);
    await request(app).get('/api/admin/presence/review-queue').expect(200);
    expect(gateway.queue).toHaveBeenCalledWith({ country: 'AR', kind: undefined, cursor: undefined });
    const none = harness({ cells: [CELL], countries: [] });
    await request(none.app).get('/api/admin/presence/review-queue').expect(403);
  });

  it('query fora da forma (kind desconhecido, chave extra) → 400', async () => {
    const { app } = harness({ cells: [CELL] });
    await request(app).get('/api/admin/presence/review-queue?kind=OUTRO').expect(400);
    await request(app).get('/api/admin/presence/review-queue?nome=x').expect(400);
  });

  it('attendance fora do ar → 503 UPSTREAM_UNAVAILABLE (sem corpo do attendance)', async () => {
    const { app } = harness({ cells: [CELL], gateway: { queue: jest.fn().mockRejectedValue(new PresenceUnavailableError('timeout')) } });
    const res = await request(app).get('/api/admin/presence/review-queue').expect(503);
    expect(res.body).toEqual({ success: false, code: 'UPSTREAM_UNAVAILABLE' });
  });
});

describe('PresenceReviewController — decisão', () => {
  it('grava com decided_by_uid = o uid do ATOR autenticado (nunca o do corpo)', async () => {
    const { app, gateway } = harness({ cells: [CELL] });
    await request(app).post(`/api/admin/presence/exceptions/${EVENT}/decision`).send(decision).expect(200);
    expect(gateway.decide).toHaveBeenCalledWith({ eventId: EVENT, decision: 'APPROVED', resolutionCode: 'INDOOR_CONFIRMED', decidedByUid: UID });
    await request(app).post(`/api/admin/presence/exceptions/${EVENT}/decision`).send({ ...decision, decided_by_uid: 'outro' }).expect(400);
  });

  it('sem código de resolução, código fora da lista fechada de 5, decisão fora de APPROVED|REFUSED ou eventId que não é uuid → 400 (nada chega ao attendance)', async () => {
    const { app, gateway } = harness({ cells: [CELL] });
    const url = `/api/admin/presence/exceptions/${EVENT}/decision`;
    await request(app).post(url).send({ decision: 'APPROVED' }).expect(400);
    await request(app).post(url).send({ decision: 'REFUSED', resolution_code: 'QUALQUER' }).expect(400);
    await request(app).post(url).send({ decision: 'MAYBE', resolution_code: 'NO_EVIDENCE' }).expect(400);
    await request(app).post('/api/admin/presence/exceptions/nao-e-uuid/decision').send(decision).expect(400);
    expect(gateway.decide).not.toHaveBeenCalled();
  });

  it('2ª decisão: o 409 EXCEPTION_ALREADY_DECIDED do attendance é repassado (e 404 também)', async () => {
    const jaDecidida = harness({ cells: [CELL], gateway: { decide: jest.fn().mockRejectedValue(new PresenceReviewUpstreamError(409, 'EXCEPTION_ALREADY_DECIDED')) } });
    const r409 = await request(jaDecidida.app).post(`/api/admin/presence/exceptions/${EVENT}/decision`).send(decision).expect(409);
    expect(r409.body).toEqual({ success: false, code: 'EXCEPTION_ALREADY_DECIDED' });
    const semExcecao = harness({ cells: [CELL], gateway: { decide: jest.fn().mockRejectedValue(new PresenceReviewUpstreamError(404, 'EXCEPTION_NOT_FOUND')) } });
    await request(semExcecao.app).post(`/api/admin/presence/exceptions/${EVENT}/decision`).send(decision).expect(404);
  });
});

describe('PresenceReviewController — log sem PII', () => {
  it('o log leva só tipo, contagens e códigos: nunca nome do prestador, nº do caso, uid nem id do evento', async () => {
    const { app } = harness({ cells: [CELL] });
    await request(app).get('/api/admin/presence/review-queue').expect(200);
    await request(app).post(`/api/admin/presence/exceptions/${EVENT}/decision`).send(decision).expect(200);
    const logged = JSON.stringify([...(logger.info as jest.Mock).mock.calls, ...(logger.warn as jest.Mock).mock.calls]);
    expect(logged).toContain('[presence/review] queue');
    for (const proibido of [WORKER_NAME, '1234', UID, EVENT]) expect(logged).not.toContain(proibido);
  });
});
