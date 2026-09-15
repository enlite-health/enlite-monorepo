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
  // `vacancy` é um dos 23 recursos splitados (spec 018, PR-8b, ADR-2/SUP-30) — por isso o
  // catálogo falso já precisa conhecer `create`/`update` além de `read`/`write` (a expansão
  // do use case traduz `vacancy:write` para os dois antes de ir ao catálogo).
  const known = {
    'vacancy:read': 'id-1', 'vacancy:write': 'id-2', 'vacancy:create': 'id-3', 'vacancy:update': 'id-4',
    'permission_management:write': 'id-5',
  };

  it('traduz chaves para ids do catálogo e publica a mudança', async () => {
    const repo = makeRepo();
    const events = makeEvents();
    const result = await new SetGroupPermissionsUseCase(repo, makeCatalog(known), events).execute({
      tenantId: TENANT,
      groupId: 'g1',
      cellKeys: ['vacancy:read', 'vacancy:create', 'vacancy:read'],
      reason: 'ajuste do time',
    });
    expect(result).toEqual({ cells: 2 });
    expect(repo.setPermissions).toHaveBeenCalledWith('g1', ['id-1', 'id-3'], 'ajuste do time');
    expect(events.permissionChanged).toHaveBeenCalledWith(['ana', 'bob']);
  });

  // ── ADR-2/SUP-30: janela de transição — `<recurso>:write` de recurso splitado é
  // expandido em create+update NA GRAVAÇÃO, nunca gravado como write de novo.
  it('write de recurso splitado é expandido para create+update na gravação (janela SUP-31)', async () => {
    const repo = makeRepo();
    const result = await new SetGroupPermissionsUseCase(repo, makeCatalog(known), makeEvents()).execute({
      tenantId: TENANT,
      groupId: 'g1',
      cellKeys: ['vacancy:write'],
    });
    expect(result).toEqual({ cells: 2 }); // write virou 2 células
    expect(repo.setPermissions).toHaveBeenCalledWith('g1', expect.arrayContaining(['id-3', 'id-4']), null);
    expect(repo.setPermissions.mock.calls[0][1]).toHaveLength(2);
  });

  it('permission_management:write NÃO é expandido — é a única rota que continua sob write', async () => {
    const repo = makeRepo();
    await new SetGroupPermissionsUseCase(repo, makeCatalog(known), makeEvents()).execute({
      tenantId: TENANT,
      groupId: 'g1',
      cellKeys: ['permission_management:write'],
    });
    expect(repo.setPermissions).toHaveBeenCalledWith('g1', ['id-5'], null);
  });

  it('mandar write E create/update do mesmo recurso splitado dedupe (não grava 2x)', async () => {
    const repo = makeRepo();
    const result = await new SetGroupPermissionsUseCase(repo, makeCatalog(known), makeEvents()).execute({
      tenantId: TENANT,
      groupId: 'g1',
      cellKeys: ['vacancy:write', 'vacancy:create'],
    });
    expect(result).toEqual({ cells: 2 });
    expect(repo.setPermissions.mock.calls[0][1]).toHaveLength(2);
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
    expect(repo.setPermissions).toHaveBeenCalledWith('g1', [], null);
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
  it('🔒 motivo é OPCIONAL, mas o país continua tendo de ser suportado', async () => {
    // Decisão do Gabriel (05/09): "ninguém faz um grupo e coloca motivo por ser
    // apenas de um país ou dos dois". A trilha do eixo país vive em
    // `granted_by` + `created_at` + `revoked_at`; o texto livre colhia "ok".
    // O país segue validado — ele é o que amplia o alcance de verdade.
    const repo = makeRepo();
    const useCase = new GrantGroupCountryUseCase(repo, makeEvents());

    await useCase.execute({ tenantId: TENANT, groupId: 'g1', country: 'BR', reason: null });
    await useCase.execute({ tenantId: TENANT, groupId: 'g1', country: 'BR', reason: '   ' });
    // vazio e só-espaço viram NULL — não string vazia, que seria um terceiro
    // estado sem significado
    expect(repo.grantCountry).toHaveBeenNthCalledWith(1, 'g1', 'BR', null);
    expect(repo.grantCountry).toHaveBeenNthCalledWith(2, 'g1', 'BR', null);

    // e quando VEM, continua validado: dado de pessoa no texto ainda é recusado
    expect(await codeOf(() => useCase.execute({
      tenantId: TENANT, groupId: 'g1', country: 'BR', reason: 'pedido de ana@enlite.health',
    }))).toBe('invalid_input');

    expect(
      await codeOf(() =>
        useCase.execute({ tenantId: TENANT, groupId: 'g1', country: 'US' as never, reason: 'expansão' }),
      ),
    ).toBe('invalid_country');
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
