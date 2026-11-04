/**
 * Relógio civil — data no nome do arquivo exportado é o dia de Buenos Aires, não o dia UTC.
 * Às 23:30Z de 29/10 (20:30 BA) o nome tem 2026-10-29; o código antigo (`toISOString().slice(0,10)`) também daria 29 aqui,
 * por isso o 2º caso usa 02:30Z de 30/10 (23:30 BA): UTC já é 30, BA ainda é 29.
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
jest.mock('../../../application/ExportWorkersUseCase', () => {
  const real = jest.requireActual('../../../application/ExportWorkersUseCase');
  return { ...real, ExportWorkersUseCase: jest.fn().mockImplementation(() => ({ execute: mockExecute })) };
});

import type { Request, Response } from 'express';
import { AdminWorkersController } from '../AdminWorkersController';

async function* linhas() {
  yield 'a,b\n';
}

async function disposition(now: string): Promise<string> {
  jest.useFakeTimers({
    now: new Date(now),
    doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  mockExecute.mockResolvedValue({ format: 'csv', csvLines: linhas(), negadas: [] });
  const headers: Record<string, string> = {};
  const req = { query: { format: 'csv', columns: 'first_name' }, setTimeout: jest.fn(), permissionCells: ['worker:export'] } as unknown as Request;
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
  await new AdminWorkersController().exportWorkers(req, res);
  return headers['Content-Disposition'];
}

describe('exportWorkers — data do arquivo no dia de Buenos Aires', () => {
  afterEach(() => jest.useRealTimers());

  it('2026-10-29T23:30:00Z (20:30 BA) → workers_ALL_2026-10-29.csv', async () => {
    expect(await disposition('2026-10-29T23:30:00Z')).toContain('workers_ALL_2026-10-29.csv');
  });

  it('2026-10-30T02:30:00Z (23:30 BA) ainda é dia 29 em BA', async () => {
    expect(await disposition('2026-10-30T02:30:00Z')).toContain('workers_ALL_2026-10-29.csv');
  });
});
