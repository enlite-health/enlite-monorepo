import { planIamConfigImport, type IamTargetState } from '../planIamConfigImport';
import type { IamConfigSnapshot } from '../types';

const T = '00000000-0000-0000-0000-000000000001';
const base = (over: Partial<IamConfigSnapshot> = {}): IamConfigSnapshot => ({
  version: 1,
  tenantId: T,
  groups: [
    { name: 'Acesso Master', description: 'tudo', isSystem: true, cells: ['permission_management:write'], countries: ['AR'], members: ['gestor@e.com'] },
    { name: 'Recrutador', description: 'funil', isSystem: false, cells: ['worker:read'], countries: ['AR'], members: ['ana@e.com'] },
  ],
  countryFeatures: [{ country: 'AR', featureKey: 'screen:talentum', enabled: true, config: null }],
  ...over,
});
const target = (current: IamConfigSnapshot, over: Partial<IamTargetState> = {}): IamTargetState => ({
  current,
  // `vacancy` é recurso splitado (spec 018, PR-8b, ADR-2/SUP-30) — o catálogo do alvo já
  // conhece `create`/`update`; o teste que prova a expansão na importação de um arquivo
  // ANTIGO (linha ~65 abaixo) usa `vacancy:write` como exemplar (não precisa estar aqui —
  // expande ANTES do diff contra o catálogo, só o `create`/`update` final precisa).
  // `worker` SAIU de SPLIT_RESOURCES em 21/09 (spec 024, D401): `worker:create` só existia
  // pra tag (célula própria agora, `tag:create`) — `worker` mantém só `:read`/`:update` daqui
  // pra frente, sem expansão de `write`.
  catalog: new Set(['permission_management:write', 'worker:read', 'worker:update', 'vacancy:read', 'vacancy:create', 'vacancy:update']),
  knownEmails: new Set(['gestor@e.com', 'ana@e.com', 'bob@e.com']),
  // (M1) Por default, igual a `knownEmails` — os testes que precisam de um
  // e-mail removível mas NÃO staff (admin rebaixado) sobrescrevem via `over`.
  removableEmails: new Set(['gestor@e.com', 'ana@e.com', 'bob@e.com']),
  archivedGroupNames: new Set(),
  ...over,
});

