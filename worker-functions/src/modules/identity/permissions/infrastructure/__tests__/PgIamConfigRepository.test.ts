import { PgIamConfigRepository } from '../PgIamConfigRepository';
import type { IamImportPlan } from '../../application/iamConfig/types';

const T = '00000000-0000-0000-0000-000000000001';

/** Pool com `query` e `connect()` que devolve um client com o MESMO `query`. */
function pool(query: jest.Mock) {
  const client = { query, release: jest.fn() };
  return { pool: { query, connect: jest.fn().mockResolvedValue(client) } as never, client };
}
const sqls = (q: jest.Mock) => q.mock.calls.map((c) => String(c[0]).replace(/\s+/g, ' ').trim());

describe('PgIamConfigRepository.exportSnapshot', () => {
  it('lê grupos vivos, células vivas, países vivos, membros vivos por e-mail e só overrides de feature — e normaliza', async () => {
    const query = jest.fn();
    query.mockResolvedValueOnce({ rows: [{ id: 'g1', name: 'Recrutador', description: 'f', is_system: false }, { id: 'g0', name: 'Acesso Master', description: null, is_system: true }] });
    query.mockResolvedValueOnce({ rows: [{ group_id: 'g1', key: 'worker:read' }, { group_id: 'g0', key: 'permission_management:write' }] });
    query.mockResolvedValueOnce({ rows: [{ group_id: 'g1', country: 'AR' }] });
    query.mockResolvedValueOnce({ rows: [{ group_id: 'g1', email: 'Ana@E.com' }] });
    query.mockResolvedValueOnce({ rows: [{ country: 'AR', feature_key: 'screen:x', enabled: false, config: null }] });
    const repo = new PgIamConfigRepository(pool(query).pool);

    const snap = await repo.exportSnapshot(T);

    expect(snap.groups.map((g) => g.name)).toEqual(['Acesso Master', 'Recrutador']);
    expect(snap.groups[1]).toEqual({ name: 'Recrutador', description: 'f', isSystem: false, cells: ['worker:read'], countries: ['AR'], members: ['ana@e.com'] });
    expect(snap.countryFeatures).toEqual([{ country: 'AR', featureKey: 'screen:x', enabled: false, config: null }]);
    const s = sqls(query);
    expect(s[0]).toContain('archived_at IS NULL');
    expect(s[1]).toContain('deprecated_at IS NULL');
    expect(s[2]).toContain('revoked_at IS NULL');
    expect(s[3]).toContain('removed_at IS NULL');
    expect(s[4]).toContain("source = 'override'");
  });

  it('liveCells, staffUidsByEmail e uidByEmail', async () => {
    const query = jest.fn();
    query.mockResolvedValueOnce({ rows: [{ resource: 'worker', action: 'read' }] });
    query.mockResolvedValueOnce({ rows: [{ email: 'a@e.com', firebase_uid: 'u1' }] });
    query.mockResolvedValueOnce({ rows: [{ firebase_uid: 'u9' }] });
    query.mockResolvedValueOnce({ rows: [] });
    const repo = new PgIamConfigRepository(pool(query).pool);
    expect(await repo.liveCells()).toEqual(new Set(['worker:read']));
    expect(await repo.staffUidsByEmail()).toEqual(new Map([['a@e.com', 'u1']]));
    expect(await repo.uidByEmail('G@e.com')).toBe('u9');
    expect(await repo.uidByEmail('x')).toBeNull();
  });
});

