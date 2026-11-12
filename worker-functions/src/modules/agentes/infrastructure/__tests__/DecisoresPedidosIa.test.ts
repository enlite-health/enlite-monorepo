import { resolverDecisoresPedidosIa } from '../DecisoresPedidosIa';
import { logger } from '@shared/logging';

jest.mock('@shared/logging', () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

describe('resolverDecisoresPedidosIa (spec 078, M3b-2)', () => {
  const client = (rows: Array<{ uid: string; cells: string[] | null; master: boolean | null }>) =>
    ({ query: jest.fn(async () => ({ rows })) }) as never;

  beforeEach(() => jest.clearAllMocks());

  it('com decisores: só quem tem a célula; Master sem a célula, só-leitura e nulos não entram, sem warn', async () => {
    const uids = await resolverDecisoresPedidosIa(
      client([
        { uid: 'decide', cells: ['pedidos_ia:decidir', 'pedidos_ia:read'], master: false },
        { uid: 'master', cells: ['pedidos_ia:read'], master: true },
        { uid: 'so-le', cells: ['pedidos_ia:read'], master: false },
        { uid: 'nada', cells: null, master: null },
      ]),
    );
    expect(uids).toEqual(['decide']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('vazio (grupo não criado): cai para o Acesso Master e registra 1 warn sem PII', async () => {
    const uids = await resolverDecisoresPedidosIa(
      client([
        { uid: 'master', cells: ['pedidos_ia:read'], master: true },
        { uid: 'so-le', cells: ['pedidos_ia:read'], master: false },
      ]),
    );
    expect(uids).toEqual(['master']);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('[agentes] sem decisor com pedidos_ia:decidir; aviso ao Acesso Master');
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
