import { AssertNoActiveStaffWithoutGroupUseCase, ROLLOUT_MARKER_KEY } from '../AssertNoActiveStaffWithoutGroupUseCase';
import { GetMyAuthzUseCase } from '../GetMyAuthzUseCase';
import { ListPermissionCatalogUseCase } from '../ListPermissionCatalogUseCase';
import { AUDIT_MAX_LIMIT, QueryPermissionAuditUseCase } from '../QueryPermissionAuditUseCase';
import { SetCountryFeatureUseCase } from '../SetCountryFeatureUseCase';
import { SyncCountryFeaturesUseCase } from '../SyncCountryFeaturesUseCase';
import { SyncPermissionCatalogUseCase } from '../SyncPermissionCatalogUseCase';
import type { PermissionError } from '../../domain/PermissionError';
import type { CountryFeatureManifest } from '../../infrastructure/country-features.manifest';
import type { PermissionCell } from '../../domain/PermissionCell';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as PermissionError).code;
  }
  return 'não lançou';
}

function cell(overrides: Partial<PermissionCell>): PermissionCell {
  return {
    resource: 'worker',
    action: 'read',
    category: 'Trabalhadores',
    description: null,
    ownerService: 'worker-functions',
    deprecatedAt: null,
    ...overrides,
  };
}

describe('SyncPermissionCatalogUseCase', () => {
  it('sincroniza o declarado', async () => {
    const catalog = { list: jest.fn(), idsByCellKey: jest.fn(), sync: jest.fn().mockResolvedValue({ inserted: 1, revived: 0, deprecated: 2, total: 3 }) };
    const result = await new SyncPermissionCatalogUseCase(catalog).execute([{ resource: 'worker', action: 'read' }]);
    expect(result).toEqual({ inserted: 1, revived: 0, deprecated: 2, total: 3 });
    expect(catalog.sync).toHaveBeenCalledWith([{ resource: 'worker', action: 'read' }], 'worker-functions');
  });

  it('VARREDURA VAZIA não sincroniza — descontinuaria o catálogo inteiro', async () => {
    const catalog = { list: jest.fn(), idsByCellKey: jest.fn(), sync: jest.fn() };
    expect(await new SyncPermissionCatalogUseCase(catalog).execute([])).toBeNull();
    expect(catalog.sync).not.toHaveBeenCalled();
  });

  it('falha do banco não derruba o boot — devolve null', async () => {
    const catalog = { list: jest.fn(), idsByCellKey: jest.fn(), sync: jest.fn().mockRejectedValue(new Error('pg fora')) };
    await expect(
      new SyncPermissionCatalogUseCase(catalog).execute([{ resource: 'worker', action: 'read' }]),
    ).resolves.toBeNull();
  });
});

describe('ListPermissionCatalogUseCase', () => {
  it('agrupa por categoria, preservando a ordem que veio do banco', async () => {
    const catalog = {
      list: jest.fn().mockResolvedValue([
        cell({ resource: 'worker', action: 'read' }),
        cell({ resource: 'worker', action: 'write' }),
        cell({ resource: 'patient', action: 'read', category: 'Pacientes' }),
      ]),
      idsByCellKey: jest.fn(),
      sync: jest.fn(),
    };
    const result = await new ListPermissionCatalogUseCase(catalog).execute();
    expect(result.map((c) => c.category)).toEqual(['Trabalhadores', 'Pacientes']);
    expect(result[0].cells).toHaveLength(2);
    expect(catalog.list).toHaveBeenCalledWith(undefined);
  });

  it('repassa includeDeprecated (a auditoria precisa do que não existe mais)', async () => {
    const catalog = { list: jest.fn().mockResolvedValue([]), idsByCellKey: jest.fn(), sync: jest.fn() };
    await new ListPermissionCatalogUseCase(catalog).execute({ includeDeprecated: true });
    expect(catalog.list).toHaveBeenCalledWith({ includeDeprecated: true });
  });
});

