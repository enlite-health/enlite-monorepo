import { PermissionService, CELL_DESCRIPTION, type ResolvedAuthz } from '@modules/identity/permissions';
import {
  AGENT_ALLOWED_CAPABILITIES,
  AGENT_CAPABILITY_CELLS,
  AGENT_CAPABILITY_NAMES,
  AGENT_SYSTEM_CAPABILITIES,
  AGENT_TENANT_ID,
  isAgentWrite,
} from '../../domain/AgentCapabilityCells';
import { AgentCellGuard, refusalResult } from '../AgentCellGuard';
import { WorkerAccountDeactivateCapability } from '../capabilities/WorkerAccountDeactivateCapability';
import { WorkerApplicationRegisterCapability } from '../capabilities/WorkerApplicationRegisterCapability';
import { HandoverNotifyCapability } from '../capabilities/HandoverNotifyCapability';

const UID = 'agent:luz';

/** Repositório em memória: o que `iam.effective_*` devolveria para o uid. */
function repo(authz: Partial<ResolvedAuthz>) {
  const full: ResolvedAuthz = {
    uid: UID, tenantId: AGENT_TENANT_ID, status: 'ACTIVE', permissions: [], countries: ['AR'],
    groups: [{ id: 'g1', name: 'Luz — espelho Recrutador' }], canSimulate: false, simulation: null, ...authz,
  };
  return {
    effectivePermissions: async () => full.permissions,
    effectiveCountries: async () => full.countries,
    snapshot: async () => full,
    countActiveStaffWithoutGroup: async () => 0,
    simulationVersion: async () => null,
  };
}
const guard = (authz: Partial<ResolvedAuthz>) =>
  new AgentCellGuard(new PermissionService(repo(authz), { feature: undefined } as never, { ttlMs: 0 }));

// Oráculo EXTERNO (evidencias/M2-capabilities-celulas.txt, M2.0.5 + decisões do lote 0): NÃO é derivado do próprio mapa.
const ORACULO_CLASSE_A: Record<string, string> = {
  'worker.vacancies.list': 'vacancy:read',
  'worker.interview.get': 'interview:read',
  'worker.profile.get': 'worker:read',
  'worker.documents.list': 'worker_document:read',
  'worker.profile.proposeUpdate': 'worker:update',
  'worker.profile.confirmUpdate': 'worker:update',
  'worker.applications.list': 'match:read',
  'worker.account.deactivate': 'worker:disable',
  'worker.availability.get': 'worker:read',
  'worker.availability.set': 'worker:update',
  'worker.optOut.register': 'worker:update',
  'worker.application.register': 'worker_application:create',
  'handover.notify': 'handover:create',
  'worker.vacancies.nearby': 'vacancy:read',
  'worker.byPhone': 'worker_pii:read',
};
const ORACULO_CLASSE_B = ['worker.caseMemory.get', 'worker.caseMemory.put', 'agentes.veredicto.registrar'];
const ORACULO_ESCRITAS = [
  'worker.profile.proposeUpdate', 'worker.profile.confirmUpdate', 'worker.caseMemory.put', 'handover.notify',
  'agentes.veredicto.registrar', 'worker.optOut.register', 'worker.account.deactivate', 'worker.availability.set',
  'worker.application.register',
];

