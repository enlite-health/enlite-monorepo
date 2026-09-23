import {
  DEFAULT_PERMISSION_CACHE_TTL_MS,
  PermissionService,
  permissionCacheTtlMs,
} from '../PermissionService';
import type { CountryFeature } from '../../domain/CountryFeature';
import type { EffectiveAuthzRepository, ResolvedAuthz } from '../ports';
import type { CountryFeatureManifest } from '../../infrastructure/country-features.manifest';

const TENANT = 'tenant-1';

function snapshot(overrides: Partial<ResolvedAuthz> = {}): ResolvedAuthz {
  return {
    uid: 'ana',
    tenantId: TENANT,
    status: 'ACTIVE',
    permissions: ['vacancy:read', 'vacancy:write'],
    countries: ['AR'],
    groups: [{ id: 'g1', name: 'Recrutador' }],
    canSimulate: false,
    simulation: null,
    ...overrides,
  };
}

function makeAuthzRepo(value = snapshot()): jest.Mocked<EffectiveAuthzRepository> {
  return {
    snapshot: jest.fn().mockResolvedValue(value),
    effectivePermissions: jest.fn().mockResolvedValue(value.permissions),
    effectiveCountries: jest.fn().mockResolvedValue(value.countries),
    countActiveStaffWithoutGroup: jest.fn().mockResolvedValue(0),
  };
}

function makeFeatureRepo(rows: CountryFeature[] = []) {
  return {
    list: jest.fn().mockResolvedValue(rows),
    setOverride: jest.fn(),
    syncDefault: jest.fn(),
  };
}

const MANIFEST: CountryFeatureManifest = {
  'screen:talentum': { AR: { enabled: true }, BR: { enabled: false } },
  'options:doc': { AR: { enabled: true, config: { values: ['DNI'] } } },
};

