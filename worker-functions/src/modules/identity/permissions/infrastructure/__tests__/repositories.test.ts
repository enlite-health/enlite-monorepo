/**
 * Repositórios com pool mockado. O que se prova aqui: (a) que TODA escrita sai
 * por uma função `iam.*` da 279/281 — nenhum INSERT/UPDATE montado à mão —,
 * (b) que o tenant entra no WHERE das leituras, e (c) o mapeamento de linha.
 *
 * O privilégio de verdade (a role NÃO consegue escrever direto) é do banco e
 * está provado no e2e da fundação; aqui a garantia é de FORMA — se alguém
 * trocar a chamada da função por um INSERT, este teste cai antes do banco.
 */

import { poolMockWithConnect } from '@shared/database/poolMockSupport';
import { PgCountryFeatureRepository } from '../PgCountryFeatureRepository';
import { PgEffectiveAuthzRepository } from '../PgEffectiveAuthzRepository';
import { PgPermissionAuditRepository } from '../PgPermissionAuditRepository';
import { PgPermissionCatalogRepository, PROTECTED_CELLS } from '../PgPermissionCatalogRepository';
import { PgPermissionGroupRepository } from '../PgPermissionGroupRepository';
import { PgRolloutStateRepository } from '../PgRolloutStateRepository';
import type { PermissionError } from '../../domain/PermissionError';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

const TENANT = '00000000-0000-0000-0000-000000000001';

/** Pool que responde `rows` na ordem e sabe abrir client de transação. */
function makePool(...responses: Array<{ rows: unknown[]; rowCount?: number }>) {
  const query = jest.fn();
  for (const response of responses) query.mockResolvedValueOnce(response);
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  return { pool: poolMockWithConnect(query) as never, query };
}

/** SQL efetivamente executado (sem BEGIN/COMMIT/set_config, filtrados pelo mock). */
const sqls = (query: jest.Mock) => query.mock.calls.map((call) => String(call[0]));

describe('PgEffectiveAuthzRepository', () => {
  it('lê permissões e países pelas funções da 276 — nunca por SQL próprio', async () => {
    const { pool, query } = makePool(
      { rows: [{ permissions: ['vacancy:read'] }] },
      { rows: [{ countries: ['AR', 'XX'] }] },
    );
    const repo = new PgEffectiveAuthzRepository(pool, ['admin']);

    expect(await repo.effectivePermissions('ana', TENANT)).toEqual(['vacancy:read']);
    expect(await repo.effectiveCountries('ana', TENANT)).toEqual(['AR']); // 'XX' descartado
    expect(sqls(query)[0]).toContain('iam.effective_permissions($1, $2)');
    expect(sqls(query)[1]).toContain('iam.effective_countries($1, $2)');
  });

  it('snapshot devolve status/grupos e sobrevive a usuário inexistente', async () => {
    const { pool } = makePool({
      rows: [
        {
          status: 'ACTIVE',
          permissions: ['vacancy:read'],
          countries: ['AR'],
          groups: [{ id: 'g1', name: 'Recrutador' }],
        },
      ],
    });
    const repo = new PgEffectiveAuthzRepository(pool, ['admin']);
    expect(await repo.snapshot('ana', TENANT)).toEqual({
      uid: 'ana',
      tenantId: TENANT,
      status: 'ACTIVE',
      permissions: ['vacancy:read'],
      countries: ['AR'],
      groups: [{ id: 'g1', name: 'Recrutador' }],
    });

    const vazio = makePool({ rows: [] });
    const semUsuario = await new PgEffectiveAuthzRepository(vazio.pool, ['admin']).snapshot('fantasma', TENANT);
    expect(semUsuario).toMatchObject({ status: null, permissions: [], countries: [], groups: [] });
  });

  it('status desconhecido não é repassado como se fosse válido', async () => {
    const { pool } = makePool({ rows: [{ status: 'INVENTADO', permissions: [], countries: [], groups: [] }] });
    const repo = new PgEffectiveAuthzRepository(pool, ['admin']);
    expect((await repo.snapshot('ana', TENANT)).status).toBeNull();
  });

  it('contagem de staff sem grupo recebe os papéis INJETADOS', async () => {
    const { pool, query } = makePool({ rows: [{ n: 4 }] });
    const repo = new PgEffectiveAuthzRepository(pool, ['admin', 'recruiter']);
    expect(await repo.countActiveStaffWithoutGroup(TENANT)).toBe(4);
    expect(query.mock.calls[0][1]).toEqual([TENANT, ['admin', 'recruiter']]);
  });
});

