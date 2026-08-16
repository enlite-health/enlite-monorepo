/**
 * Use cases de grupo com repositório e publisher FALSOS: o que se prova aqui é
 * a regra da aplicação (validação, tradução chave→id, audiência do evento). As
 * invariantes que dependem de estado concorrente — anti-lockout, unicidade,
 * catálogo — são do banco e estão provadas em
 * `tests/e2e/iam-permissions-usecases.test.ts` contra Postgres real.
 */

import { AddGroupMemberUseCase, RemoveGroupMemberUseCase } from '../GroupMembershipUseCase';
import { ArchiveGroupUseCase } from '../ArchiveGroupUseCase';
import { CreatePermissionGroupUseCase } from '../CreatePermissionGroupUseCase';
import { GrantGroupCountryUseCase, RevokeGroupCountryUseCase } from '../GrantGroupCountryUseCase';
import { SetGroupPermissionsUseCase } from '../SetGroupPermissionsUseCase';
import { UpdatePermissionGroupUseCase } from '../UpdatePermissionGroupUseCase';
import type { PermissionError } from '../../domain/PermissionError';
import type { PermissionGroupDetail } from '../../domain/PermissionGroup';
import type { PermissionCatalogRepository, PermissionGroupRepository } from '../ports';

const TENANT = 'tenant-1';

function group(overrides: Partial<PermissionGroupDetail> = {}): PermissionGroupDetail {
  return {
    id: 'g1',
    tenantId: TENANT,
    name: 'Recrutamento Brasil',
    description: null,
    isSystem: false,
    archivedAt: null,
    createdBy: 'staff:gestor',
    createdAt: new Date('2026-08-16T00:00:00Z'),
    cells: ['vacancy:read'],
    countries: ['BR'],
    memberCount: 3,
    ...overrides,
  };
}

function makeRepo(detail: PermissionGroupDetail | null = group()) {
  const repo: jest.Mocked<PermissionGroupRepository> = {
    list: jest.fn(),
    findById: jest.fn().mockResolvedValue(detail),
    listMembers: jest.fn(),
    liveMemberUids: jest.fn().mockResolvedValue(['ana', 'bob']),
    membershipHistory: jest.fn(),
    create: jest.fn().mockResolvedValue('novo-id'),
    update: jest.fn().mockResolvedValue(undefined),
    archive: jest.fn().mockResolvedValue(undefined),
    setPermissions: jest.fn().mockResolvedValue(undefined),
    grantCountry: jest.fn().mockResolvedValue('scope-1'),
    revokeCountry: jest.fn().mockResolvedValue(1),
    addMember: jest.fn().mockResolvedValue('member-1'),
    removeMember: jest.fn().mockResolvedValue(1),
  };
  return repo;
}

function makeEvents() {
  return { permissionChanged: jest.fn().mockResolvedValue(undefined), countryFeatureChanged: jest.fn() };
}

function makeCatalog(known: Record<string, string>): jest.Mocked<PermissionCatalogRepository> {
  return {
    list: jest.fn(),
    idsByCellKey: jest.fn(async (keys: string[]) =>
      new Map(keys.filter((key) => key in known).map((key) => [key, known[key]])),
    ),
    sync: jest.fn(),
  };
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (err) {
    return (err as PermissionError).code;
  }
  return 'não lançou';
}

describe('CreatePermissionGroupUseCase', () => {
  it('cria com o nome normalizado', async () => {
    const repo = makeRepo();
    const result = await new CreatePermissionGroupUseCase(repo).execute({
      tenantId: TENANT,
      name: '  Recrutamento Brasil ',
    });
    expect(result).toEqual({ groupId: 'novo-id' });
    expect(repo.create).toHaveBeenCalledWith({
      tenantId: TENANT,
      name: 'Recrutamento Brasil',
      description: null,
    });
  });

  it('nome inválido nem chega ao banco', async () => {
    const repo = makeRepo();
    expect(await codeOf(() => new CreatePermissionGroupUseCase(repo).execute({ tenantId: TENANT, name: 'ab' })))
      .toBe('invalid_input');
    expect(repo.create).not.toHaveBeenCalled();
  });
});