function featureRow(overrides: Partial<CountryFeature>): CountryFeature {
  return {
    country: 'BR',
    featureKey: 'screen:talentum',
    enabled: true,
    config: null,
    source: 'override',
    reason: 'piloto',
    updatedBy: 'staff:gestor',
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('permissionCacheTtlMs', () => {
  const original = process.env.PERMISSION_CACHE_TTL_MS;
  afterEach(() => {
    if (original === undefined) delete process.env.PERMISSION_CACHE_TTL_MS;
    else process.env.PERMISSION_CACHE_TTL_MS = original;
  });

  it('usa o default quando a env não está setada ou está vazia', () => {
    delete process.env.PERMISSION_CACHE_TTL_MS;
    expect(permissionCacheTtlMs({})).toBe(DEFAULT_PERMISSION_CACHE_TTL_MS);
    expect(permissionCacheTtlMs({ PERMISSION_CACHE_TTL_MS: '  ' })).toBe(DEFAULT_PERMISSION_CACHE_TTL_MS);
  });

  it('aceita 0 (e2e, sem cache) e recusa valor inválido', () => {
    expect(permissionCacheTtlMs({ PERMISSION_CACHE_TTL_MS: '0' })).toBe(0);
    expect(permissionCacheTtlMs({ PERMISSION_CACHE_TTL_MS: '5000' })).toBe(5000);
    expect(permissionCacheTtlMs({ PERMISSION_CACHE_TTL_MS: 'abc' })).toBe(DEFAULT_PERMISSION_CACHE_TTL_MS);
    expect(permissionCacheTtlMs({ PERMISSION_CACHE_TTL_MS: '-1' })).toBe(DEFAULT_PERMISSION_CACHE_TTL_MS);
  });
});

describe('PermissionService — resolução e cache', () => {
  it('serve do cache dentro do TTL e reconsulta depois dele', async () => {
    let now = 1_000;
    const repo = makeAuthzRepo();
    const service = new PermissionService(repo, makeFeatureRepo(), { ttlMs: 30_000, now: () => now });

    await service.resolve('ana', TENANT);
    await service.resolve('ana', TENANT);
    expect(repo.snapshot).toHaveBeenCalledTimes(1);

    now += 30_001;
    await service.resolve('ana', TENANT);
    expect(repo.snapshot).toHaveBeenCalledTimes(2);
  });

  it('TTL 0 nunca guarda — é o modo do e2e', async () => {
    const repo = makeAuthzRepo();
    const service = new PermissionService(repo, makeFeatureRepo(), { ttlMs: 0 });
    await service.resolve('ana', TENANT);
    await service.resolve('ana', TENANT);
    expect(repo.snapshot).toHaveBeenCalledTimes(2);
  });

  it('cache é por (tenant, uid) — um uid não serve resposta do outro', async () => {
    const repo = makeAuthzRepo();
    const service = new PermissionService(repo, makeFeatureRepo(), { ttlMs: 30_000 });
    await service.resolve('ana', TENANT);
    await service.resolve('bob', TENANT);
    await service.resolve('ana', 'outro-tenant');
    expect(repo.snapshot).toHaveBeenCalledTimes(3);
  });

  it('invalidate(uids) derruba só os citados; sem argumento derruba tudo', async () => {
    const repo = makeAuthzRepo();
    const service = new PermissionService(repo, makeFeatureRepo(), { ttlMs: 30_000 });
    await service.resolve('ana', TENANT);
    await service.resolve('bob', TENANT);

    service.invalidate(['ana']);
    await service.resolve('ana', TENANT);
    await service.resolve('bob', TENANT);
    expect(repo.snapshot).toHaveBeenCalledTimes(3);

    service.invalidate();
    await service.resolve('bob', TENANT);
    expect(repo.snapshot).toHaveBeenCalledTimes(4);
  });

  it('não cresce sem limite: passando do teto, a entrada mais antiga sai', async () => {
    const repo = makeAuthzRepo();
    const service = new PermissionService(repo, makeFeatureRepo(), { ttlMs: 30_000 });
    for (let i = 0; i < 2_001; i += 1) await service.resolve(`uid-${i}`, TENANT);
    expect(repo.snapshot).toHaveBeenCalledTimes(2_001);
    // o primeiro uid foi despejado — volta a consultar
    await service.resolve('uid-0', TENANT);
    expect(repo.snapshot).toHaveBeenCalledTimes(2_002);
    // e um recente continua em cache
    await service.resolve('uid-2000', TENANT);
    expect(repo.snapshot).toHaveBeenCalledTimes(2_002);
  });

  it('can() exige célula E conta ACTIVE', async () => {
    const ativo = new PermissionService(makeAuthzRepo(), makeFeatureRepo(), { ttlMs: 0 });
    expect(await ativo.can('ana', TENANT, 'vacancy', 'write')).toBe(true);
    expect(await ativo.can('ana', TENANT, 'worker', 'delete')).toBe(false);

    const suspenso = new PermissionService(
      makeAuthzRepo(snapshot({ status: 'SUSPENDED' })),
      makeFeatureRepo(),
      { ttlMs: 0 },
    );
    expect(await suspenso.can('ana', TENANT, 'vacancy', 'write')).toBe(false);

    const semGrupo = new PermissionService(
      makeAuthzRepo(snapshot({ permissions: [], countries: [], groups: [] })),
      makeFeatureRepo(),
      { ttlMs: 0 },
    );
    expect(await semGrupo.can('ana', TENANT, 'vacancy', 'read')).toBe(false);
  });
});

describe('PermissionService — defaults do construtor', () => {
  it('sem options usa TTL do ambiente, manifest da casa e relógio real', async () => {
    process.env.PERMISSION_CACHE_TTL_MS = '60000';
    const repo = makeAuthzRepo();
    const service = new PermissionService(repo, makeFeatureRepo());
    await service.resolve('ana', TENANT);
    await service.resolve('ana', TENANT);
    expect(repo.snapshot).toHaveBeenCalledTimes(1); // guardou: TTL do ambiente valeu
    // manifest da casa (não o de teste): Talentum existe na Argentina
    expect(await service.isFeatureAvailable('AR', 'screen:talentum')).toBe(true);
    delete process.env.PERMISSION_CACHE_TTL_MS;
  });
});

describe('PermissionService — disponibilidade por país', () => {
  it('banco GANHA do manifest; sem linha, o manifest vale', async () => {
    const service = new PermissionService(
      makeAuthzRepo(),
      makeFeatureRepo([featureRow({ country: 'BR', featureKey: 'screen:talentum', enabled: true })]),
      { ttlMs: 0, manifest: MANIFEST },
    );
    expect(await service.isFeatureAvailable('BR', 'screen:talentum')).toBe(true); // override
    expect(await service.isFeatureAvailable('AR', 'screen:talentum')).toBe(true); // manifest
  });

  it('sync que nunca rodou NÃO apaga o painel: cai no manifest', async () => {
    const repo = makeFeatureRepo([]);
    const service = new PermissionService(makeAuthzRepo(), repo, { ttlMs: 0, manifest: MANIFEST });
    expect(await service.isFeatureAvailable('AR', 'screen:talentum')).toBe(true);
    expect(await service.featureConfig('AR', 'options:doc')).toEqual({ values: ['DNI'] });
  });

  it('chave desconhecida é indisponível (fail-closed) e sem config', async () => {
    const service = new PermissionService(makeAuthzRepo(), makeFeatureRepo(), { ttlMs: 0, manifest: MANIFEST });
    expect(await service.isFeatureAvailable('AR', 'screen:inventada')).toBe(false);
    expect(await service.featureConfig('AR', 'screen:inventada')).toBeNull();
    expect(await service.isFeatureAvailable('BR', 'options:doc')).toBe(false); // não decidido p/ BR
  });

  it('linha do banco sem config devolve null (não undefined) no featureConfig', async () => {
    const service = new PermissionService(
      makeAuthzRepo(),
      makeFeatureRepo([featureRow({ country: 'AR', featureKey: 'options:doc', enabled: true, config: null })]),
      { ttlMs: 0, manifest: MANIFEST },
    );
    expect(await service.featureConfig('AR', 'options:doc')).toBeNull();
  });

  it('features() devolve o mapa país→chave e respeita o cache', async () => {
    let now = 0;
    const repo = makeFeatureRepo([featureRow({ country: 'AR', featureKey: 'screen:talentum', enabled: false })]);
    const service = new PermissionService(makeAuthzRepo(), repo, {
      ttlMs: 30_000,
      manifest: MANIFEST,
      now: () => now,
    });

    const map = await service.features();
    expect(map.AR['screen:talentum']).toEqual({ enabled: false, config: null });
    expect(map.BR['screen:talentum']).toEqual({ enabled: false, config: null });
    await service.features();
    expect(repo.list).toHaveBeenCalledTimes(1);

    service.invalidateFeatures();
    await service.features();
    expect(repo.list).toHaveBeenCalledTimes(2);

    now += 30_001;
    await service.features();
    expect(repo.list).toHaveBeenCalledTimes(3);
  });

  it('invalidate() sem argumento também limpa as features', async () => {
    const repo = makeFeatureRepo();
    const service = new PermissionService(makeAuthzRepo(), repo, { ttlMs: 30_000, manifest: MANIFEST });
    await service.features();
    service.invalidate();
    await service.features();
    expect(repo.list).toHaveBeenCalledTimes(2);
  });
});
