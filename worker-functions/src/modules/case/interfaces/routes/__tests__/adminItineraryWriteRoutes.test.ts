/**
 * As rotas dos 10 escritores do itinerário — Fase 11 (7, DX-11.9) + Fase 13 (3, DX-13.8: a
 * substituição pontual). Mesmo contrato do `adminServiceTeamRoutes.test.ts`: varre o router de
 * VERDADE com `scanExpressRouter` (o mesmo que alimenta o catálogo de células) e afirma a célula de
 * cada rota a partir do MAPA escrito à mão (DX-11.1/DX-11.9/DX-13.8 + o cabeçalho do router), não do
 * código.
 *
 * ⚠️ Cobre só este router. O oráculo do app inteiro é o e2e `permission-route-inventory`
 * (`BT/permission-route-inventory.test.ts`, fora do escopo deste passo).
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminItineraryWriteRoutes } from '../adminItineraryWriteRoutes';
import type { AdminItineraryWriteController } from '../../controllers/AdminItineraryWriteController';
import type { AdminItineraryAbsenceController } from '../../controllers/AdminItineraryAbsenceController';

const SERVICES_READ = 'patient_services:read';
const ITINERARY_UPDATE = 'patient_itinerary:update';

/** O mapa esperado, escrito à mão a partir da DX-11.1/DX-11.9/DX-13.8 e do cabeçalho do router. */
const ESPERADO: Record<string, string> = {
  'GET /patients/:id/contracted-services/:sid/allocation-options': SERVICES_READ,
  'POST /patients/:id/contracted-services/:sid/itinerary/slots': ITINERARY_UPDATE,
  'PATCH /patients/:id/contracted-services/:sid/itinerary/slots/:slotId': ITINERARY_UPDATE,
  'POST /patients/:id/contracted-services/:sid/itinerary/slots/:slotId/end': ITINERARY_UPDATE,
  'POST /patients/:id/contracted-services/:sid/itinerary/slots/:slotId/allocations': ITINERARY_UPDATE,
  'POST /patients/:id/contracted-services/:sid/itinerary/allocations/:allocationId/end': ITINERARY_UPDATE,
  'POST /patients/:id/itinerary/assemble': ITINERARY_UPDATE,
  'POST /patients/:id/contracted-services/:sid/itinerary/allocations/:allocationId/absences': ITINERARY_UPDATE,
  'PATCH /patients/:id/contracted-services/:sid/itinerary/absences/:absenceId/substitute': ITINERARY_UPDATE,
  'POST /patients/:id/contracted-services/:sid/itinerary/absences/:absenceId/cancel': ITINERARY_UPDATE,
};

/** Cada handler devolve o próprio nome — é o que identifica quem foi chamado (e com que params). */
function controllerDuble(): AdminItineraryWriteController {
  const responde = (nome: string) => (req: express.Request, res: express.Response) =>
    res.json({ m: nome, id: req.params.id, sid: req.params.sid, slotId: req.params.slotId, allocationId: req.params.allocationId });
  return {
    allocationOptions: responde('allocationOptions'),
    createSlot: responde('createSlot'),
    updateSlot: responde('updateSlot'),
    endSlot: responde('endSlot'),
    allocate: responde('allocate'),
    endAllocation: responde('endAllocation'),
    assemble: responde('assemble'),
  } as unknown as AdminItineraryWriteController;
}

/** Molde igual, para os 3 métodos novos (DX-13.8) — `absenceId` também entra na resposta. */
function absenceControllerDuble(): AdminItineraryAbsenceController {
  const responde = (nome: string) => (req: express.Request, res: express.Response) =>
    res.json({ m: nome, id: req.params.id, sid: req.params.sid, allocationId: req.params.allocationId, absenceId: req.params.absenceId });
  return {
    register: responde('register'),
    setSubstitute: responde('setSubstitute'),
    cancel: responde('cancel'),
  } as unknown as AdminItineraryAbsenceController;
}

const build = () => createAdminItineraryWriteRoutes(controllerDuble(), authDouble(), permissionsDouble(), absenceControllerDuble());

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/admin', build());
  return a;
}

