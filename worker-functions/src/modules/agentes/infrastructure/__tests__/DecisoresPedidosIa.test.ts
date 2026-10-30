import { resolverDecisoresPedidosIa } from '../DecisoresPedidosIa';

describe('resolverDecisoresPedidosIa (spec 078, M3b-2)', () => {
  const client = (rows: Array<{ uid: string; cells: string[] | null; master: boolean | null }>) =>
    ({ query: jest.fn(async () => ({ rows })) }) as never;

  it('célula pedidos_ia:decidir OU Acesso Master; só ler, nada ou célula nula não recebem', async () => {
    const uids = await resolverDecisoresPedidosIa(
      client([
        { uid: 'decide', cells: ['pedidos_ia:decidir', 'pedidos_ia:read'], master: false },
        { uid: 'master', cells: [], master: true },
        { uid: 'so-le', cells: ['pedidos_ia:read'], master: false },
        { uid: 'nada', cells: null, master: null },
      ]),
    );
    expect(uids).toEqual(['decide', 'master']);
  });

  it('consulta só staff ATIVO, pelo tenant Enlite, sem escrever', async () => {
    const c = client([]) as unknown as { query: jest.Mock };
    await resolverDecisoresPedidosIa(c as never);
    const [sql] = c.query.mock.calls[0];
    expect(sql).toMatch(/u\.status = 'ACTIVE' AND u\.is_active IS NOT FALSE/);
    expect(sql).toMatch(/iam\.is_master_member/);
    expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
  });
});
