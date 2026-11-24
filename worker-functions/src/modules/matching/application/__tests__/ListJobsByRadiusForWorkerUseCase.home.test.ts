/**
 * ListJobsByRadiusForWorkerUseCase — spec 096 `view=home` (CA-2, CA-3 e decisão 19/11): cadastro completo → lista filtrada por
 * sexo com 1 decrypt; qualquer item faltando (endereço, profissão, sexo, disponibilidade) → `items: []` + `missing`, sem consultar
 * a lista nem decifrar nada. Dublês do reader, do decrypt e do `withActorContext`. Ids sintéticos.
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

describe('ListJobsByRadiusForWorkerUseCase — view=home, cadastro completo', () => {
  it('filtra por sexo (vaga F e BOTH/nula passam; vaga M não), remove required_sex e devolve center, applied e missing []', async () => {
    const { uc, reader, home } = setup(PROFILE, [
      { ...base, id: 'f', required_sex: 'F' }, { ...base, id: 'm', required_sex: 'M' },
      { ...base, id: 'b', required_sex: 'BOTH' }, { ...base, id: 'n', required_sex: null },
    ]);
    const out = await uc.execute('uid', 10, { view: 'home' });
    expect(out.ok && out.items.map((i) => i.id)).toEqual(['f', 'b', 'n']);
    expect(out.ok && Object.keys(out.items[0])).not.toContain('required_sex');
    expect(out).toMatchObject({ center: PROFILE.center, applied: { schedule: true, profession: true, sex: true }, missing: [] });
    expect(home.decryptSex).toHaveBeenCalledTimes(1);
    expect(reader).not.toHaveBeenCalled();
  });

  it('nenhuma vaga restringe → nenhum decrypt', async () => {
    const { uc, home } = setup(PROFILE, [{ ...base, id: 'n', required_sex: null }]);
    await uc.execute('uid', 10, { view: 'home' });
    expect(home.decryptSex).not.toHaveBeenCalled();
  });

  it('sem view: caminho antigo, sem center nem applied nem missing; sem zona → NO_SERVICE_AREA como sempre', async () => {
    const { uc, reader } = setup(PROFILE, []);
    reader.mockResolvedValueOnce([]);
    await expect(uc.execute('uid', 10)).resolves.toEqual({ ok: true, items: [] });
    reader.mockResolvedValueOnce(null);
    await expect(uc.execute('uid', 10)).resolves.toEqual({ ok: false, code: 'NO_SERVICE_AREA' });
  });
});

describe('ListJobsByRadiusForWorkerUseCase — view=home, fallback `nearest` (sem vaga perto)', () => {
  const nr = (id: string, d: number, sex: string | null = null) => ({ ...base, id, distance_km: d, required_sex: sex });

  function setupNearest(inRadius: Array<Record<string, unknown>>, noCap: Array<Record<string, unknown>>) {
    const s = setup(PROFILE, []);
    s.home.homeReader.mockImplementation((async (_c: unknown, a: { radiusKm: number | null }) => (a.radiusKm === null ? noCap : inRadius)) as never);
    return s;
  }

  it('items vazio → nearest com as mais próximas na ordem do reader, mesmo formato de items (sem required_sex), no máx. 10', async () => {
    const many = Array.from({ length: 12 }, (_, i) => nr(`v${i}`, 150 + i));
    const { uc, home } = setupNearest([], many);
    const out = await uc.execute('uid', 100, { view: 'home' });
    expect(out.ok && out.items).toEqual([]);
    expect(out.ok && out.nearest?.map((i) => i.id)).toEqual(many.slice(0, 10).map((i) => i.id));
    expect(out.ok && Object.keys(out.nearest?.[0] ?? {})).not.toContain('required_sex');
    expect(home.homeReader).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ radiusKm: 100 }));
    expect(home.homeReader).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ radiusKm: null }));
  });

  it('items com vaga → nearest [] e o reader sem teto NEM é chamado', async () => {
    const { uc, home } = setupNearest([nr('in', 5)], [nr('far', 200)]);
    const out = await uc.execute('uid', 100, { view: 'home' });
    expect(out.ok && out.nearest).toEqual([]);
    expect(home.homeReader).toHaveBeenCalledTimes(1);
  });

  it('nearest respeita o sexo: vaga M some para prestadora F, o corte de 10 vem DEPOIS do filtro, 1 decrypt só', async () => {
    const rows = [nr('m1', 150, 'M'), ...Array.from({ length: 11 }, (_, i) => nr(`f${i}`, 151 + i, 'F'))];
    const { uc, home } = setupNearest([], rows);
    const out = await uc.execute('uid', 100, { view: 'home' });
    expect(out.ok && out.nearest?.map((i) => i.id)).toEqual(Array.from({ length: 10 }, (_, i) => `f${i}`));
    expect(home.decryptSex).toHaveBeenCalledTimes(1);
  });

  it('cadastro incompleto → nearest [] e nenhuma leitura de lista', async () => {
    const { uc, home } = setup({ ...PROFILE, occupation: null }, [nr('x', 1)]);
    const out = await uc.execute('uid', 100, { view: 'home' });
    expect(out).toMatchObject({ items: [], nearest: [] });
    expect(home.homeReader).not.toHaveBeenCalled();
  });
});

describe('ListJobsByRadiusForWorkerUseCase — view=home, cadastro incompleto (decisão 19/11)', () => {
  const rows = [{ ...base, id: 'f', required_sex: 'F' }];

  it.each([
    ['endereço', { ...PROFILE, center: null }, 'address', false],
    ['profissão', { ...PROFILE, occupation: null }, 'profession', true],
    ['sexo', { ...PROFILE, sexEncrypted: null }, 'sex', true],
    ['disponibilidade', { ...PROFILE, hasAvailability: false }, 'availability', true],
  ])('só %s faltando → items vazio, missing [%s], lista nem consultada, nada decifrado', async (_nome, profile, item, hasCenter) => {
    const { uc, home } = setup(profile, rows);
    const out = await uc.execute('uid', 10, { view: 'home' });
    expect(out).toMatchObject({ ok: true, items: [], missing: [item] });
    expect(out.ok && 'center' in out).toBe(hasCenter);
    expect(home.homeReader).not.toHaveBeenCalled();
    expect(home.decryptSex).not.toHaveBeenCalled();
  });

  it('dois faltando (sem profissão e sem disponibilidade) → os dois, e applied diz quais valeram', async () => {
    const { uc } = setup({ ...PROFILE, occupation: null, hasAvailability: false }, rows);
    await expect(uc.execute('uid', 10, { view: 'home' })).resolves.toMatchObject({
      items: [], missing: ['profession', 'availability'], applied: { schedule: false, profession: false, sex: true },
    });
  });

  it('sem endereço NÃO é mais 409 na view=home: 200 com missing [address]', async () => {
    const { uc } = setup({ ...PROFILE, center: null }, rows);
    const out = await uc.execute('uid', 10, { view: 'home' });
    expect(out.ok).toBe(true);
  });
});
