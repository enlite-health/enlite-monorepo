/**
 * Diretório do seletor de membro (spec 078, M2): a conta `agent` é candidata SÓ de grupo de classe `AGENT`.
 * Para qualquer outro contexto (INTERNAL, EXTERNAL_THIRD_PARTY, grupo inexistente, sem contexto) o diretório devolve o que sempre devolveu: staff.
 */
const mockQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));

import { AdminRepository } from '../AdminRepository';

const GRUPO = '11111111-1111-4111-8111-111111111111';
const sqls = (): string[] => mockQuery.mock.calls.map((c) => String(c[0]));

/** Responde por conteúdo do SQL: classe do grupo, contagem e linhas. */
function banco(classeDoGrupo: string | null): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('iam.permission_groups')) return { rows: classeDoGrupo === 'AGENT' ? [{ '?column?': 1 }] : [] };
    if (sql.includes('COUNT(*)')) return { rows: [{ total: '1' }] };
    return { rows: [{ firebaseUid: sql.includes("account_type = 'agent'") ? 'agent:luz' : 'staff-1' }] };
  });
}

describe('AdminRepository.listAdmins — diretório por classe do grupo (spec 078, M2)', () => {
  beforeEach(() => mockQuery.mockReset());

  it('grupo AGENT: devolve linhas account_type=agent (e só elas), marcadas como agent', async () => {
    banco('AGENT');
    const r = await new AdminRepository().listAdmins(50, 0, GRUPO);
    expect(r.admins.map((a) => a.firebaseUid)).toEqual(['agent:luz']);
    expect(sqls().filter((s) => s.includes('FROM users')).every((s) => s.includes("account_type = 'agent'"))).toBe(true);
    expect(sqls().some((s) => s.includes("account_type = 'staff'"))).toBe(false);
    expect(sqls().some((s) => s.includes(`'agent'             AS "accountType"`))).toBe(true);
  });

  it('a classe do grupo é lida do banco, do grupo VIVO e de classe AGENT (parâmetro, não texto)', async () => {
    banco('AGENT');
    await new AdminRepository().listAdmins(50, 0, GRUPO);
    const q = mockQuery.mock.calls.find((c) => String(c[0]).includes('iam.permission_groups'))!;
    expect(String(q[0])).toContain("actor_class = 'AGENT'");
    expect(String(q[0])).toContain('archived_at IS NULL');
    expect(q[1]).toEqual([GRUPO]);
  });

  it.each([
    ['grupo INTERNAL / EXTERNAL / inexistente / arquivado (o banco não acha um AGENT vivo)', GRUPO],
    ['sem contexto (undefined)', undefined],
    ['sem contexto (null)', null],
    ['sem contexto (string vazia)', ''],
  ])('%s: devolve EXATAMENTE o staff de sempre; o agente nunca aparece', async (_n, ctx) => {
    banco('INTERNAL');
    const r = await new AdminRepository().listAdmins(50, 0, ctx as string | undefined);
    expect(r.admins.map((a) => a.firebaseUid)).toEqual(['staff-1']);
    expect(sqls().every((s) => !s.includes("account_type = 'agent'"))).toBe(true);
    expect(sqls().filter((s) => s.includes("account_type = 'staff'"))).toHaveLength(2);
    expect(r.admins[0]).not.toHaveProperty('accountType');
  });

  it('sem contexto nem consulta a classe do grupo (zero custo no fluxo humano)', async () => {
    banco('INTERNAL');
    await new AdminRepository().listAdmins(50, 0);
    expect(sqls().some((s) => s.includes('iam.permission_groups'))).toBe(false);
  });

  it('paginação do agente respeita limit/offset', async () => {
    banco('AGENT');
    await new AdminRepository().listAdmins(7, 3, GRUPO);
    const q = mockQuery.mock.calls.find((c) => String(c[0]).includes('LIMIT'))!;
    expect(q[1]).toEqual([7, 3]);
  });
});