describe('SetCountryFeatureUseCase', () => {
  const repo = () => ({ list: jest.fn(), setOverride: jest.fn().mockResolvedValue(undefined), syncDefault: jest.fn() });
  const events = () => ({ permissionChanged: jest.fn(), countryFeatureChanged: jest.fn().mockResolvedValue(undefined) });

  it('valida chave, config e motivo antes de escrever, e avisa a mudança', async () => {
    const features = repo();
    const publisher = events();
    await new SetCountryFeatureUseCase(features, publisher).execute({
      country: 'BR',
      featureKey: 'options:document-types',
      enabled: true,
      config: { values: ['CPF'] },
      reason: 'lista mínima provada',
    });
    expect(features.setOverride).toHaveBeenCalledWith('BR', 'options:document-types', true, { values: ['CPF'] }, 'lista mínima provada');
    expect(publisher.countryFeatureChanged).toHaveBeenCalledWith('BR', 'options:document-types');
  });

  it.each([
    ['chave', { featureKey: 'tela:x', config: null, reason: 'ok' }, 'invalid_feature_key'],
    ['config', { featureKey: 'screen:x', config: { values: ['A'] }, reason: 'ok' }, 'invalid_feature_config'],
    ['motivo', { featureKey: 'screen:x', config: null, reason: '' }, 'reason_required'],
  ])('recusa %s inválido sem escrever', async (_caso, patch, expected) => {
    const features = repo();
    expect(
      await codeOf(() =>
        new SetCountryFeatureUseCase(features, events()).execute({
          country: 'BR',
          enabled: false,
          ...(patch as { featureKey: string; config: unknown; reason: string }),
        }),
      ),
    ).toBe(expected);
    expect(features.setOverride).not.toHaveBeenCalled();
  });
});

describe('SyncCountryFeaturesUseCase', () => {
  const MANIFEST: CountryFeatureManifest = {
    'screen:a': { AR: { enabled: true }, BR: null },
    'screen:b': { AR: { enabled: false }, BR: { enabled: true } },
  };

  it('grava uma linha por (país, chave) DECIDIDA', async () => {
    const features = { list: jest.fn(), setOverride: jest.fn(), syncDefault: jest.fn().mockResolvedValue(undefined) };
    expect(await new SyncCountryFeaturesUseCase(features, MANIFEST).execute()).toEqual({ synced: 3, failed: 0 });
    expect(features.syncDefault).toHaveBeenCalledWith('AR', 'screen:a', true, null);
    expect(features.syncDefault).not.toHaveBeenCalledWith('BR', 'screen:a', expect.anything(), expect.anything());
  });

  it('uma linha que falha não interrompe as outras (boot nunca cai)', async () => {
    const features = {
      list: jest.fn(),
      setOverride: jest.fn(),
      syncDefault: jest.fn().mockRejectedValueOnce(new Error('permission denied')).mockResolvedValue(undefined),
    };
    expect(await new SyncCountryFeaturesUseCase(features, MANIFEST).execute()).toEqual({ synced: 2, failed: 1 });
  });
});

describe('GetMyAuthzUseCase', () => {
  it('devolve permissões, países, status, grupos e features numa resposta só', async () => {
    const client = {
      resolve: jest.fn().mockResolvedValue({
        uid: 'ana',
        tenantId: 't',
        status: 'ACTIVE',
        permissions: ['vacancy:read'],
        countries: ['AR'],
        groups: [{ id: 'g1', name: 'Recrutador' }],
      }),
      features: jest.fn().mockResolvedValue({ AR: { 'screen:talentum': { enabled: true, config: null } } }),
      can: jest.fn(),
      isFeatureAvailable: jest.fn(),
      featureConfig: jest.fn(),
      invalidate: jest.fn(),
    };
    const result = await new GetMyAuthzUseCase(client).execute({ uid: 'ana', tenantId: 't' });
    expect(result.permissions).toEqual(['vacancy:read']);
    expect(result.features.AR['screen:talentum'].enabled).toBe(true);
  });
});

