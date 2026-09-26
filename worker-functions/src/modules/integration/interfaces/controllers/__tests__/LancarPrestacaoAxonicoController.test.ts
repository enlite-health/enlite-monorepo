/**
 * LancarPrestacaoAxonicoController.test.ts
 *
 * Cobre:
 *   1. handle: body inválido (Zod) → 400 com `details`, use case NUNCA chamado
 *   2. handle: caminho feliz → 200 `{ success: true, data: <enviado> }`
 *   3. handle: `duplicado` (comprovante original e dedupe remoto com nulos) → 200
 *   4. handle: erro → httpStatus por `mapError`
 *   5. handleLote: body inválido → 400
 *   6. handleLote: laço misto (ok + duplicado + erro) — item que lança não aborta os seguintes
 *   7. mapError: um caso por ramo (10 nomeados + fallback UnknownError, incluindo not-Error)
 *
 * CORREÇÃO (19/09/2026, decisão do Gabriel): o corpo não recebe mais `patientId` — o lançamento é
 * feito pelo `documentNumber` que já vem pronto do Ana Care. `documentNumber` é obrigatório;
 * `patientId` (se vier) é ignorado pelo Zod (schema não-`strict`), nunca usado.
 */

// ── Imports ───────────────────────────────────────────────────────

// Mock do logger — mesmo padrão de LancarPrestacaoAxonicoUseCase.test.ts/AxonicoApiClient.test.ts.
// Usado pela suíte de observabilidade (auditoria D384, 20/09/2026): prova que o boundary HTTP loga
// o veredito da requisição (nível coerente com a severidade real, não só o status HTTP).
jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { logger: mockLogger } = require('@shared/logging') as {
  logger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock };
};

import type { Request, Response } from 'express';
import { LancarPrestacaoAxonicoController } from '../LancarPrestacaoAxonicoController';
import {
  PacienteSemDniError,
  HoraQuebradaError,
  AxonicoTetoIndisponivelError,
  AxonicoTetoExcedidoError,
  AxonicoPacienteNaoEncontradoError,
  AxonicoLancamentoConcorrenteError,
  type LancarPrestacaoAxonicoResult,
} from '../../../application/LancarPrestacaoAxonicoUseCase';
import type { AxonicoLancamentoRecord } from '../../../domain/IAxonicoLancamentoRepository';
import { AxonicoUnmappedServiceTypeError } from '../../../infrastructure/AxonicoServiceMapping';
import {
  AxonicoValidationError,
  AxonicoBusinessError,
  AxonicoAuthError,
  AxonicoIndeterminateWriteError,
} from '../../../infrastructure/AxonicoErrors';

// ── Helpers ───────────────────────────────────────────────────────

interface FakeRes {
  res: Response;
  status: jest.Mock;
  json: jest.Mock;
}

function makeRes(): FakeRes {
  const json = jest.fn();
  const status = jest.fn().mockImplementation(() => ({ json }));
  return { res: { status, json } as unknown as Response, status, json };
}

const SENT_BY_UID = 'uid-axonico-controller-test';

// `authContext` default = AUTENTICADO (uid = SENT_BY_UID) — mesmo padrão de
// `AnaCareHoursController.test.ts` (`authContext: { principal: { id: 'uid-9' } }`). Passar `null`
// explicitamente simula a sessão SEM uid (guard 401 novo, 24/09/2026) — não `undefined`: um
// parâmetro default do JS dispara para `undefined` mesmo passado explicitamente, então `null` é o
// único jeito de o chamador pedir "sem authContext" e realmente conseguir.
function makeReq(body: unknown, authContext: { principal: { id: string } } | null = { principal: { id: SENT_BY_UID } }): Request {
  return { body, authContext: authContext ?? undefined } as unknown as Request;
}

const VALID_BODY = {
  documentNumber: '30111222',
  serviceType: 'AT' as const,
  serviceDate: '2026-09-18',
  hours: 4,
};

function makeController(mockExecute: jest.Mock): LancarPrestacaoAxonicoController {
  return new LancarPrestacaoAxonicoController(async () => ({ execute: mockExecute } as never));
}

// ── handle ────────────────────────────────────────────────────────