describe('PgIamConfigRepository.applyPlan', () => {
  const ctx = { tenantId: T, actorUid: 'gestor', reason: 'r' };

  it('plano com erro é recusado ANTES de abrir transação; plano vazio não abre transação', async () => {
    const query = jest.fn();
    const { pool: p } = pool(query);
    const repo = new PgIamConfigRepository(p);
    await expect(repo.applyPlan({ ops: [], errors: [{ code: 'unknown_cell', detail: 'x' }], pendencies: [] }, ctx)).rejects.toThrow('nada aplicado');
    expect(await repo.applyPlan({ ops: [], errors: [], pendencies: [] }, ctx)).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('cada operação vira a SECURITY DEFINER certa, numa transação com o ator por GUC — e commita', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    // BEGIN, set_config, groupIds, staffUids, create_group → id, set_permissions ids…
    query.mockResolvedValueOnce({ rows: [] }); // BEGIN
    query.mockResolvedValueOnce({ rows: [] }); // set_config
    query.mockResolvedValueOnce({ rows: [{ id: 'g1', name: 'Recrutador' }] }); // groupIds
    query.mockResolvedValueOnce({ rows: [{ email: 'ana@e.com', firebase_uid: 'u-ana' }] }); // uids
    query.mockResolvedValueOnce({ rows: [{ id: 'g2' }] }); // create_group Financeiro
    query.mockResolvedValueOnce({ rows: [] }); // update_group
    query.mockResolvedValueOnce({ rows: [] }); // archive_group
    query.mockResolvedValueOnce({ rows: [{ id: 'p1' }, { id: 'p2' }], rowCount: 2 }); // ids das células
    const { pool: p, client } = pool(query);
    const plan: IamImportPlan = {
      errors: [],
      pendencies: [],
      ops: [
        { kind: 'create_group', group: 'Financeiro', description: 'x' },
        { kind: 'update_group', group: 'Recrutador', description: 'y' },
        { kind: 'archive_group', group: 'Recrutador' },
        { kind: 'set_permissions', group: 'Financeiro', cells: ['a:read', 'b:read'] },
        { kind: 'grant_country', group: 'Financeiro', country: 'BR' },
        { kind: 'revoke_country', group: 'Recrutador', country: 'AR' },
        { kind: 'add_member', group: 'Financeiro', email: 'ana@e.com' },
        { kind: 'remove_member', group: 'Recrutador', email: 'ana@e.com' },
        { kind: 'set_country_feature', country: 'AR', featureKey: 'screen:x', enabled: true, config: { a: 1 } },
        { kind: 'set_country_feature', country: 'BR', featureKey: 'screen:y', enabled: false, config: null },
      ],
    };

    const n = await new PgIamConfigRepository(p).applyPlan(plan, ctx);

    expect(n).toBe(10);
    const s = sqls(query);
    expect(s[0]).toBe('BEGIN');
    expect(s[1]).toContain("set_config('app.user_uid'");
    expect(query.mock.calls[1][1]).toEqual(['gestor']);
    expect(s.filter((x) => /iam\.(create_group|update_group|archive_group|set_group_permissions|grant_country|revoke_country|add_member|remove_member|set_country_feature)\(/.test(x))).toHaveLength(10);
    expect(s.some((x) => /INSERT|UPDATE|DELETE/.test(x))).toBe(false); // NUNCA SQL direto em iam.*
    expect(s[s.length - 1]).toBe('COMMIT');
    // o grupo criado nesta transação é usado pelas ops seguintes pelo id devolvido
    const setPerms = query.mock.calls.find((c) => String(c[0]).includes('iam.set_group_permissions'));
    expect(setPerms?.[1]).toEqual(['g2', ['p1', 'p2'], 'r']);
    const setFeat = query.mock.calls.find((c) => String(c[0]).includes('iam.set_country_feature'));
    expect(setFeat?.[1]).toEqual(['AR', 'screen:x', true, '{"a":1}', 'r']);
    expect(client.release).toHaveBeenCalled();
  });

  it('falha no meio → ROLLBACK e o erro sobe (23514 do anti-lockout, por exemplo)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] }); // BEGIN
    query.mockResolvedValueOnce({ rows: [] }); // set_config
    query.mockResolvedValueOnce({ rows: [{ id: 'g0', name: 'Acesso Master' }] });
    query.mockResolvedValueOnce({ rows: [{ email: 'g@e.com', firebase_uid: 'u-g' }] });
    query.mockRejectedValueOnce(Object.assign(new Error('anti-lockout'), { code: '23514' }));
    const { pool: p } = pool(query);
    const plan: IamImportPlan = { errors: [], pendencies: [], ops: [{ kind: 'remove_member', group: 'Acesso Master', email: 'g@e.com' }] };
    await expect(new PgIamConfigRepository(p).applyPlan(plan, ctx)).rejects.toMatchObject({ code: '23514' });
    expect(sqls(query)[sqls(query).length - 1]).toBe('ROLLBACK');
  });

  it('grupo ou e-mail que o plano não previu, e célula sumida entre plano e execução, abortam com mensagem própria', async () => {
    const mk = () => {
      const query = jest.fn().mockResolvedValue({ rows: [] });
      query.mockResolvedValueOnce({ rows: [] });
      query.mockResolvedValueOnce({ rows: [] });
      query.mockResolvedValueOnce({ rows: [{ id: 'g1', name: 'Recrutador' }] });
      query.mockResolvedValueOnce({ rows: [] });
      return { query, repo: new PgIamConfigRepository(pool(query).pool) };
    };
    const a = mk();
    await expect(a.repo.applyPlan({ errors: [], pendencies: [], ops: [{ kind: 'grant_country', group: 'Nao Existe', country: 'AR' }] }, ctx)).rejects.toThrow("grupo 'Nao Existe' não existe");
    const b = mk();
    await expect(b.repo.applyPlan({ errors: [], pendencies: [], ops: [{ kind: 'add_member', group: 'Recrutador', email: 'x@e.com' }] }, ctx)).rejects.toThrow('e-mail sem conta');
    const c = mk();
    c.query.mockResolvedValueOnce({ rows: [{ id: 'p1' }], rowCount: 1 });
    await expect(c.repo.applyPlan({ errors: [], pendencies: [], ops: [{ kind: 'set_permissions', group: 'Recrutador', cells: ['a:read', 'b:read'] }] }, ctx)).rejects.toThrow('células desconhecidas');
  });
});
