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
  catalog: new Set(['permission_management:write', 'worker:read', 'worker:write', 'vacancy:read']),
  knownEmails: new Set(['gestor@e.com', 'ana@e.com', 'bob@e.com']),
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
    desired.groups[1].cells = ['worker:read', 'worker:write'];
    desired.groups[1].members = [];
    desired.countryFeatures[0].enabled = false;
    const plan = planIamConfigImport(desired, target(base()));
    expect(plan.ops).toEqual([
      { kind: 'set_permissions', group: 'Recrutador', cells: ['worker:read', 'worker:write'] },
      { kind: 'remove_member', group: 'Recrutador', email: 'ana@e.com' },
      { kind: 'set_country_feature', country: 'AR', featureKey: 'screen:talentum', enabled: false, config: null },
    ]);
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

  it('feature com config diferente gera set; igual por valor não gera; tenant e version errados são erro', () => {
    const cur = base({ countryFeatures: [{ country: 'AR', featureKey: 'screen:talentum', enabled: true, config: { a: 1 } }] });
    const igual = base({ countryFeatures: [{ country: 'AR', featureKey: 'screen:talentum', enabled: true, config: { a: 1 } }] });
    expect(planIamConfigImport(igual, target(cur)).ops).toEqual([]);
    const dif = base({ countryFeatures: [{ country: 'AR', featureKey: 'screen:talentum', enabled: true, config: { a: 2 } }] });
    expect(planIamConfigImport(dif, target(cur)).ops).toEqual([
      { kind: 'set_country_feature', country: 'AR', featureKey: 'screen:talentum', enabled: true, config: { a: 2 } },
    ]);
    const errado = { ...base(), tenantId: 'x', version: 2 as unknown as 1 };
    expect(planIamConfigImport(errado, target(base())).errors.map((e) => e.code)).toEqual(['unsupported_version', 'tenant_mismatch']);
  });
});
