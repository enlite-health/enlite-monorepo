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
const OK = { ok: true, items: [], center: { lat: 1, lng: 2 }, applied: { schedule: true, profession: true, sex: true } };

describe('WorkerJobsByRadiusController — view=home', () => {
  it('view=home → usa a view e responde items + center + applied', async () => {
    const { execute, json } = await call({ radius_km: '10', view: 'home' }, OK);
    expect(execute).toHaveBeenCalledWith('u', 10, { view: 'home' });
    expect(json).toHaveBeenCalledWith({ items: [], center: OK.center, applied: OK.applied });
  });
  it.each(['', 'HOME', 'mobile', 'home2'])('view=%p → ignorada (não é erro): resposta só com items', async (v) => {
    const { execute, json } = await call({ radius_km: '10', view: v }, { ok: true, items: [] });
    expect(execute).toHaveBeenCalledWith('u', 10);
    expect(json).toHaveBeenCalledWith({ items: [] });
  });
});
