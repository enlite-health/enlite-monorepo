import {
  ComentarioObrigatorioError,
  DecisaoJaRegistradaError,
  PedidoJaDecididoError,
  MotivoObrigatorioError,
  PedidoNaoEncontradoError,
  type DecisaoInput,
  type PedidoIa,
} from '../../domain/PedidoIa';
import { PedidoIaController } from '../../interfaces/controllers/PedidoIaController';
import type { PedidoIaRepositoryPort } from '../../domain/PedidoIaRepositoryPort';
import { DecidirPedidoIaUseCase, type AvisoAplicarPort, ListarPedidosIaUseCase, ObterPedidoIaUseCase } from '../PedidosIaUseCases';

const PEDIDO: PedidoIa = {
  id: 'p1', assunto: 'a', descricao: 'd', autor: 'sol', area: 'recrutamento', grave_gatilho: 'nenhum', status: 'novo',
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

describe('gatilho (d): aceitar em degrau 3/4 avisa os decisores (spec 078, M4.4.2)', () => {
  const comDegrau = (degrau: number, grave = 'nenhum') =>
    fakeRepo({
      obter: jest.fn(async () => ({
        ...PEDIDO, grave_gatilho: grave,
        atitude_atual: { versao: 1, degrau, conteudo: 'c', caso_teste: 't', metrica_alvo: 'm', janela: '7d', gatilho_rollback: 'r' },
      })),
    });
  const aviso = (): AvisoAplicarPort & { notificar: jest.Mock } => ({ notificar: jest.fn(async () => undefined) });

  it.each([[3], [4]])('degrau %i: UMA notificação, grave=false', async (degrau) => {
    const a = aviso();
    await new DecidirPedidoIaUseCase(comDegrau(degrau), a).execute({ pedidoId: 'p1', acao: 'aceitar', actorUid: 'u1' });
    expect(a.notificar).toHaveBeenCalledTimes(1);
    expect(a.notificar).toHaveBeenCalledWith({ pedidoId: 'p1', degrau, grave: false });
  });

  it.each([[0], [1], [2]])('degrau %i: ZERO notificações (controle negativo)', async (degrau) => {
    const a = aviso();
    await new DecidirPedidoIaUseCase(comDegrau(degrau), a).execute({ pedidoId: 'p1', acao: 'aceitar', actorUid: 'u1' });
    expect(a.notificar).not.toHaveBeenCalled();
  });

  it('pedido grave: grave=true (o prazo "hoje" é derivado no publisher)', async () => {
    const a = aviso();
    await new DecidirPedidoIaUseCase(comDegrau(3, 'nunca'), a).execute({ pedidoId: 'p1', acao: 'aceitar', actorUid: 'u1' });
    expect(a.notificar).toHaveBeenCalledWith({ pedidoId: 'p1', degrau: 3, grave: true });
  });

  it('negar e descrever em degrau 3: ZERO notificações', async () => {
    const a = aviso();
    const uc = new DecidirPedidoIaUseCase(comDegrau(3), a);
    await uc.execute({ pedidoId: 'p1', acao: 'negar', actorUid: 'u1', motivo: 'm' });
    await uc.execute({ pedidoId: 'p1', acao: 'descrever', actorUid: 'u1', comentario: 'c' });
    expect(a.notificar).not.toHaveBeenCalled();
  });

  it('o aviso que falha NÃO desfaz o aceite: devolve o resultado e reporta o erro', async () => {
    const a = { notificar: jest.fn(async () => { throw new Error('boom'); }) };
    const onErro = jest.fn();
    const out = await new DecidirPedidoIaUseCase(comDegrau(3), a, onErro).execute({ pedidoId: 'p1', acao: 'aceitar', actorUid: 'u1' });
    expect(out).toEqual({ evento_id: 'e1', status: 'aceito' });
    expect(onErro).toHaveBeenCalledWith(expect.any(Error), 'DecidirPedidoIaUseCase:avisarAplicar');
  });

  it('decisão já registrada (409) não avisa', async () => {
    const a = aviso();
    const repo = { ...comDegrau(3), decidir: jest.fn(async () => { throw new DecisaoJaRegistradaError(); }) };
    await expect(new DecidirPedidoIaUseCase(repo, a).execute({ pedidoId: 'p1', acao: 'aceitar', actorUid: 'u1' })).rejects.toBeInstanceOf(DecisaoJaRegistradaError);
    expect(a.notificar).not.toHaveBeenCalled();
  });
});

describe('descrever depois de aceitar/negar -> 409 PEDIDO_JA_DECIDIDO (spec 078, decisão 3)', () => {
  it('o erro do repositório sobe intacto, sem aviso, e o controller responde 409 com o código', async () => {
    const a = { notificar: jest.fn(async () => undefined) };
    const repo = fakeRepo({ decidir: jest.fn(async () => { throw new PedidoJaDecididoError(); }) });
    const uc = new DecidirPedidoIaUseCase(repo, a);
    await expect(uc.execute({ pedidoId: 'p1', acao: 'descrever', actorUid: 'u1', comentario: 'c' })).rejects.toBeInstanceOf(PedidoJaDecididoError);
    expect(a.notificar).not.toHaveBeenCalled();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const ctrl = new PedidoIaController(new ListarPedidosIaUseCase(repo), new ObterPedidoIaUseCase(repo), uc);
    (ctrl as unknown as { fail: (e: unknown, r: unknown, m: string) => void }).fail(new PedidoJaDecididoError(), res, 'descrever');
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ success: false, code: 'PEDIDO_JA_DECIDIDO' });
  });
});
