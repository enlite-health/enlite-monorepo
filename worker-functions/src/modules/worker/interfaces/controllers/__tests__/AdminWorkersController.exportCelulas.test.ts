/**
 * O gate da C5 na BORDA — B3 do gate `revisao-pr`.
 *
 * O gate mediu: `AdminWorkersController.ts:342-425` inteiro sem cobertura. As
 * camadas de baixo tinham teste (`ExportWorkersUseCase.celulas.test.ts`,
 * `workerExportCells.test.ts`), mas a FIAÇÃO — a célula chegando até lá, o
 * aviso de coluna negada e o 403 — estava sem rede nenhuma.
 *
 * O que este arquivo afirma é só a borda; o use case entra como dublê porque a
 * decisão dele já é medida no teste dele. O que NÃO pode ser dublê é
 * `cellsOfRequest`: é justamente ele que carrega o `null` vs `[]`, e é a
 * passagem desse valor que este arquivo existe para provar.
 */

const mockExecute = jest.fn();

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn((_: unknown, fn: () => unknown) => fn()), getStore: () => undefined },
}));
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: jest.fn() }) }) },
}));
jest.mock('@shared/security/KMSEncryptionService', () => ({ KMSEncryptionService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('@shared/security/BlindIndexService', () => ({ BlindIndexService: jest.fn().mockImplementation(() => ({})) }));
jest.mock('../../../infrastructure/GCSStorageService', () => ({ GCSStorageService: jest.fn().mockImplementation(() => ({})) }));

import type { Request, Response } from 'express';
import { AdminWorkersController } from '../AdminWorkersController';
import { ExportSemColunaPermitidaError } from '../../../application/ExportWorkersUseCase';

jest.mock('../../../application/ExportWorkersUseCase', () => {
  const real = jest.requireActual('../../../application/ExportWorkersUseCase');
  return {
    ...real,
    ExportWorkersUseCase: jest.fn().mockImplementation(() => ({ execute: mockExecute })),
  };
});

function reqRes(cells: string[] | null, columns = 'first_name,document_number') {
  const req = {
    query: { format: 'csv', columns },
    setTimeout: jest.fn(),
    permissionCells: cells,
  } as unknown as Request;
  const headers: Record<string, string> = {};
  const res = {
    setTimeout: jest.fn(),
    setHeader: jest.fn((k: string, v: string) => { headers[k] = v; }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    write: jest.fn(),
    end: jest.fn(),
    send: jest.fn(),
    headersSent: false,
  } as unknown as Response;
  return { req, res, headers };
}

async function* linhas() {
  yield 'a,b\n';
}

describe('exportWorkers — a célula na borda (C5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExecute.mockResolvedValue({ format: 'csv', csvLines: linhas(), negadas: [] });
  });

  it('🔴 as células da request descem para o use case — é a fiação inteira da C5', async () => {
    const { req, res } = reqRes(['worker:export', 'worker_pii:read']);

    await new AdminWorkersController().exportWorkers(req, res);

    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({ cells: ['worker:export', 'worker_pii:read'] }),
    );
  });

  it('🔴 `cells = null` desce como null, NUNCA como `[]`', async () => {
    // `?? []` aqui derrubaria o dossiê de todo export antes mesmo do flip: o
    // engine não decidiu, e a rota tem de devolver o que devolvia antes (D113).
    const { req, res } = reqRes(null);

    await new AdminWorkersController().exportWorkers(req, res);

    const arg = mockExecute.mock.calls[0][0];
    expect(arg.cells).toBeNull();
    expect(arg.cells).not.toEqual([]);
  });

  it('🔴 coluna negada vira HEADER — planilha faltando coluna parece cadastro incompleto', async () => {
    mockExecute.mockResolvedValue({ format: 'csv', csvLines: linhas(), negadas: ['document_number', 'race'] });
    const { req, res, headers } = reqRes([]);

    await new AdminWorkersController().exportWorkers(req, res);

    expect(headers['X-Colunas-Negadas']).toBe('document_number,race');
    expect(headers['X-Colunas-Negadas-Motivo']).toBe('worker_pii:read');
  });

  it('sem coluna negada não há header de aviso — ruído por default é ignorado depois', async () => {
    const { req, res, headers } = reqRes(['worker:export', 'worker_pii:read']);

    await new AdminWorkersController().exportWorkers(req, res);

    expect(headers['X-Colunas-Negadas']).toBeUndefined();
  });

  it('🔴 TODA coluna negada é 403 — não 500, não planilha vazia', async () => {
    // Arquivo vazio parece base vazia; 500 parece defeito nosso. O que houve foi
    // falta de célula, e a resposta tem de dizer isso.
    mockExecute.mockRejectedValue(new ExportSemColunaPermitidaError(['document_number', 'race']));
    const { req, res } = reqRes([]);

    await new AdminWorkersController().exportWorkers(req, res);

    expect((res.status as jest.Mock)).toHaveBeenCalledWith(403);
    expect((res.json as jest.Mock).mock.calls[0][0]).toMatchObject({
      success: false,
      details: { negadas: ['document_number', 'race'], exige: 'worker_pii:read' },
    });
  });

  it('erro que NÃO é de célula continua sendo 500 — o 403 não vira guarda-chuva', async () => {
    mockExecute.mockRejectedValue(new Error('conexão caiu'));
    const { req, res } = reqRes([]);

    await new AdminWorkersController().exportWorkers(req, res);

    expect((res.status as jest.Mock)).toHaveBeenCalledWith(500);
  });

  it('coluna desconhecida é 400 antes de qualquer decisão de célula', async () => {
    const { req, res } = reqRes([], 'first_name,coluna_inventada');

    await new AdminWorkersController().exportWorkers(req, res);

    expect((res.status as jest.Mock)).toHaveBeenCalledWith(400);
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