describe('AgentCellGuard (porta MCP do agente, contrato §4)', () => {
  it('grupo espelho com X e sem Y: X ok, Y -> missing_cell (item 31)', async () => {
    const g = guard({ permissions: ['vacancy:read'] });
    await expect(g.check(UID, 'worker.vacancies.list')).resolves.toEqual({ ok: true, resource: 'vacancy', action: 'read', exception: false });
    await expect(g.check(UID, 'worker.interview.get')).resolves.toEqual({ ok: false, code: 'missing_cell', resource: 'interview', action: 'read' });
  });

  it('sem grupo -> no_group (mesmo com a célula "no resolvido": grupos vazios mandam)', async () => {
    const r = await guard({ groups: [], permissions: [] }).check(UID, 'worker.vacancies.list');
    expect(r).toMatchObject({ ok: false, code: 'no_group' });
  });

  it('conta não ACTIVE -> account_not_active, antes de olhar grupo ou célula', async () => {
    const r = await guard({ status: 'SUSPENDED', permissions: ['vacancy:read'] }).check(UID, 'worker.vacancies.list');
    expect(r).toMatchObject({ ok: false, code: 'account_not_active' });
  });

  it('capability fora do mapa -> no_cell_declared (fail-closed; não vira `?? true`)', async () => {
    const g = guard({ permissions: ['vacancy:read', 'worker:read'] });
    expect(await g.check(UID, 'worker.interview.book')).toMatchObject({ ok: false, code: 'no_cell_declared', resource: 'mcp_capability', action: 'worker.interview.book' });
    expect(await g.check(UID, 'constructor')).toMatchObject({ ok: false, code: 'no_cell_declared' });
    expect(await g.check(UID, 'db.query.readonly')).toMatchObject({ ok: false, code: 'no_cell_declared' });
  });

  it('classe (b) é a exceção nomeada: não exige célula do grupo (sistema) e vem marcada exception', async () => {
    const r = await guard({ groups: [], permissions: [] }).check(UID, 'worker.caseMemory.put');
    expect(r).toEqual({ ok: true, resource: 'worker_case_memory', action: 'update', exception: true });
  });

  it('a recusa sai no formato isError (resultado 200, texto com o code)', () => {
    const r = refusalResult('missing_cell', { cell: 'x:y' });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text)).toEqual({ code: 'missing_cell', cell: 'x:y' });
  });

  it('PARIDADE com o oráculo externo (M2.0.5): mesmas capabilities, mesmas células; classe (b) idem', () => {
    expect(AGENT_CAPABILITY_CELLS).toEqual(ORACULO_CLASSE_A);
    expect(Object.keys(AGENT_SYSTEM_CAPABILITIES).sort()).toEqual([...ORACULO_CLASSE_B].sort());
    expect(AGENT_ALLOWED_CAPABILITIES).toHaveLength(Object.keys(ORACULO_CLASSE_A).length + ORACULO_CLASSE_B.length);
  });

  it('PARIDADE com o código: os NAME das capabilities reais estão no mapa; escrita tem ação <> read e leitura tem read', () => {
    for (const C of [WorkerAccountDeactivateCapability, WorkerApplicationRegisterCapability, HandoverNotifyCapability]) {
      expect(AGENT_ALLOWED_CAPABILITIES).toContain(C.NAME);
    }
    for (const nome of ORACULO_ESCRITAS) {
      const par = AGENT_CAPABILITY_CELLS[nome]?.split(':') ?? [AGENT_SYSTEM_CAPABILITIES[nome].resource, AGENT_SYSTEM_CAPABILITIES[nome].action];
      expect(isAgentWrite(par[1])).toBe(true);
    }
    for (const nome of Object.keys(ORACULO_CLASSE_A).filter((n) => !ORACULO_ESCRITAS.includes(n))) {
      expect(isAgentWrite(AGENT_CAPABILITY_CELLS[nome].split(':')[1])).toBe(false);
    }
  });

  it('cobertura: lista cada capability da classe (a) com a célula e se o grupo a concede (as chaves do mapa e da lista são as mesmas)', async () => {
    expect([...AGENT_CAPABILITY_NAMES].sort()).toEqual(Object.keys(AGENT_CAPABILITY_CELLS).sort());
    const cob = await guard({ permissions: ['vacancy:read', 'worker:read'] }).coverage(UID);
    expect(cob).toHaveLength(15);
    expect(cob.filter((c) => c.granted).map((c) => c.capability).sort()).toEqual(
      ['worker.availability.get', 'worker.profile.get', 'worker.vacancies.list', 'worker.vacancies.nearby'],
    );
    expect((await guard({ status: 'SUSPENDED', permissions: ['vacancy:read'] }).coverage(UID)).some((c) => c.granted)).toBe(false);
  });

  it('as 2 células NOVAS entram no catálogo com descrição (consumidor: este mapa)', () => {
    expect(CELL_DESCRIPTION['worker_application:create']).toMatch(/Postular/);
    expect(CELL_DESCRIPTION['handover:create']).toMatch(/equipe/);
  });
});