describe('PgPermissionGroupRepository', () => {
  const row = {
    id: 'g1',
    tenant_id: TENANT,
    name: 'Recrutador',
    description: null,
    is_system: true,
    archived_at: null,
    created_by: null,
    created_at: new Date('2026-08-16T00:00:00Z'),
    cells: ['vacancy:read'],
    countries: ['AR', 'ZZ'],
    member_count: 2,
  };

  it('list/findById filtram por tenant e mapeiam a linha', async () => {
    const { pool, query } = makePool({ rows: [row] }, { rows: [row] });
    const repo = new PgPermissionGroupRepository(pool);

    const list = await repo.list(TENANT);
    expect(list[0]).toMatchObject({ id: 'g1', isSystem: true, cells: ['vacancy:read'], countries: ['AR'] });
    expect(query.mock.calls[0][1]).toEqual([TENANT, false]);

    await repo.findById(TENANT, 'g1');
    expect(query.mock.calls[1][1]).toEqual([TENANT, 'g1']);
  });

  it('grupo de outro tenant é null (não erro, não vazamento)', async () => {
    const { pool } = makePool({ rows: [] });
    expect(await new PgPermissionGroupRepository(pool).findById(TENANT, 'g9')).toBeNull();
  });

  it.each([
    ['create', (r: PgPermissionGroupRepository) => r.create({ tenantId: TENANT, name: 'X' }), 'iam.create_group'],
    ['update', (r: PgPermissionGroupRepository) => r.update('g1', { name: 'X' }), 'iam.update_group'],
    ['archive', (r: PgPermissionGroupRepository) => r.archive('g1'), 'iam.archive_group'],
    ['setPermissions', (r: PgPermissionGroupRepository) => r.setPermissions('g1', [], 'x'), 'iam.set_group_permissions'],
    ['grantCountry', (r: PgPermissionGroupRepository) => r.grantCountry('g1', 'BR', 'x'), 'iam.grant_country'],
    ['revokeCountry', (r: PgPermissionGroupRepository) => r.revokeCountry('g1', 'BR'), 'iam.revoke_country'],
    ['addMember', (r: PgPermissionGroupRepository) => r.addMember('g1', 'ana'), 'iam.add_member'],
    ['removeMember', (r: PgPermissionGroupRepository) => r.removeMember('g1', 'ana'), 'iam.remove_member'],
  ])('%s escreve SÓ pela função SECURITY DEFINER', async (_nome, call, expectedFn) => {
    const { pool, query } = makePool({ rows: [{ id: 'x', n: 1 }] });
    await call(new PgPermissionGroupRepository(pool));
    const executed = sqls(query);
    expect(executed.some((sql) => sql.includes(expectedFn))).toBe(true);
    expect(executed.some((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql))).toBe(false);
  });

  it('erro do banco vira vocabulário do módulo', async () => {
    const query = jest.fn().mockRejectedValue(Object.assign(new Error('sem célula'), { code: '42501' }));
    const repo = new PgPermissionGroupRepository(poolMockWithConnect(query) as never);
    await expect(repo.archive('g1')).rejects.toMatchObject({ code: 'forbidden' } as Partial<PermissionError>);
  });

  it('membros e histórico saem escopados por tenant', async () => {
    const { pool, query } = makePool(
      { rows: [{ user_id: 'ana', email: 'a@e.com', role: 'recruiter', status: 'ACTIVE', assigned_by: 'g', assigned_at: new Date() }] },
      { rows: [{ user_id: 'ana' }] },
      { rows: [{ id: 'm1', user_id: 'ana', group_id: 'g1', tenant_id: TENANT, assigned_by: 'g', assigned_at: new Date(), removed_by: null, removed_at: null }] },
    );
    const repo = new PgPermissionGroupRepository(pool);
    expect((await repo.listMembers(TENANT, 'g1'))[0].userId).toBe('ana');
    expect(await repo.liveMemberUids(TENANT, 'g1')).toEqual(['ana']);
    expect((await repo.membershipHistory(TENANT, 'g1', 'ana'))[0].removedAt).toBeNull();
    for (const call of query.mock.calls) expect(call[1]).toContain(TENANT);
  });
});

