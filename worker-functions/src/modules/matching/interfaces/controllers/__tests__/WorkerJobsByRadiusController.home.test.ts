/** WorkerJobsByRadiusController — spec 096: `view` por allow-list; `center`/`applied` só com `view=home`. */
import type { Request, Response } from 'express';
import { WorkerJobsByRadiusController } from '../WorkerJobsByRadiusController';
import type { ListJobsByRadiusForWorkerUseCase } from '../../../application/ListJobsByRadiusForWorkerUseCase';

function call(query: Record<string, string>, out: unknown) {
  const execute = jest.fn().mockResolvedValueOnce(out);
  const ctrl = new WorkerJobsByRadiusController({ execute } as unknown as ListJobsByRadiusForWorkerUseCase);
  const json = jest.fn();
  const res = { status: jest.fn().mockReturnThis(), json } as unknown as Response;
  return ctrl.listMine({ user: { uid: 'u' }, query } as unknown as Request, res).then(() => ({ execute, json }));
}
const OK = { ok: true, items: [], center: { lat: 1, lng: 2 }, applied: { schedule: true, profession: true, sex: true }, missing: [] };

describe('WorkerJobsByRadiusController — view=home', () => {
  it('cadastro incompleto → items vazio + missing (e sem center quando falta o endereço)', async () => {
    const { json } = await call({ radius_km: '10', view: 'home' }, { ok: true, items: [], applied: { schedule: false, profession: true, sex: true }, missing: ['address', 'availability'] });
    expect(json).toHaveBeenCalledWith({ items: [], center: undefined, applied: { schedule: false, profession: true, sex: true }, missing: ['address', 'availability'] });
  });
  it('view=home → usa a view e responde items + center + applied', async () => {
    const { execute, json } = await call({ radius_km: '10', view: 'home' }, OK);
    expect(execute).toHaveBeenCalledWith('u', 10, { view: 'home' });
    expect(json).toHaveBeenCalledWith({ items: [], center: OK.center, applied: OK.applied, missing: [] });
  });
  it.each(['', 'HOME', 'mobile', 'home2'])('view=%p → ignorada (não é erro): resposta só com items', async (v) => {
    const { execute, json } = await call({ radius_km: '10', view: v }, { ok: true, items: [] });
    expect(execute).toHaveBeenCalledWith('u', 10);
    expect(json).toHaveBeenCalledWith({ items: [] });
  });
});
