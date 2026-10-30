import {
  ComentarioObrigatorioError,
  DecisaoJaRegistradaError,
  MotivoObrigatorioError,
  PedidoNaoEncontradoError,
  type DecisaoInput,
  type PedidoIa,
} from '../../domain/PedidoIa';
import type { PedidoIaRepositoryPort } from '../../domain/PedidoIaRepositoryPort';
import { DecidirPedidoIaUseCase, ListarPedidosIaUseCase, ObterPedidoIaUseCase } from '../PedidosIaUseCases';

const PEDIDO: PedidoIa = {
  id: 'p1', assunto: 'a', autor: 'sol', area: 'recrutamento', grave_gatilho: 'nenhum', status: 'novo',
  criado_em: '2026-10-30T00:00:00.000Z', idade_h: 1, atitude_atual: null, eventos: [],
};

function fakeRepo(over: Partial<PedidoIaRepositoryPort> = {}): PedidoIaRepositoryPort & { decididos: DecisaoInput[] } {
  const decididos: DecisaoInput[] = [];
  return {
    decididos,
    listar: jest.fn(async () => [PEDIDO]),
    obter: jest.fn(async (id: string) => (id === 'p1' ? PEDIDO : null)),
    decidir: jest.fn(async (i: DecisaoInput) => { decididos.push(i); return { evento_id: 'e1', status: 'aceito' as const }; }),
    ...over,
  };
}

describe('pedidos IA — use cases (spec 078, M3b-1)', () => {
  it('aceitar: repassa pedido, ação e ator ao repositório, sem motivo nem comentário', async () => {
    const repo = fakeRepo();
    const out = await new DecidirPedidoIaUseCase(repo).execute({ pedidoId: 'p1', acao: 'aceitar', actorUid: 'u1' });
    expect(out).toEqual({ evento_id: 'e1', status: 'aceito' });
    expect(repo.decididos).toEqual([{ pedidoId: 'p1', acao: 'aceitar', actorUid: 'u1' }]);
  });

  it('negar grava o motivo (aparado); negar sem motivo ou só com espaços -> MotivoObrigatorioError e NADA gravado', async () => {
    const repo = fakeRepo();
    const uc = new DecidirPedidoIaUseCase(repo);
    await uc.execute({ pedidoId: 'p1', acao: 'negar', actorUid: 'u1', motivo: '  fora de escopo ' });
    expect(repo.decididos[0]).toMatchObject({ acao: 'negar', motivo: 'fora de escopo' });
    await expect(uc.execute({ pedidoId: 'p1', acao: 'negar', actorUid: 'u1' })).rejects.toBeInstanceOf(MotivoObrigatorioError);
    await expect(uc.execute({ pedidoId: 'p1', acao: 'negar', actorUid: 'u1', motivo: '   ' })).rejects.toBeInstanceOf(MotivoObrigatorioError);
    expect(repo.decididos).toHaveLength(1);
  });

  it('descrever exige comentário; com comentário grava só o comentário', async () => {
    const repo = fakeRepo();
    const uc = new DecidirPedidoIaUseCase(repo);
    await expect(uc.execute({ pedidoId: 'p1', acao: 'descrever', actorUid: 'u1' })).rejects.toBeInstanceOf(ComentarioObrigatorioError);
    expect(repo.decididos).toHaveLength(0);
    await uc.execute({ pedidoId: 'p1', acao: 'descrever', actorUid: 'u1', comentario: 'reduza o escopo', motivo: 'ignorado' });
    expect(repo.decididos[0]).toEqual({ pedidoId: 'p1', acao: 'descrever', actorUid: 'u1', comentario: 'reduza o escopo' });
  });

  it('pedido inexistente e 2ª decisão: os erros do repositório sobem intactos', async () => {
    const naoAchou = fakeRepo({ decidir: jest.fn(async () => { throw new PedidoNaoEncontradoError(); }) });
    await expect(new DecidirPedidoIaUseCase(naoAchou).execute({ pedidoId: 'x', acao: 'aceitar', actorUid: 'u' })).rejects.toBeInstanceOf(PedidoNaoEncontradoError);
    const jaDecidido = fakeRepo({ decidir: jest.fn(async () => { throw new DecisaoJaRegistradaError(); }) });
    await expect(new DecidirPedidoIaUseCase(jaDecidido).execute({ pedidoId: 'p1', acao: 'aceitar', actorUid: 'u' })).rejects.toBeInstanceOf(DecisaoJaRegistradaError);
  });

  it('obter: inexistente -> PedidoNaoEncontradoError; listar repassa o filtro e NÃO decide nada', async () => {
    const repo = fakeRepo();
    await expect(new ObterPedidoIaUseCase(repo).execute('nao-existe')).rejects.toBeInstanceOf(PedidoNaoEncontradoError);
    expect(await new ObterPedidoIaUseCase(repo).execute('p1')).toBe(PEDIDO);
    await new ListarPedidosIaUseCase(repo).execute({ area: 'recrutamento', status: 'novo', grave: false });
    expect(repo.listar).toHaveBeenCalledWith({ area: 'recrutamento', status: 'novo', grave: false });
    expect(repo.decidir).not.toHaveBeenCalled();
  });
});