describe('planIamConfigImport', () => {
  it('alvo igual ao snapshot → zero operações, zero erros (idempotência)', () => {
    const plan = planIamConfigImport(base(), target(base()));
    expect(plan).toEqual({ ops: [], errors: [], pendencies: [] });
  });

  it('grupo novo → create + células + país + membro, nesta ordem; grupo existente com descrição igual não gera update', () => {
    const desired = base({
      groups: [...base().groups, { name: 'Financeiro', description: 'x', isSystem: false, cells: ['vacancy:read'], countries: ['BR'], members: ['bob@e.com'] }],
    });
    const plan = planIamConfigImport(desired, target(base()));
    expect(plan.errors).toEqual([]);
    expect(plan.ops).toEqual([
      { kind: 'create_group', group: 'Financeiro', description: 'x' },
      { kind: 'set_permissions', group: 'Financeiro', cells: ['vacancy:read'] },
      { kind: 'grant_country', group: 'Financeiro', country: 'BR' },
      { kind: 'add_member', group: 'Financeiro', email: 'bob@e.com' },
    ]);
  });

  it('célula a mais, membro a menos, feature desligada → exatamente essas três operações', () => {
    const desired = base();
    desired.groups[1].cells = ['worker:read', 'worker:update'];
    desired.groups[1].members = [];
    desired.countryFeatures[0].enabled = false;
    const plan = planIamConfigImport(desired, target(base()));
    expect(plan.ops).toEqual([
      { kind: 'set_permissions', group: 'Recrutador', cells: ['worker:read', 'worker:update'] },
      { kind: 'remove_member', group: 'Recrutador', email: 'ana@e.com' },
      { kind: 'set_country_feature', country: 'AR', featureKey: 'screen:talentum', enabled: false, config: null },
    ]);
  });

  // ── ADR-2/SUP-30 (contracts/permissions-split.md): import de um `iam-config.json`
  // EXPORTADO ANTES do split (só `write`) expande para create+update ANTES do diff —
  // o plano nunca tenta `set_permissions` com uma célula `write` de recurso splitado.
  // Exemplar `vacancy` (não `worker` — `worker` saiu de SPLIT_RESOURCES em 21/09, spec 024).
  it('import de export ANTIGO (write puro) expande para create+update antes do diff', () => {
    const desired = base();
    desired.groups[1].cells = ['vacancy:write']; // arquivo de antes do split
    const plan = planIamConfigImport(desired, target(base())); // alvo: Recrutador só tem worker:read
    expect(plan.errors).toEqual([]);
    expect(plan.ops).toEqual([
      { kind: 'set_permissions', group: 'Recrutador', cells: ['vacancy:create', 'vacancy:update'] },
    ]);
  });

  it('permission_management:write nunca expande — Acesso Master continua igual, zero operações', () => {
    const plan = planIamConfigImport(base(), target(base()));
    expect(plan.ops.filter((op) => 'group' in op && op.group === 'Acesso Master')).toEqual([]);
  });

  it('célula fora do catálogo do alvo é ERRO — e o plano continua listando o resto para o operador ver', () => {
    const desired = base();
    desired.groups[1].cells = ['worker:read', 'patient:fly'];
    const plan = planIamConfigImport(desired, target(base()));
    expect(plan.errors).toEqual([{ code: 'unknown_cell', detail: 'Recrutador: patient:fly' }]);
    expect(plan.ops.some((o) => o.kind === 'set_permissions')).toBe(true);
  });

  it('e-mail sem conta no alvo é PENDÊNCIA, não operação nem erro', () => {
    const desired = base();
    desired.groups[1].members = ['ana@e.com', 'nova@e.com'];
    const plan = planIamConfigImport(desired, target(base()));
    expect(plan.pendencies).toEqual([{ code: 'email_without_account', email: 'nova@e.com', group: 'Recrutador' }]);
    expect(plan.ops).toEqual([]);
    expect(plan.errors).toEqual([]);
  });

  it('grupo do alvo ausente do snapshot: mantido por default; com archiveMissing arquiva só o não-sistema', () => {
    const desired = base({ groups: [base().groups[0]] });
    const cur = base({ groups: [...base().groups, { name: 'Super Admin', description: null, isSystem: true, cells: [], countries: [], members: [] }] });
    expect(planIamConfigImport(desired, target(cur)).ops).toEqual([]);
    expect(planIamConfigImport(desired, target(cur), { archiveMissing: true }).ops).toEqual([{ kind: 'archive_group', group: 'Recrutador' }]);
  });

  it('descrição diferente → update_group (só em grupo não-sistema); país removido → revoke; grupo de sistema ausente no alvo é erro', () => {
    const desired = base();
    desired.groups[1].description = 'nova';
    desired.groups[1].countries = [];
    desired.groups[0].description = 'outra'; // sistema: ignorado
    const plan = planIamConfigImport(desired, target(base()));
    expect(plan.ops).toEqual([
      { kind: 'update_group', group: 'Recrutador', description: 'nova' },
      { kind: 'revoke_country', group: 'Recrutador', country: 'AR' },
    ]);
    const semSistema = base({ groups: [base().groups[1]] });
    expect(planIamConfigImport(base(), target(semSistema)).errors).toEqual([
      { code: 'system_group_missing', detail: "grupo de sistema 'Acesso Master' não existe no alvo" },
    ]);
  });

  it('feature com config diferente gera set; igual por valor não gera', () => {
    const cur = base({ countryFeatures: [{ country: 'AR', featureKey: 'screen:talentum', enabled: true, config: { a: 1 } }] });
    const igual = base({ countryFeatures: [{ country: 'AR', featureKey: 'screen:talentum', enabled: true, config: { a: 1 } }] });
    expect(planIamConfigImport(igual, target(cur)).ops).toEqual([]);
    const dif = base({ countryFeatures: [{ country: 'AR', featureKey: 'screen:talentum', enabled: true, config: { a: 2 } }] });
    expect(planIamConfigImport(dif, target(cur)).ops).toEqual([
      { kind: 'set_country_feature', country: 'AR', featureKey: 'screen:talentum', enabled: true, config: { a: 2 } },
    ]);
  });

  it('version não suportada é erro', () => {
    const errado = { ...base(), version: 2 as unknown as 1 };
    expect(planIamConfigImport(errado, target(base())).errors).toEqual([
      { code: 'unsupported_version', detail: 'version=2' },
    ]);
  });

  it('M5: tenant do JSON diferente do tenant do ALVO é erro — `current.tenantId` vem do BANCO, independente de `desired.tenantId` (o caminho real: o script resolve o tenant do alvo antes de montar `current`, nunca ecoa o que o JSON declara)', () => {
    const desiredTenantErrado = { ...base(), tenantId: 'outro-tenant-do-json' };
    // `target(base())` monta `current` com o tenant do ALVO (T) — igual ao que
    // `repo.exportSnapshot(await repo.resolveTenantId())` devolveria no script
    // real, e completamente independente do `tenantId` que veio no JSON acima.
    const plan = planIamConfigImport(desiredTenantErrado, target(base()));
    expect(plan.errors).toEqual([{ code: 'tenant_mismatch', detail: `snapshot=outro-tenant-do-json alvo=${T}` }]);
  });

  it('M3: remover membro cujo e-mail não tem conta NENHUMA no alvo (nem staff, nem `removableEmails`) é ERRO do plano, não `remove_member` (dry-run acusa, applyOp nunca vê a op) — o membro conhecido continua saindo normalmente. (B4) `detail` não carrega o e-mail — vai no campo estruturado', () => {
    const desired = base();
    desired.groups[1].members = ['ana@e.com']; // 'ana' fica; 'fantasma' não está no desejado nem em removableEmails
    const cur = base();
    cur.groups[1].members = ['ana@e.com', 'fantasma@e.com'];
    const plan = planIamConfigImport(
      desired,
      target(cur, { knownEmails: new Set(['gestor@e.com', 'ana@e.com']), removableEmails: new Set(['gestor@e.com', 'ana@e.com']) }),
    );
    expect(plan.errors).toEqual([{ code: 'unknown_member_on_remove', detail: 'Recrutador: sem conta conhecida no alvo', email: 'fantasma@e.com' }]);
    expect(plan.errors[0].detail).not.toContain('@');
    expect(plan.ops).toEqual([]);
  });

  it('M1: membro rebaixado (role fora das 3 de staff) continua aparecendo em `current` — via `removableEmails` (SEM filtro de role), o plano CONSEGUE removê-lo, e sinaliza com a pendência `member_role_not_staff` em vez de bloquear com erro', () => {
    const desired = base();
    desired.groups[1].members = []; // snapshot desejado não quer mais 'bob' no grupo
    const cur = base();
    cur.groups[1].members = ['ana@e.com', 'bob@e.com']; // 'bob' é o admin rebaixado: vínculo vivo, role não é mais staff
    const plan = planIamConfigImport(
      desired,
      target(cur, {
        knownEmails: new Set(['gestor@e.com', 'ana@e.com']), // 'bob' NÃO é staff — não pode ser ADICIONADO
        removableEmails: new Set(['gestor@e.com', 'ana@e.com', 'bob@e.com']), // mas TEM conta viva — pode ser REMOVIDO
      }),
    );
    expect(plan.errors).toEqual([]);
    expect(plan.ops).toEqual(
      expect.arrayContaining([
        { kind: 'remove_member', group: 'Recrutador', email: 'ana@e.com' },
        { kind: 'remove_member', group: 'Recrutador', email: 'bob@e.com' },
      ]),
    );
    expect(plan.pendencies).toEqual([{ code: 'member_role_not_staff', email: 'bob@e.com', group: 'Recrutador' }]);
  });

  it('M4: grupo desejado que existe ARQUIVADO no alvo é ERRO nomeado no plano, sem tentar create_group (a UNIQUE da 206 não é parcial)', () => {
    const desired = base({
      groups: [...base().groups, { name: 'Financeiro', description: 'x', isSystem: false, cells: [], countries: [], members: [] }],
    });
    const plan = planIamConfigImport(desired, target(base(), { archivedGroupNames: new Set(['Financeiro']) }));
    expect(plan.errors).toEqual([{ code: 'archived_group_name_conflict', detail: "grupo 'Financeiro' existe arquivado no alvo — desarquivar ou renomear" }]);
    expect(plan.ops.some((o) => o.kind === 'create_group')).toBe(false);
  });
});
