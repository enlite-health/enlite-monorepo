/**
 * adminSubstitutionRequestRoutes — spec 069, §3.3. Varre o router de VERDADE com `scanExpressRouter` e afirma o PAR de células
 * a partir de mapa escrito à mão: as 2 leituras sob `patient_services:read`; a pré-visão e a criação sob
 * `patient_itinerary:update` — nunca `:write` (molde `adminItineraryWriteRoutes.test.ts`).
 */
import express from 'express';
import request from 'supertest';
import { scanExpressRouter, cellKey, undeclaredRoutes } from '@modules/identity/permissions';
import { authDouble, permissionsDouble } from '@modules/identity/interfaces/middleware/__tests__/permissionFamilyDoubles';
import { createAdminSubstitutionRequestRoutes } from '../adminSubstitutionRequestRoutes';
import type { AdminSubstitutionRequestController } from '../../controllers/AdminSubstitutionRequestController';

const handler = (m: string) => (req: express.Request, res: express.Response) => res.json({ m, id: req.params.id, sid: req.params.sid });
const controllerDuble = () =>
  ({ list: handler('list'), outgoingOptions: handler('outgoingOptions'), preview: handler('preview'), create: handler('create') }) as unknown as AdminSubstitutionRequestController;

const build = () => createAdminSubstitutionRequestRoutes(controllerDuble(), authDouble(), permissionsDouble());

const BASE = '/patients/:id/contracted-services/:sid/substitution-requests';

describe('createAdminSubstitutionRequestRoutes', () => {
  it('toda rota declara célula (perm.require no ARRAY, nunca em closure)', () => {
    expect(undeclaredRoutes(scanExpressRouter(build()), () => true)).toEqual([]);
  });

  it('são exatamente 4 rotas, com o par de células: leituras em patient_services:read, escritas em patient_itinerary:update', () => {
    const declarado = scanExpressRouter(build()).map((r) => [`${r.method} ${r.path}`, r.cell ? cellKey(r.cell.resource, r.cell.action) : null]);
    expect(declarado).toEqual([
      [`GET ${BASE}`, 'patient_services:read'],
      [`GET ${BASE}/outgoing-options`, 'patient_services:read'],
      [`POST ${BASE}/preview`, 'patient_itinerary:update'],
      [`POST ${BASE}`, 'patient_itinerary:update'],
    ]);
  });

  it('nenhuma rota usa a ação `write` (a célula `:write` é de permission_management)', () => {
    expect(scanExpressRouter(build()).some((r) => r.cell?.action === 'write')).toBe(false);
  });

  it('despacha cada rota ao método certo do controller, com id/sid', async () => {
    const a = express();
    a.use('/api/admin', build());
    const root = '/api/admin/patients/abc-1/contracted-services/svc-1/substitution-requests';
    expect((await request(a).get(root).expect(200)).body).toEqual({ m: 'list', id: 'abc-1', sid: 'svc-1' });
    expect((await request(a).get(`${root}/outgoing-options`).expect(200)).body.m).toBe('outgoingOptions');
    expect((await request(a).post(`${root}/preview`).expect(200)).body.m).toBe('preview');
    expect((await request(a).post(root).expect(200)).body.m).toBe('create');
  });
});