describe('QueryPermissionAuditUseCase', () => {
  it('aplica default e teto de linhas', async () => {
    const audit = { record: jest.fn(), query: jest.fn().mockResolvedValue([]) };
    const useCase = new QueryPermissionAuditUseCase(audit);
    await useCase.execute();
    expect(audit.query).toHaveBeenCalledWith({ limit: 200 });
    await useCase.execute({ limit: 99_999 });
    expect(audit.query).toHaveBeenLastCalledWith({ limit: AUDIT_MAX_LIMIT });
    await useCase.execute({ limit: 0, userId: 'ana' });
    expect(audit.query).toHaveBeenLastCalledWith({ limit: 1, userId: 'ana' });
  });
});

describe('AssertNoActiveStaffWithoutGroupUseCase', () => {
  const authz = (count: number) => ({
    snapshot: jest.fn(),
    effectivePermissions: jest.fn(),
    effectiveCountries: jest.fn(),
    countActiveStaffWithoutGroup: jest.fn().mockResolvedValue(count),
  });
  // F12: `RolloutStateRepository` ganhou `set` (escrita do marcador pelo
  // script de import) — este describe só exercita `get` (leitura, o caminho
  // do boot), então `set` aqui é só para satisfazer o tipo.
  const rolloutRepo = (value: string | null) => ({ get: jest.fn().mockResolvedValue(value), set: jest.fn() });

  it('mede a contagem e o marcador de rollout', async () => {
    const useCase = new AssertNoActiveStaffWithoutGroupUseCase(authz(4), rolloutRepo(null));
    expect(await useCase.execute('t')).toEqual({ tenantId: 't', count: 4, migrated: false });
  });

  it('lê o marcador pela chave combinada com o script da migração', async () => {
    const rollout = rolloutRepo('done');
    const report = await new AssertNoActiveStaffWithoutGroupUseCase(authz(0), rollout).execute('t');
    expect(rollout.get).toHaveBeenCalledWith(ROLLOUT_MARKER_KEY);
    expect(report.migrated).toBe(true);
  });

  it('alertOnBoot NUNCA lança — nem com o banco fora (lex C2)', async () => {
    const quebrado = {
      snapshot: jest.fn(),
      effectivePermissions: jest.fn(),
      effectiveCountries: jest.fn(),
      countActiveStaffWithoutGroup: jest.fn().mockRejectedValue(new Error('pg fora')),
    };
    await expect(
      new AssertNoActiveStaffWithoutGroupUseCase(quebrado, rolloutRepo(null)).alertOnBoot('t', true),
    ).resolves.toBeUndefined();
  });

  it('engine LIGADO sem o marcador de migração é o caso grave — loga como erro e segue', async () => {
    const { logger } = jest.requireMock('@shared/logging') as { logger: { error: jest.Mock; info: jest.Mock } };
    logger.error.mockClear();
    await new AssertNoActiveStaffWithoutGroupUseCase(authz(3), rolloutRepo(null))
      .alertOnBoot('t', true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ engineEnabled: true, staffWithoutGroup: 3 }),
      expect.stringContaining('iam.rollout_state'),
    );
  });

  it('alertOnBoot cobre os três estados sem lançar', async () => {
    const rollout = rolloutRepo('done');
    await expect(
      new AssertNoActiveStaffWithoutGroupUseCase(authz(2), rollout).alertOnBoot('t', true),
    ).resolves.toBeUndefined();
    await expect(
      new AssertNoActiveStaffWithoutGroupUseCase(authz(0), rollout).alertOnBoot('t', true),
    ).resolves.toBeUndefined();
    await expect(
      new AssertNoActiveStaffWithoutGroupUseCase(authz(0), rolloutRepo(null))
        .alertOnBoot('t', false),
    ).resolves.toBeUndefined();
  });
});