describe('createAdminItineraryWriteRoutes', () => {
  it('TODA rota do router declara célula — nenhuma passa sem declaração', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('cada uma das 10 rotas declara a célula do mapa (DX-11.1/DX-11.9/DX-13.8)', () => {
    const declarado = Object.fromEntries(
      scanExpressRouter(build()).map((route) => [
        `${route.method} ${route.path}`,
        route.cell ? cellKey(route.cell.resource, route.cell.action) : null,
      ]),
    );
    expect(declarado).toEqual(ESPERADO);
  });

  it('são exatamente 10 rotas: 1 leitura + 9 escritas (6 da Fase 11 + 3 da ausência, Fase 13)', () => {
    expect(scanExpressRouter(build())).toHaveLength(10);
  });

  it('critério: exatamente 1 `router.get(`, 2 `router.patch(`, 7 `router.post(` — nenhum put/delete', () => {
    const rotas = scanExpressRouter(build());
    expect(rotas.filter((r) => r.method === 'GET')).toHaveLength(1);
    expect(rotas.filter((r) => r.method === 'PATCH')).toHaveLength(2);
    expect(rotas.filter((r) => r.method === 'POST')).toHaveLength(7);
    expect(rotas.map((r) => r.method)).not.toContain('PUT');
    expect(rotas.map((r) => r.method)).not.toContain('DELETE');
  });

  it('a rota é `:sid` (e `:slotId`/`:allocationId`/`:absenceId`), nunca `:serviceId` — nome das irmãs (exceto assemble, que é só por paciente)', () => {
    const caminhos = scanExpressRouter(build())
      .map((r) => r.path)
      .filter((p) => !p.endsWith('/itinerary/assemble'));
    expect(caminhos.length).toBeGreaterThan(0);
    for (const p of caminhos) {
      expect(p).toContain(':sid');
      expect(p).not.toContain(':serviceId');
    }
  });

  // Despacho real (supertest): o método certo com id/sid/slotId/allocationId/absenceId, no molde adminServiceTeamRoutes.
  it.each([
    ['get', '/api/admin/patients/abc-123/contracted-services/svc-1/allocation-options', 'allocationOptions'],
    ['post', '/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/slots', 'createSlot'],
    ['patch', '/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/slots/slot-1', 'updateSlot'],
    ['post', '/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/slots/slot-1/end', 'endSlot'],
    ['post', '/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/slots/slot-1/allocations', 'allocate'],
    ['post', '/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/allocations/alloc-1/end', 'endAllocation'],
    ['post', '/api/admin/patients/abc-123/itinerary/assemble', 'assemble'],
    ['post', '/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/allocations/alloc-1/absences', 'register'],
    ['patch', '/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/absences/abs-1/substitute', 'setSubstitute'],
    ['post', '/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/absences/abs-1/cancel', 'cancel'],
  ] as const)('%s %s → %s', async (metodo, caminho, esperado) => {
    const res = await request(app())[metodo](caminho).expect(200);
    expect(res.body.m).toBe(esperado);
    expect(res.body.id).toBe('abc-123');
  });

  it('despacho carrega sid/slotId/allocationId corretos', async () => {
    const res = await request(app()).patch('/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/slots/slot-1').expect(200);
    expect(res.body.sid).toBe('svc-1');
    expect(res.body.slotId).toBe('slot-1');
  });

  it('sem o 4º parâmetro (absenceController), usa o DEFAULT — constrói sem quebrar (não abre banco)', () => {
    expect(createAdminItineraryWriteRoutes(controllerDuble(), authDouble(), permissionsDouble())).toBeDefined();
  });

  it('despacho da ausência carrega sid/allocationId/absenceId corretos', async () => {
    const registerRes = await request(app()).post('/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/allocations/alloc-1/absences').expect(200);
    expect(registerRes.body.sid).toBe('svc-1');
    expect(registerRes.body.allocationId).toBe('alloc-1');

    const substituteRes = await request(app()).patch('/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/absences/abs-1/substitute').expect(200);
    expect(substituteRes.body.sid).toBe('svc-1');
    expect(substituteRes.body.absenceId).toBe('abs-1');
  });

  // Nenhuma rota dinâmica fora do declarado — DELETE nunca existiu neste recurso.
  it.each([
    ['delete', '/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/slots/slot-1'],
    ['put', '/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/slots/slot-1'],
    ['post', '/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/slots/slot-1'],
    ['delete', '/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/absences/abs-1'],
  ] as const)('%s %s → 404 (rota não declarada)', async (metodo, caminho) => {
    await request(app())[metodo](caminho).expect(404);
  });
});
