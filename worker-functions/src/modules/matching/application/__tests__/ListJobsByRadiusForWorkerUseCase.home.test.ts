/**
 * ListJobsByRadiusForWorkerUseCase — spec 096 `view=home` (CA-2, CA-3): sexo filtrado no use case, 1 decrypt, center e applied.
 * Dublês do reader, do decrypt e do `withActorContext`. Ids sintéticos.
 */
import type { PoolClient } from 'pg';
import { ListJobsByRadiusForWorkerUseCase } from '../ListJobsByRadiusForWorkerUseCase';

const W = '11111111-1111-4111-8111-111111111111';
const PROFILE = { center: { lat: -37.977, lng: -57.551 }, sexEncrypted: 'cifra', occupation: 'AT', hasAvailability: true };
const base = { case_number: 1, vacancy_number: 1, title: 't', service: null, neighborhood: null, city: null, state: null, schedule: null, worker_type: [], distance_km: 1, already_applied: false };

function setup(profile: unknown, rows: Array<Record<string, unknown>>, sex = 'FEMALE') {
  const client = { query: jest.fn(async () => ({ rows: [{ id: W, status: 'REGISTERED' }] })) } as unknown as PoolClient;
  const run = jest.fn(async (fn: (c: PoolClient) => Promise<unknown>) => fn(client));
  const reader = jest.fn();
  const home = {
    profileReader: jest.fn(async () => profile),
    homeReader: jest.fn(async () => rows),
    decryptSex: jest.fn(async () => sex),
  };
  return { uc: new ListJobsByRadiusForWorkerUseCase(run as never, reader as never, home as never), reader, home };
}

describe('ListJobsByRadiusForWorkerUseCase — view=home', () => {
  it('filtra por sexo (positivo: vaga F e BOTH/nula; negativo: vaga M), remove required_sex e devolve center + applied', async () => {
    const { uc, reader, home } = setup(PROFILE, [
      { ...base, id: 'f', required_sex: 'F' }, { ...base, id: 'm', required_sex: 'M' },
      { ...base, id: 'b', required_sex: 'BOTH' }, { ...base, id: 'n', required_sex: null },
    ]);
    const out = await uc.execute('uid', 10, { view: 'home' });
    expect(out.ok && out.items.map((i) => i.id)).toEqual(['f', 'b', 'n']);
    expect(out.ok && Object.keys(out.items[0])).not.toContain('required_sex');
    expect(out).toMatchObject({ center: PROFILE.center, applied: { schedule: true, profession: true, sex: true } });
    expect(home.decryptSex).toHaveBeenCalledTimes(1);
    expect(reader).not.toHaveBeenCalled();
  });

  it('prestador sem sexo cadastrado é excluído das vagas que restringem (sem decrypt)', async () => {
    const { uc, home } = setup({ ...PROFILE, sexEncrypted: null }, [{ ...base, id: 'f', required_sex: 'F' }, { ...base, id: 'n', required_sex: null }]);
    const out = await uc.execute('uid', 10, { view: 'home' });
    expect(out.ok && out.items.map((i) => i.id)).toEqual(['n']);
    expect(home.decryptSex).not.toHaveBeenCalled();
  });

  it('nenhuma vaga restringe → nenhum decrypt', async () => {
    const { uc, home } = setup(PROFILE, [{ ...base, id: 'n', required_sex: null }]);
    await uc.execute('uid', 10, { view: 'home' });
    expect(home.decryptSex).not.toHaveBeenCalled();
  });

  it('sem zona viva → NO_SERVICE_AREA', async () => {
    const { uc } = setup(null, []);
    await expect(uc.execute('uid', 10, { view: 'home' })).resolves.toEqual({ ok: false, code: 'NO_SERVICE_AREA' });
  });

  it('sem view: caminho antigo, sem center nem applied', async () => {
    const { uc, reader } = setup(PROFILE, []);
    reader.mockResolvedValueOnce([]);
    const out = await uc.execute('uid', 10);
    expect(out).toEqual({ ok: true, items: [] });
  });
});