describe('UpdatePermissionGroupUseCase', () => {
  it('renomeia e avisa os membros (o nome aparece em /v1/me/authz)', async () => {
    const repo = makeRepo();
    const events = makeEvents();
    await new UpdatePermissionGroupUseCase(repo, events).execute({
      tenantId: TENANT,
      groupId: 'g1',
      name: 'Recrutamento BR',
    });
    expect(repo.update).toHaveBeenCalledWith('g1', { name: 'Recrutamento BR', description: null });
    expect(events.permissionChanged).toHaveBeenCalledWith(['ana', 'bob']);
  });

  it('grupo de sistema não renomeia, mas aceita nova descrição', async () => {
    const repo = makeRepo(group({ isSystem: true, name: 'Acesso Master' }));
    const events = makeEvents();
    expect(
      await codeOf(() =>
        new UpdatePermissionGroupUseCase(repo, events).execute({ tenantId: TENANT, groupId: 'g1', name: 'Outro' }),
      ),
    ).toBe('system_group');
    expect(repo.update).not.toHaveBeenCalled();

    await new UpdatePermissionGroupUseCase(repo, events).execute({
      tenantId: TENANT,
      groupId: 'g1',
      name: 'Acesso Master',
      description: 'tudo',
    });
    expect(repo.update).toHaveBeenCalledWith('g1', { name: 'Acesso Master', description: 'tudo' });
  });

  it('sem `name` e sem `description` no patch, mantém o que o grupo já tinha', async () => {
    const repo = makeRepo(group({ description: 'descrição antiga' }));
    await new UpdatePermissionGroupUseCase(repo, makeEvents()).execute({ tenantId: TENANT, groupId: 'g1' });
    expect(repo.update).toHaveBeenCalledWith('g1', { description: 'descrição antiga' });
  });

  it('description null explícito limpa o campo', async () => {
    const repo = makeRepo(group({ description: 'antiga' }));
    await new UpdatePermissionGroupUseCase(repo, makeEvents()).execute({
      tenantId: TENANT,
      groupId: 'g1',
      description: null,
    });
    expect(repo.update).toHaveBeenCalledWith('g1', { description: null });
  });

  it('grupo de outro tenant é 404 (não "sem permissão")', async () => {
    const repo = makeRepo(null);
    expect(
      await codeOf(() =>
        new UpdatePermissionGroupUseCase(repo, makeEvents()).execute({ tenantId: TENANT, groupId: 'g9', name: 'X' }),
      ),
    ).toBe('not_found');
  });
});

describe('SetGroupPermissionsUseCase', () => {
  const known = { 'vacancy:read': 'id-1', 'vacancy:write': 'id-2' };

  it('traduz chaves para ids do catálogo e publica a mudança', async () => {
    const repo = makeRepo();
    const events = makeEvents();
    const result = await new SetGroupPermissionsUseCase(repo, makeCatalog(known), events).execute({
      tenantId: TENANT,
      groupId: 'g1',
      cellKeys: ['vacancy:read', 'vacancy:write', 'vacancy:read'],
      reason: 'ajuste do time',
    });
    expect(result).toEqual({ cells: 2 });
    expect(repo.setPermissions).toHaveBeenCalledWith('g1', ['id-1', 'id-2'], 'ajuste do time');
    expect(events.permissionChanged).toHaveBeenCalledWith(['ana', 'bob']);
  });

  it('chave fora do catálogo aborta ANTES de escrever, dizendo qual', async () => {
    const repo = makeRepo();
    const useCase = new SetGroupPermissionsUseCase(repo, makeCatalog(known), makeEvents());
    await expect(
      useCase.execute({ tenantId: TENANT, groupId: 'g1', cellKeys: ['vacancy:read', 'inventada:read'] }),
    ).rejects.toThrow(/inventada:read/);
    expect(repo.setPermissions).not.toHaveBeenCalled();
  });

  it('chave malformada é recusada como célula inválida', async () => {
    const repo = makeRepo();
    const useCase = new SetGroupPermissionsUseCase(repo, makeCatalog(known), makeEvents());
    expect(await codeOf(() => useCase.execute({ tenantId: TENANT, groupId: 'g1', cellKeys: ['vacancy'] })))
      .toBe('invalid_cell');
    expect(repo.setPermissions).not.toHaveBeenCalled();
  });

  it('lista vazia é permitida (grupo sem nenhuma ação)', async () => {
    const repo = makeRepo();
    await new SetGroupPermissionsUseCase(repo, makeCatalog(known), makeEvents()).execute({
      tenantId: TENANT,
      groupId: 'g1',
      cellKeys: [],
    });
    expect(repo.setPermissions).toHaveBeenCalledWith('g1', [], '');
  });

  it('motivo com dado de pessoa é recusado (lex C10)', async () => {
    const repo = makeRepo();
    const useCase = new SetGroupPermissionsUseCase(repo, makeCatalog(known), makeEvents());
    expect(
      await codeOf(() =>
        useCase.execute({ tenantId: TENANT, groupId: 'g1', cellKeys: [], reason: 'pedido de ana@enlite.health' }),
      ),
    ).toBe('invalid_input');
  });
});