describe('LancarPrestacaoAxonicoController.handle', () => {
  it.each([
    ['hours fracionário', { ...VALID_BODY, hours: 1.5 }],
    ['hours <= 0', { ...VALID_BODY, hours: 0 }],
    ["serviceDate fora de 'YYYY-MM-DD'", { ...VALID_BODY, serviceDate: '18/09/2026' }],
    ['documentNumber ausente', { serviceType: 'AT', serviceDate: '2026-09-18', hours: 4 }],
    ['documentNumber vazio', { ...VALID_BODY, documentNumber: '' }],
    ['serviceType inválido', { ...VALID_BODY, serviceType: 'MEDICO' }],
  ])('corpo inválido (%s) → 400 com details, use case não chamado', async (_label, body) => {
    const mockExecute = jest.fn();
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(body), res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Invalid request body', details: expect.anything() }),
    );
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('corpo COM patientId e SEM documentNumber → 400, use case não chamado (o campo antigo não funciona mais sozinho) — e loga warn só com os NOMES dos campos inválidos, nunca o corpo', async () => {
    mockLogger.warn.mockClear();
    const mockExecute = jest.fn();
    const { res, status, json } = makeRes();
    const bodyComPatientIdAntigo = {
      patientId: '11111111-1111-1111-1111-111111111111',
      serviceType: 'AT',
      serviceDate: '2026-09-18',
      hours: 4,
    };

    await makeController(mockExecute).handle(makeReq(bodyComPatientIdAntigo), res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Invalid request body' }),
    );
    expect(mockExecute).not.toHaveBeenCalled();

    // Teste que morre (item 5): corpo inválido loga warn com os campos que falharam — nunca o
    // corpo (que poderia carregar um documentNumber malformado, ainda assim PII).
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ invalidFields: expect.arrayContaining(['documentNumber']) }),
    );
    const [loggedArg] = mockLogger.warn.mock.calls[0];
    expect(JSON.stringify(loggedArg)).not.toContain('11111111-1111-1111-1111-111111111111');
  });

  it('corpo COM patientId E documentNumber → aceito, patientId é ignorado (não chega ao use case)', async () => {
    const result: LancarPrestacaoAxonicoResult = {
      status: 'enviado',
      numeroComprobante: 'C-1',
      codAutorizacion: 'A-1',
    };
    const mockExecute = jest.fn().mockResolvedValue(result);
    const { res, status, json } = makeRes();
    const bodyComPatientIdSobrando = { ...VALID_BODY, patientId: '11111111-1111-1111-1111-111111111111' };

    await makeController(mockExecute).handle(makeReq(bodyComPatientIdSobrando), res);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true, data: result });
    // O schema não é `strict` — `patientId` é descartado, nunca repassado ao use case.
    expect(mockExecute).toHaveBeenCalledWith({ ...VALID_BODY, sentBy: SENT_BY_UID });
  });

  it('body ausente (undefined) → tratado como {} (branch req.body ?? {}), 400, use case não chamado', async () => {
    const mockExecute = jest.fn();
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(undefined), res);

    expect(status).toHaveBeenCalledWith(400);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('caminho feliz → 200 { success: true, data: <enviado> }', async () => {
    const result: LancarPrestacaoAxonicoResult = {
      status: 'enviado',
      numeroComprobante: 'C-1',
      codAutorizacion: 'A-1',
    };
    const mockExecute = jest.fn().mockResolvedValue(result);
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(VALID_BODY), res);

    expect(mockExecute).toHaveBeenCalledWith({ ...VALID_BODY, sentBy: SENT_BY_UID });
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true, data: result });
  });

  it('duplicado com comprovante ORIGINAL → 200 carregando os campos', async () => {
    const lancadoEm = new Date('2026-09-01T00:00:00.000Z');
    const result: LancarPrestacaoAxonicoResult = {
      status: 'duplicado',
      jaFaturado: true,
      numeroComprobante: 'C-ORIG',
      codAutorizacion: 'A-ORIG',
      lancadoEm,
    };
    const mockExecute = jest.fn().mockResolvedValue(result);
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(VALID_BODY), res);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true, data: result });
  });

  it('duplicado por dedupe REMOTO (numeroComprobante/codAutorizacion nulos) → 200 carregando os campos', async () => {
    const lancadoEm = new Date('2026-09-01T00:00:00.000Z');
    const result: LancarPrestacaoAxonicoResult = {
      status: 'duplicado',
      jaFaturado: true,
      numeroComprobante: null,
      codAutorizacion: null,
      lancadoEm,
    };
    const mockExecute = jest.fn().mockResolvedValue(result);
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(VALID_BODY), res);

    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({ success: true, data: result });
  });

  it('erro do use case → httpStatus traduzido por mapError — e loga warn (4xx comum) com errorType+httpStatus', async () => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    const mockExecute = jest.fn().mockRejectedValue(new AxonicoPacienteNaoEncontradoError());
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(VALID_BODY), res);

    expect(status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'AxonicoPacienteNaoEncontradoError' }),
    );

    // 404 é 4xx comum (não concorrente/indeterminado) — nível warn, não error.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: 'AxonicoPacienteNaoEncontradoError', httpStatus: 404 }),
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it('erro >=500 do use case (ex.: AxonicoBusinessError, 502) → loga ERROR, não warn', async () => {
    mockLogger.warn.mockClear();
    mockLogger.error.mockClear();
    const mockExecute = jest.fn().mockRejectedValue(new AxonicoBusinessError('PUT', '/api/comprobante', 500, 'falha no Axonico'));
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(VALID_BODY), res);

    expect(status).toHaveBeenCalledWith(502);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: 'AxonicoBusinessError', httpStatus: 502 }),
    );
  });

  it('item 1.3 — AxonicoLancamentoConcorrenteError (23505) → 409 com OS DOIS comprovantes em data', async () => {
    const lancadoEm = new Date('2026-09-18T12:00:00.000Z');
    const existente: AxonicoLancamentoRecord = {
      id: 'lanc-winner',
      patientId: null,
      documentNumber: '30111222',
      serviceType: 'AT',
      serviceDate: VALID_BODY.serviceDate,
      hours: VALID_BODY.hours,
      numeroComprobante: 'CMP-EXISTENTE',
      codAutorizacion: 'AUT-EXISTENTE',
      status: 'enviado',
      errorMessage: null,
      sentBy: SENT_BY_UID,
      createdAt: lancadoEm,
    };
    const conflictError = new AxonicoLancamentoConcorrenteError(
      '30111222',
      existente,
      { numeroComprobante: 'CMP-RECEM-FATURADO', codAutorizacion: 'AUT-RECEM-FATURADO' },
    );
    const mockExecute = jest.fn().mockRejectedValue(conflictError);
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(VALID_BODY), res);

    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: 'AxonicoLancamentoConcorrenteError',
      message: expect.any(String),
      data: {
        comprovanteExistente: {
          numeroComprobante: 'CMP-EXISTENTE',
          codAutorizacion: 'AUT-EXISTENTE',
          lancadoEm,
        },
        comprovanteRecemFaturado: { numeroComprobante: 'CMP-RECEM-FATURADO', codAutorizacion: 'AUT-RECEM-FATURADO' },
      },
    });

    // Teste que morre (item 5): 409 é 4xx, mas concorrência de faturamento EXIGE ação humana —
    // tem que logar em `error`, nunca `warn` (nível coerente com a gravidade real, não o HTTP cru).
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ errorType: 'AxonicoLancamentoConcorrenteError', httpStatus: 409 }),
    );
  });

  // change `axonico-envio-rastreavel` (24/09/2026): quem disparou o envio passa a ser gravado
  // (`sentBy`) — sem uid na sessão, a requisição é recusada ANTES de validar o corpo ou chamar o
  // use case (um lançamento que fatura de verdade não pode ficar sem autor).
  it('sem authContext (uid ausente na sessão) → 401, use case NUNCA chamado, corpo nem chega a ser validado', async () => {
    const mockExecute = jest.fn();
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(VALID_BODY, null), res);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ── handleLote ────────────────────────────────────────────────────

describe('LancarPrestacaoAxonicoController.handleLote', () => {
  it('sem authContext (uid ausente na sessão) → 401, use case NUNCA chamado, corpo nem chega a ser validado', async () => {
    const mockExecute = jest.fn();
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handleLote(makeReq({ itens: [VALID_BODY] }, null), res);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('body ausente (undefined) → tratado como {} (branch req.body ?? {}), 400', async () => {
    const mockExecute = jest.fn();
    const { res, status } = makeRes();

    await makeController(mockExecute).handleLote(makeReq(undefined), res);

    expect(status).toHaveBeenCalledWith(400);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('corpo não-array → 400', async () => {
    const mockExecute = jest.fn();
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handleLote(makeReq({ itens: 'nao-array' }), res);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false, error: 'Invalid request body' }));
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('array vazio → 400', async () => {
    const mockExecute = jest.fn();
    const { res, status } = makeRes();

    await makeController(mockExecute).handleLote(makeReq({ itens: [] }), res);

    expect(status).toHaveBeenCalledWith(400);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('mais de 500 itens → 400', async () => {
    const mockExecute = jest.fn();
    const { res, status } = makeRes();
    const itens = Array.from({ length: 501 }, () => VALID_BODY);

    await makeController(mockExecute).handleLote(makeReq({ itens }), res);

    expect(status).toHaveBeenCalledWith(400);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('laço misto: ok + duplicado + erro — item que lança não aborta os seguintes', async () => {
    const okResult: LancarPrestacaoAxonicoResult = {
      status: 'enviado',
      numeroComprobante: 'C-OK',
      codAutorizacion: 'A-OK',
    };
    const dupResult: LancarPrestacaoAxonicoResult = {
      status: 'duplicado',
      jaFaturado: true,
      numeroComprobante: 'C-DUP',
      codAutorizacion: 'A-DUP',
      lancadoEm: new Date('2026-09-01T00:00:00.000Z'),
    };

    const mockExecute = jest
      .fn()
      .mockResolvedValueOnce(okResult)
      .mockRejectedValueOnce(new HoraQuebradaError(1.5))
      .mockResolvedValueOnce(dupResult);

    const { res, status, json } = makeRes();

    await makeController(mockExecute).handleLote(makeReq({ itens: [VALID_BODY, VALID_BODY, VALID_BODY] }), res);

    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(status).toHaveBeenCalledWith(200);
    expect(json).toHaveBeenCalledWith({
      success: true,
      data: {
        summary: { total: 3, ok: 1, duplicado: 1, erro: 1 },
        resultados: [
          { index: 0, status: 'ok', numeroComprobante: 'C-OK', codAutorizacion: 'A-OK' },
          { index: 1, status: 'erro', errorType: 'HoraQuebradaError', message: expect.any(String) },
          {
            index: 2,
            status: 'duplicado',
            jaFaturado: true,
            numeroComprobante: 'C-DUP',
            codAutorizacion: 'A-DUP',
            lancadoEm: dupResult.status === 'duplicado' ? dupResult.lancadoEm : undefined,
          },
        ],
      },
    });
  });
});

// ── mapError (via handle, um caso por ramo) ─────────────────────────

describe('LancarPrestacaoAxonicoController — mapError (por handle)', () => {
  it.each<[string, unknown, number]>([
    ['HoraQuebradaError', new HoraQuebradaError(1.5), 400],
    ['PacienteSemDniError', new PacienteSemDniError('no_document'), 422],
    [
      'AxonicoUnmappedServiceTypeError',
      new AxonicoUnmappedServiceTypeError(VALID_BODY.serviceType as never),
      422,
    ],
    ['AxonicoTetoExcedidoError', new AxonicoTetoExcedidoError(10, 5), 422],
    ['AxonicoTetoIndisponivelError', new AxonicoTetoIndisponivelError(4, 'timeout'), 502],
    ['AxonicoPacienteNaoEncontradoError', new AxonicoPacienteNaoEncontradoError(), 404],
    [
      'AxonicoLancamentoConcorrenteError',
      new AxonicoLancamentoConcorrenteError(
        '30111222',
        {
          id: 'lanc-winner',
          patientId: null,
          documentNumber: '30111222',
          serviceType: 'AT',
          serviceDate: VALID_BODY.serviceDate,
          hours: VALID_BODY.hours,
          numeroComprobante: 'CMP-X',
          codAutorizacion: 'AUT-X',
          status: 'enviado',
          errorMessage: null,
          sentBy: SENT_BY_UID,
          createdAt: new Date('2026-09-18T00:00:00.000Z'),
        },
        { numeroComprobante: 'CMP-Y', codAutorizacion: 'AUT-Y' },
      ),
      409,
    ],
    ['AxonicoIndeterminateWriteError', new AxonicoIndeterminateWriteError('POST', '/comprobante'), 409],
    ['AxonicoValidationError', new AxonicoValidationError('POST', '/comprobante', { hours: ['bad'] }), 422],
    ['AxonicoAuthError', new AxonicoAuthError('POST', '/comprobante'), 502],
    ['AxonicoBusinessError', new AxonicoBusinessError('POST', '/comprobante', 500, 'boom'), 502],
    ['Error genérico → UnknownError', new Error('algo inesperado'), 500],
  ])('%s → httpStatus %i', async (errorType, error, expectedStatus) => {
    const mockExecute = jest.fn().mockRejectedValue(error);
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(VALID_BODY), res);

    expect(status).toHaveBeenCalledWith(expectedStatus);
    const expectedErrorType = error instanceof Error && error.name !== 'Error' ? error.name : 'UnknownError';
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expectedErrorType }),
    );
    void errorType;
  });

  it('erro NÃO-Error (string lançada) → UnknownError, httpStatus 500', async () => {
    const mockExecute = jest.fn().mockRejectedValue('boom-nao-error');
    const { res, status, json } = makeRes();

    await makeController(mockExecute).handle(makeReq(VALID_BODY), res);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'UnknownError', message: 'boom-nao-error' }),
    );
  });
});
