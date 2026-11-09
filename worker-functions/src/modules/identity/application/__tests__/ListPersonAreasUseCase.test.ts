import { ListPersonAreasUseCase, type AreaRegistryReader, type StoredMembership } from '../ListPersonAreasUseCase';

const PID = '00000000-0000-4000-8000-000000000001';

/**
 * Dublê do registro com a ÁRVORE da pessoa: `workerUids` são os logins da árvore que operam uma ficha em `workers`.
 * `hasWorkerInTree` só é verdadeiro se algum login da árvore é worker (derivação por `workers.auth_uid`).
 */
function registry(opts: {
  treeUids: string[];
  workerUids?: string[];
  staffUids?: string[];
  stored?: StoredMembership[];
}): AreaRegistryReader & { hasStaffInTree(pid: string): Promise<boolean> } {
  const workers = new Set(opts.workerUids ?? []);
  return {
    // NÃO faz parte da porta: existe só para que quem derivar backoffice pela árvore enxergue um staff e o V1 fique vermelho.
    hasStaffInTree: async () => opts.treeUids.some((u) => (opts.staffUids ?? []).includes(u)),
    hasWorkerInTree: async () => opts.treeUids.some((u) => workers.has(u)),
    storedMemberships: async () => opts.stored ?? [],
  };
}

async function list(reg: AreaRegistryReader, principal: { accountType?: string | null; roles?: string[] }) {
  const r = await new ListPersonAreasUseCase(reg).execute({ principal, pid: PID });
  expect(r.isSuccess).toBe(true);
  return r.getValue();
}

describe('ListPersonAreasUseCase', () => {
  it('staff + prestador no mesmo login: backoffice·staff e care·worker, nessa ordem', async () => {
    const areas = await list(registry({ treeUids: ['u1'], workerUids: ['u1'] }), { accountType: 'staff' });
    expect(areas).toEqual([
      { area: 'backoffice', role: 'staff', entryRoute: '/admin' },
      { area: 'care', role: 'worker', entryRoute: '/' },
    ]);
  });

  it('account_type agent não abre backoffice', async () => {
    const areas = await list(registry({ treeUids: ['u1'] }), { accountType: 'agent' });
    expect(areas.map((a) => a.area)).not.toContain('backoffice');
    expect(areas).toEqual([]);
  });

  it('V1: login B da árvore sem staff não ganha backoffice, mesmo que outro login da árvore seja staff', async () => {
    // árvore = {uA (staff), uB (prestador)}; quem chama é uB, principal worker
    const reg = registry({ treeUids: ['uA', 'uB'], workerUids: ['uB'], staffUids: ['uA'] });
    const areas = await list(reg, { accountType: 'worker' });
    expect(areas.map((a) => a.area)).toEqual(['care']);
  });

  it('login staff abre backoffice (e só ele, sem ficha de prestador)', async () => {
    const areas = await list(registry({ treeUids: ['uA'] }), { accountType: 'staff' });
    expect(areas).toEqual([{ area: 'backoffice', role: 'staff', entryRoute: '/admin' }]);
  });

  it('ponte por papel: sem accountType, role de staff abre backoffice (mesma função do portão)', async () => {
    const areas = await list(registry({ treeUids: ['uA'] }), { roles: ['admin'] });
    expect(areas.map((a) => a.area)).toEqual(['backoffice']);
  });

  it('prestador em OUTRO login da árvore: care·worker aparece (derivado da árvore)', async () => {
    const reg = registry({ treeUids: ['uA', 'uB'], workerUids: ['uB'] });
    const areas = await list(reg, { accountType: 'staff' }); // quem chama é uA (staff); a ficha é de uB
    expect(areas).toEqual([
      { area: 'backoffice', role: 'staff', entryRoute: '/admin' },
      { area: 'care', role: 'worker', entryRoute: '/' },
    ]);
  });

  it('soma derivado + armazenado em ordem estável, sem duplicar', async () => {
    const reg = registry({
      treeUids: ['u1'],
      workerUids: ['u1'],
      stored: [
        { area: 'learn', role: 'teacher' },
        { area: 'care', role: 'family' },
        { area: 'learn', role: 'learner' },
        { area: 'care', role: 'worker' }, // duplicata do derivado
      ],
    });
    const areas = await list(reg, { accountType: 'staff' });
    expect(areas.map((a) => `${a.area}:${a.role}`)).toEqual([
      'backoffice:staff',
      'care:family',
      'care:worker',
      'learn:learner',
      'learn:teacher',
    ]);
    expect(areas.find((a) => a.area === 'learn')?.entryRoute).toBeNull();
    expect(areas.find((a) => a.role === 'family')?.entryRoute).toBeNull();
  });

  it('conta sem nenhum vínculo: lista vazia', async () => {
    expect(await list(registry({ treeUids: ['u1'] }), { accountType: 'worker' })).toEqual([]);
  });
});
