/**
 * ListJobsByRadiusForWorkerUseCase — spec 077 C-37/D661: raio fechado, prestador pelo uid do token, sem zona → NO_SERVICE_AREA.
 * Dublês do reader e do `withActorContext` (o SQL é do WorkerJobsByRadiusReader.test). Ids sintéticos.
 */
import type { PoolClient } from 'pg';
import { JOB_RADII_KM, ListJobsByRadiusForWorkerUseCase } from '../ListJobsByRadiusForWorkerUseCase';

const UID = 'uid-token';
const W = '11111111-1111-4111-8111-111111111111';

function setup(worker: { id: string; status: string } | null, readerOut: unknown = []) {
  const query = jest.fn(async () => ({ rows: worker ? [worker] : [] }));
  const client = { query } as unknown as PoolClient;
  const run = jest.fn(async (fn: (c: PoolClient) => Promise<unknown>) => fn(client));
  const reader = jest.fn(async () => readerOut);
  const uc = new ListJobsByRadiusForWorkerUseCase(run as never, reader as never);
  return { uc, run, reader, query };
}

describe('ListJobsByRadiusForWorkerUseCase', () => {
  it('T-F2a-35 os 6 raios da D661, nesta ordem', () => {
    expect([...JOB_RADII_KM]).toEqual([5, 10, 15, 20, 50, 100]);
  });

  it.each([7, 0, -5, 1000, Number.NaN])('T-F2a-35 raio %p → INVALID_RADIUS sem abrir transação nem chamar o reader', async (r) => {
    const { uc, run, reader } = setup({ id: W, status: 'REGISTERED' });
    await expect(uc.execute(UID, r)).resolves.toEqual({ ok: false, code: 'INVALID_RADIUS' });
    expect(run).not.toHaveBeenCalled();
    expect(reader).not.toHaveBeenCalled();
  });

  it('T-F2a-35 prestador resolvido por auth_uid do token e repassado ao reader com o raio', async () => {
    const item = { id: 'j1', distance_km: 3 };
    const { uc, reader, query } = setup({ id: W, status: 'REGISTERED' }, [item]);
    await expect(uc.execute(UID, 15)).resolves.toEqual({ ok: true, items: [item] });
    expect(query).toHaveBeenCalledWith('SELECT id, status FROM workers WHERE auth_uid = $1 LIMIT 1', [UID]);
    expect((reader.mock.calls[0] as unknown[])[1]).toEqual({ workerId: W, radiusKm: 15 });
  });

  it('T-F2a-35 sem zona viva (reader devolve null) → NO_SERVICE_AREA', async () => {
    const { uc } = setup({ id: W, status: 'INCOMPLETE_REGISTER' }, null);
    await expect(uc.execute(UID, 10)).resolves.toEqual({ ok: false, code: 'NO_SERVICE_AREA' });
  });

  it('T-F2a-35 zona sem vaga no raio → ok com lista vazia (não é NO_SERVICE_AREA)', async () => {
    const { uc } = setup({ id: W, status: 'REGISTERED' }, []);
    await expect(uc.execute(UID, 5)).resolves.toEqual({ ok: true, items: [] });
  });

  it.each([null, { id: W, status: 'DISABLED' }])('T-F2a-35 prestador %p → ACCOUNT_INACTIVE sem chamar o reader', async (worker) => {
    const { uc, reader } = setup(worker as { id: string; status: string } | null);
    await expect(uc.execute(UID, 10)).resolves.toEqual({ ok: false, code: 'ACCOUNT_INACTIVE' });
    expect(reader).not.toHaveBeenCalled();
  });
});