describe('PgPermissionCatalogRepository', () => {
  it('sync chama a função por célula e descontinua o que sumiu — tudo numa transação', async () => {
    const query = jest.fn();
    query.mockResolvedValueOnce({ rows: [{ outcome: 'inserted' }] });
    query.mockResolvedValueOnce({ rows: [{ outcome: 'revived' }] });
    query.mockResolvedValue({ rows: [{ n: 3 }] });
    const systemPool = poolMockWithConnect(query) as never;

    const repo = new PgPermissionCatalogRepository(poolMockWithConnect(jest.fn()) as never, systemPool);
    const result = await repo.sync(
      [
        { resource: 'worker', action: 'read' },
        { resource: 'patient', action: 'delete' },
      ],
      'worker-functions',
    );

    expect(result).toEqual({ inserted: 1, revived: 1, deprecated: 3, total: 2 });
    const executed = sqls(query);
    expect(executed.filter((sql) => sql.includes('iam.sync_permission_cell'))).toHaveLength(2);
    expect(executed.some((sql) => sql.includes('iam.deprecate_missing_permission_cells'))).toBe(true);
    // a categoria vem do mapa por recurso, não de quem chamou
    expect(query.mock.calls[0][1]).toEqual(['worker', 'read', null, 'Trabalhadores', 'worker-functions']);
    // e a lista de chaves vivas é o que protege contra descontinuar tudo
    expect(query.mock.calls[2][1]).toEqual(['worker-functions', ['worker:read', 'patient:delete']]);
  });

  it('célula protegida ausente da varredura vira WARN — e a lista viva segue como está (296)', async () => {
    const { logger } = jest.requireMock('@shared/logging') as { logger: { warn: jest.Mock } };
    logger.warn.mockClear();
    const query = jest.fn().mockResolvedValue({ rows: [{ outcome: 'unchanged', n: 0 }] });
    const repo = new PgPermissionCatalogRepository(poolMockWithConnect(jest.fn()) as never, poolMockWithConnect(query) as never);

    await repo.sync([{ resource: 'worker', action: 'read' }], 'worker-functions');

    const avisadas = logger.warn.mock.calls.map((c) => (c[0] as { cell: string }).cell).sort();
    expect(avisadas).toEqual([...PROTECTED_CELLS].sort());
    // O aviso NÃO injeta a célula na lista: quem decide manter é o banco, não o cliente.
    const deprecate = query.mock.calls.find((c) => String(c[0]).includes('deprecate_missing_permission_cells'));
    expect(deprecate?.[1]).toEqual(['worker-functions', ['worker:read']]);
  });

  it('com as duas protegidas na varredura, nada é avisado', async () => {
    const { logger } = jest.requireMock('@shared/logging') as { logger: { warn: jest.Mock } };
    logger.warn.mockClear();
    const query = jest.fn().mockResolvedValue({ rows: [{ outcome: 'unchanged', n: 0 }] });
    const repo = new PgPermissionCatalogRepository(poolMockWithConnect(jest.fn()) as never, poolMockWithConnect(query) as never);

    await repo.sync(
      [
        { resource: 'permission_management', action: 'read' },
        { resource: 'permission_management', action: 'write' },
      ],
      'worker-functions',
    );

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('idsByCellKey não vai ao banco com lista vazia', async () => {
    const { pool, query } = makePool();
    expect(await new PgPermissionCatalogRepository(pool, pool).idsByCellKey([])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it('list preenche categoria ausente pelo mapa do domínio', async () => {
    const { pool } = makePool({
      rows: [{ resource: 'worker', action: 'read', category: null, description: null, owner_service: null, deprecated_at: null }],
    });
    const [cell] = await new PgPermissionCatalogRepository(pool, pool).list();
    expect(cell).toMatchObject({ category: 'Trabalhadores', ownerService: 'worker-functions' });
  });
});

describe('PgCountryFeatureRepository', () => {
  it('override vai pela função de staff; default vai pela função de sistema', async () => {
    const staffQuery = jest.fn().mockResolvedValue({ rows: [] });
    const systemQuery = jest.fn().mockResolvedValue({ rows: [] });
    const repo = new PgCountryFeatureRepository(
      poolMockWithConnect(staffQuery) as never,
      poolMockWithConnect(systemQuery) as never,
    );

    await repo.setOverride('BR', 'screen:talentum', false, null, 'não existe no BR');
    expect(sqls(staffQuery)[0]).toContain('iam.set_country_feature');
    expect(staffQuery.mock.calls[0][1]).toEqual(['BR', 'screen:talentum', false, null, 'não existe no BR']);

    await repo.syncDefault('AR', 'options:doc', true, { values: ['DNI'] });
    expect(sqls(systemQuery)[0]).toContain('iam.sync_country_feature_default');
    expect(systemQuery.mock.calls[0][1]).toEqual(['AR', 'options:doc', true, '{"values":["DNI"]}']);
  });

  it('list mapeia a linha do banco', async () => {
    const { pool } = makePool({
      rows: [{ country: 'AR', feature_key: 'screen:x', enabled: true, config: null, source: 'default', reason: null, updated_by: 'system:manifest', updated_at: new Date() }],
    });
    const [feature] = await new PgCountryFeatureRepository(pool, pool).list();
    expect(feature).toMatchObject({ country: 'AR', featureKey: 'screen:x', enabled: true, source: 'default' });
  });
});

describe('PgPermissionAuditRepository', () => {
  it('record NÃO devolve promessa e NUNCA lança — auditoria não derruba request', async () => {
    const query = jest.fn().mockRejectedValue(new Error('pg fora'));
    const repo = new PgPermissionAuditRepository(poolMockWithConnect(query) as never);
    expect(
      repo.record({ tenantId: TENANT, userId: 'ana', resource: 'worker', action: 'delete', decision: 'DENY' }),
    ).toBeUndefined();
    await new Promise(process.nextTick);
    expect(query.mock.calls[0][0]).toContain('INSERT INTO iam.permission_audit_log');
  });

  it('query passa pela função gated (nunca SELECT direto na tabela)', async () => {
    const query = jest.fn().mockResolvedValue({
      rows: [{ id: '1', user_id: 'ana', resource: 'worker', action: 'read', resource_id: null, decision: 'DENY', created_at: new Date() }],
    });
    const repo = new PgPermissionAuditRepository(poolMockWithConnect(query) as never);
    const rows = await repo.query({ userId: 'ana', limit: 10 });
    expect(rows[0]).toMatchObject({ userId: 'ana', decision: 'DENY' });
    expect(sqls(query)[0]).toContain('iam.query_audit');
    expect(sqls(query).some((sql) => /SELECT[\s\S]*FROM iam.permission_audit_log/i.test(sql))).toBe(false);
  });
});

describe('bordas do mapeamento (linha ausente, coluna nula, lista cheia)', () => {
  it('idsByCellKey consulta o catálogo e devolve só o que existe VIVO', async () => {
    const { pool, query } = makePool({ rows: [{ id: 'id-1', key: 'vacancy:read' }] });
    const mapa = await new PgPermissionCatalogRepository(pool, pool).idsByCellKey(['vacancy:read', 'inventada:read']);
    expect(mapa).toEqual(new Map([['vacancy:read', 'id-1']]));
    expect(String(query.mock.calls[0][0])).toContain('deprecated_at IS NULL');
  });

  it('effective_* com resposta inesperada não inventa permissão', async () => {
    const { pool } = makePool({ rows: [] }, { rows: [{ countries: null }] });
    const repo = new PgEffectiveAuthzRepository(pool, ['admin']);
    expect(await repo.effectivePermissions('ana', TENANT)).toEqual([]);
    expect(await repo.effectiveCountries('ana', TENANT)).toEqual([]);
  });

  it('contagem sem linha vira 0 (não NaN nem undefined)', async () => {
    const { pool } = makePool({ rows: [] });
    expect(await new PgEffectiveAuthzRepository(pool, ['admin']).countActiveStaffWithoutGroup(TENANT)).toBe(0);
  });

  it('grupo com colunas nulas do banco vira detalhe com listas vazias', async () => {
    const { pool } = makePool({
      rows: [{
        id: 'g1', tenant_id: TENANT, name: 'X', description: null, is_system: false,
        archived_at: null, created_by: null, created_at: new Date(),
        cells: null, countries: null, member_count: null,
      }],
    });
    const [detalhe] = await new PgPermissionGroupRepository(pool).list(TENANT, { includeArchived: true });
    expect(detalhe).toMatchObject({ cells: [], countries: [], memberCount: 0 });
  });

  it('revoke/remove sem linha afetada devolvem 0 (idempotência)', async () => {
    const { pool } = makePool({ rows: [] }, { rows: [] });
    const repo = new PgPermissionGroupRepository(pool);
    expect(await repo.revokeCountry('g1', 'BR')).toBe(0);
    expect(await repo.removeMember('g1', 'ana')).toBe(0);
  });

  it('create que não devolve id falha explicitamente', async () => {
    const { pool } = makePool({ rows: [{}] });
    await expect(new PgPermissionGroupRepository(pool).create({ tenantId: TENANT, name: 'X' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('config da feature vai como JSON quando existe e como null quando não', async () => {
    const staffQuery = jest.fn().mockResolvedValue({ rows: [] });
    const systemQuery = jest.fn().mockResolvedValue({ rows: [] });
    const repo = new PgCountryFeatureRepository(
      poolMockWithConnect(staffQuery) as never,
      poolMockWithConnect(systemQuery) as never,
    );
    await repo.setOverride('AR', 'options:doc', true, { values: ['DNI'] }, 'lista AR');
    expect(staffQuery.mock.calls[0][1][3]).toBe('{"values":["DNI"]}');
    await repo.syncDefault('BR', 'screen:x', false, undefined);
    expect(systemQuery.mock.calls[0][1][3]).toBeNull();
  });

  it('sync sem linha de retorno na descontinuação conta 0 (não NaN)', async () => {
    const query = jest.fn();
    query.mockResolvedValueOnce({ rows: [{ outcome: 'unchanged' }] });
    query.mockResolvedValue({ rows: [] });
    const systemPool = poolMockWithConnect(query) as never;
    const result = await new PgPermissionCatalogRepository(systemPool, systemPool).sync(
      [{ resource: 'worker', action: 'read' }],
      'worker-functions',
    );
    expect(result).toEqual({ inserted: 0, revived: 0, deprecated: 0, total: 1 });
  });

  it('update só de descrição manda name null para a função (COALESCE mantém o nome)', async () => {
    const { pool, query } = makePool();
    await new PgPermissionGroupRepository(pool).update('g1', { description: 'nova' });
    expect(query.mock.calls[0][1]).toEqual(['g1', null, 'nova']);
  });

  it('auditoria: filtros ausentes viram null (a função aplica os próprios defaults)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await new PgPermissionAuditRepository(poolMockWithConnect(query) as never).query({});
    expect(query.mock.calls[0][1]).toEqual([null, null, null, null, null]);
  });

  it('trilha sem resourceId grava null, não string vazia', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    new PgPermissionAuditRepository(poolMockWithConnect(query) as never).record({
      tenantId: TENANT, userId: 'ana', resource: 'worker', action: 'read', decision: 'ALLOW',
    });
    await new Promise(process.nextTick);
    expect(query.mock.calls[0][1][4]).toBeNull();
  });
});

describe('PgRolloutStateRepository', () => {
  it('devolve o valor do marcador', async () => {
    const { pool } = makePool({ rows: [{ value: 'done' }] });
    expect(await new PgRolloutStateRepository(pool).get('permission_groups_migrated')).toBe('done');
  });

  it('marcador ausente (tabela existe, linha não) vira null', async () => {
    const { pool } = makePool({ rows: [] });
    expect(await new PgRolloutStateRepository(pool).get('permission_groups_migrated')).toBeNull();
  });

  it('tabela ausente vira null — nunca exceção no caminho do boot', async () => {
    const query = jest.fn().mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const repo = new PgRolloutStateRepository(poolMockWithConnect(query) as never);
    await expect(repo.get('qualquer')).resolves.toBeNull();
  });
});