describe('ArchiveGroupUseCase', () => {
  it('arquiva e devolve quantos membros perdem o acesso', async () => {
    const repo = makeRepo();
    const events = makeEvents();
    const result = await new ArchiveGroupUseCase(repo, events).execute({ tenantId: TENANT, groupId: 'g1' });
    expect(result).toEqual({ affectedMembers: 3 });
    expect(repo.archive).toHaveBeenCalledWith('g1');
    expect(events.permissionChanged).toHaveBeenCalledWith(['ana', 'bob']);
  });

  it('grupo de sistema não arquiva', async () => {
    const repo = makeRepo(group({ isSystem: true }));
    expect(
      await codeOf(() => new ArchiveGroupUseCase(repo, makeEvents()).execute({ tenantId: TENANT, groupId: 'g1' })),
    ).toBe('system_group');
    expect(repo.archive).not.toHaveBeenCalled();
  });
});

describe('concessão de país', () => {
  it('exige motivo e país suportado', async () => {
    const repo = makeRepo();
    const useCase = new GrantGroupCountryUseCase(repo, makeEvents());
    expect(await codeOf(() => useCase.execute({ tenantId: TENANT, groupId: 'g1', country: 'BR', reason: ' ' })))
      .toBe('reason_required');
    expect(
      await codeOf(() =>
        useCase.execute({ tenantId: TENANT, groupId: 'g1', country: 'US' as never, reason: 'expansão' }),
      ),
    ).toBe('invalid_country');
    expect(repo.grantCountry).not.toHaveBeenCalled();
  });

  it('concede e revoga publicando a mudança', async () => {
    const repo = makeRepo();
    const events = makeEvents();
    expect(
      await new GrantGroupCountryUseCase(repo, events).execute({
        tenantId: TENANT,
        groupId: 'g1',
        country: 'BR',
        reason: 'expansão comercial',
      }),
    ).toEqual({ scopeId: 'scope-1' });
    expect(repo.grantCountry).toHaveBeenCalledWith('g1', 'BR', 'expansão comercial');

    expect(
      await new RevokeGroupCountryUseCase(repo, events).execute({ tenantId: TENANT, groupId: 'g1', country: 'BR' }),
    ).toEqual({ revoked: 1 });
    expect(events.permissionChanged).toHaveBeenCalledTimes(2);
  });
});

describe('membership', () => {
  it('adiciona e publica a audiência ANTES + DEPOIS (quem entrou e quem saiu)', async () => {
    const repo = makeRepo();
    repo.liveMemberUids.mockResolvedValueOnce(['ana']).mockResolvedValueOnce(['ana', 'novo']);
    const events = makeEvents();
    await new AddGroupMemberUseCase(repo, events).execute({ tenantId: TENANT, groupId: 'g1', userId: 'novo' });
    expect(events.permissionChanged).toHaveBeenCalledWith(['ana', 'novo']);
  });

  it('remover inclui o REMOVIDO no aviso — senão ele fica com o cache antigo', async () => {
    const repo = makeRepo();
    repo.liveMemberUids.mockResolvedValueOnce(['ana', 'bob']).mockResolvedValueOnce(['ana']);
    const events = makeEvents();
    const result = await new RemoveGroupMemberUseCase(repo, events).execute({
      tenantId: TENANT,
      groupId: 'g1',
      userId: 'bob',
    });
    expect(result).toEqual({ removed: 1 });
    expect(events.permissionChanged).toHaveBeenCalledWith(['ana', 'bob']);
  });
});
