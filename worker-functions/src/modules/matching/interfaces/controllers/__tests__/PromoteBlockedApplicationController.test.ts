/**
 * PromoteBlockedApplicationController.test.ts
 *
 * O contrato HTTP do botão "Promover" (D300).
 *
 * O que mais importa aqui é a distinção entre 409 e 500. As guardas do use case
 * recusam por estados legítimos do mundo que mudaram entre a tela carregar e a
 * recrutadora clicar — a vaga fechou, alguém já promoveu, a pessoa foi desativada.
 * Devolver 500 nesses casos mandaria a tela dizer "erro do sistema" para algo que
 * não é erro nenhum, e esconderia o que ela precisa saber: o motivo.
 */

// A rota constrói o controller sem injetar nada, e aí o use case abre o pool do
// singleton. Mockar a conexão é o que permite cobrir esse caminho sem banco.
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: jest.fn() }) }),
  },
}));

import { PromoteBlockedApplicationController } from '../PromoteBlockedApplicationController';
import type { PromoteBlockedApplicationsUseCase } from '../../../application/PromoteBlockedApplicationsUseCase';

const BLOCKED_ID = 'cccccccc-0000-0000-0000-333333333333';

function makeRes() {
  const res: Record<string, jest.Mock> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res as unknown as import('express').Response & { status: jest.Mock; json: jest.Mock };
}

function makeReq(blockedId: string, uid?: string) {
  return { params: { blockedId }, user: uid ? { uid } : undefined } as unknown as import('express').Request;
}

function makeController(executeForBlockedApplication: jest.Mock) {
  return new PromoteBlockedApplicationController({
    executeForBlockedApplication,
  } as unknown as PromoteBlockedApplicationsUseCase);
}

describe('PromoteBlockedApplicationController', () => {
  it('400 quando blockedId não é UUID', async () => {
    const execute = jest.fn();
    const res = makeRes();

    await makeController(execute).promote(makeReq('nao-e-uuid'), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it('404 quando a linha não existe ou já foi promovida', async () => {
    const res = makeRes();
    await makeController(jest.fn().mockResolvedValue(null)).promote(makeReq(BLOCKED_ID), res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('200 e a contagem quando promove', async () => {
    const res = makeRes();
    await makeController(jest.fn().mockResolvedValue({ promoted: 1, skipped: 0, reasons: {} }))
      .promote(makeReq(BLOCKED_ID, 'uid-flor'), res);

    expect(res.json).toHaveBeenCalledWith({ success: true, data: { blockedId: BLOCKED_ID, promoted: 1 } });
  });

  it('carimba QUEM clicou — a promoção manual não pode virar decisão de máquina na trilha', async () => {
    const execute = jest.fn().mockResolvedValue({ promoted: 1, skipped: 0, reasons: {} });

    await makeController(execute).promote(makeReq(BLOCKED_ID, 'uid-flor'), makeRes());

    const [, actor] = execute.mock.calls[0];
    expect(actor).toMatchObject({ source: 'admin_panel', id: expect.stringContaining('uid-flor') });
  });

  it.each([
    ['worker_not_eligible'],
    ['vacancy_invalid'],
    ['wja_already_exists'],
    ['unique_conflict'],
    ['worker_opted_out'],
  ])('409 (não 500) quando a guarda recusa por %s', async (reason) => {
    const res = makeRes();
    await makeController(jest.fn().mockResolvedValue({ promoted: 0, skipped: 1, reasons: { [reason]: 1 } }))
      .promote(makeReq(BLOCKED_ID), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: reason }));
  });

  it('500 quando a recusa é falha nossa (reason desconhecido), para não mascarar bug de erro de negócio', async () => {
    const res = makeRes();
    await makeController(jest.fn().mockResolvedValue({ promoted: 0, skipped: 1, reasons: { error: 1 } }))
      .promote(makeReq(BLOCKED_ID), res);

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('500 quando o use case lança', async () => {
    const res = makeRes();
    await makeController(jest.fn().mockRejectedValue(new Error('boom'))).promote(makeReq(BLOCKED_ID), res);

    expect(res.status).toHaveBeenCalledWith(500);
    // Código genérico, NUNCA a mensagem do driver: a tela ecoa isto num
    // console.error do navegador, e produção roda Clarity.
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'promote_failed' });
  });
});

describe('PromoteBlockedApplicationController — ramos defensivos', () => {
  it('constrói o use case sozinho quando nenhum é injetado (o que a rota faz)', () => {
    expect(() => new PromoteBlockedApplicationController()).not.toThrow();
  });

  it('500 e "unknown" quando a recusa vem sem motivo nenhum — nunca 409 por omissão', async () => {
    // `reasons` vazio com promoted 0 não deveria acontecer; se acontecer é bug
    // nosso, e o pior desfecho seria a tela dizer "conflito" e a pessoa reclicar.
    const res = makeRes();
    await makeController(jest.fn().mockResolvedValue({ promoted: 0, skipped: 1, reasons: {} }))
      .promote(makeReq(BLOCKED_ID), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'unknown' }));
  });

  it('rejeição que não é Error não derruba o handler', async () => {
    const res = makeRes();
    await makeController(jest.fn().mockRejectedValue('string crua')).promote(makeReq(BLOCKED_ID), res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'promote_failed' });
  });

  it('sem uid no request (token sem uid) o ator vai nulo, e não quebra', async () => {
    const execute = jest.fn().mockResolvedValue({ promoted: 1, skipped: 0, reasons: {} });
    const res = makeRes();

    await makeController(execute).promote(makeReq(BLOCKED_ID), res);

    expect(execute.mock.calls[0][1]).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

/**
 * CONTRATO com a tela — o vão onde o defeito morava.
 *
 * O 409 saía sem `code`/`reason`. O `ApiError` do frontend popula a escolha da
 * frase SÓ por esses dois campos, então toda recusa caía no `defaultValue` e a
 * recrutadora lia "Não foi possível promover. Tente de novo." — inclusive no caso
 * de opt-out, onde repetir é exatamente o que ela não deve fazer.
 *
 * Os dois lados tinham teste, e nenhum pegou: o do controller assertava
 * `objectContaining({ error })` e o da tela alimentava um objeto que o backend
 * nunca produz. Este teste roda o controller REAL e deriva o que a tela leria.
 */
describe('PromoteBlockedApplicationController — contrato com a tela', () => {
  /** Réplica mínima do que `ApiError` faz com o corpo, e do que a tela lê dele. */
  function chaveDaFraseNaTela(corpo: Record<string, unknown>): string {
    const code = corpo.code as string | undefined;
    const reason = corpo.reason as string | undefined;
    return `admin.kanban.promoteError.${reason ?? code ?? 'unknown'}`;
  }

  it.each([
    ['worker_opted_out'],
    ['vacancy_invalid'],
    ['wja_already_exists'],
    ['worker_not_eligible'],
    ['unique_conflict'],
  ])('%s chega à tela como frase PRÓPRIA, nunca como "unknown"', async (reason) => {
    const res = makeRes();
    await makeController(jest.fn().mockResolvedValue({ promoted: 0, skipped: 1, reasons: { [reason]: 1 } }))
      .promote(makeReq(BLOCKED_ID), res);

    const corpo = res.json.mock.calls[0][0] as Record<string, unknown>;
    expect(corpo.code).toBe(reason);
    expect(corpo.reason).toBe(reason);
    expect(chaveDaFraseNaTela(corpo)).toBe(`admin.kanban.promoteError.${reason}`);
    expect(chaveDaFraseNaTela(corpo)).not.toContain('unknown');
  });
});

