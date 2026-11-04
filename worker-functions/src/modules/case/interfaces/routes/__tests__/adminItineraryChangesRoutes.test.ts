/**
 * adminItineraryChangesRoutes — C9. Varre o router de VERDADE com `scanExpressRouter` e afirma a
 * célula a partir de mapa escrito à mão (molde `adminItineraryWriteRoutes.test.ts`).
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminItineraryChangesRoutes } from '../adminItineraryChangesRoutes';
import type { AdminItineraryChangesController } from '../../controllers/AdminItineraryChangesController';

const controllerDuble = () =>
  ({
    list: (req: express.Request, res: express.Response) => res.json({ m: 'list', id: req.params.id, sid: req.params.sid }),
  }) as unknown as AdminItineraryChangesController;

const build = () => createAdminItineraryChangesRoutes(controllerDuble(), authDouble(), permissionsDouble());

describe('createAdminItineraryChangesRoutes', () => {
  it('toda rota declara célula', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('é exatamente 1 rota: GET …/itinerary/changes sob patient_services:read (a do GET do itinerário)', () => {
    const declarado = scanExpressRouter(build()).map((r) => [`${r.method} ${r.path}`, r.cell ? cellKey(r.cell.resource, r.cell.action) : null]);
    expect(declarado).toEqual([['GET /patients/:id/contracted-services/:sid/itinerary/changes', 'patient_services:read']]);
  });

  it('despacha o controller com id/sid', async () => {
    const a = express();
    a.use('/api/admin', build());
    const res = await request(a).get('/api/admin/patients/abc-123/contracted-services/svc-1/itinerary/changes').expect(200);
    expect(res.body).toEqual({ m: 'list', id: 'abc-123', sid: 'svc-1' });
  });
});
