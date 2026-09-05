/**
 * AdminInsuranceProvidersController — o catálogo de coberturas sem tela (spec 012, US-B3).
 *   GET → 200 { providers }; 500 com reportError.
 *   POST → 400 (forma do código), 201, 409 (duplicado, com code), 500.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@shared/database/DatabaseConnection', () => ({ DatabaseConnection: { getInstance: jest.fn(() => ({ getPool: jest.fn(() => ({})) })) } }));

import { Request, Response } from 'express';
import { reportError } from '@shared/logging';
import { AdminInsuranceProvidersController, createInsuranceProviderSchema } from '../AdminInsuranceProvidersController';
import { InsuranceProviderExistsError, InsuranceProviderSortOrderTakenError, type InsuranceProviderRepository } from '../../../infrastructure/InsuranceProviderRepository';

function reqRes(body: Record<string, unknown> = {}): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [{ body, params: {}, query: {} } as unknown as Request, { json, status } as unknown as Response];
}

describe('AdminInsuranceProvidersController', () => {
  const repo = { listActive: jest.fn(), create: jest.fn() };
  const ctrl = new AdminInsuranceProvidersController(repo as unknown as InsuranceProviderRepository);
  beforeEach(() => jest.clearAllMocks());

  it('list: 200 com os providers; erro → 500 + reportError', async () => {
    repo.listActive.mockResolvedValueOnce([{ code: 'OSDE', sortOrder: 15 }]);
    const [req, res] = reqRes();
    await ctrl.list(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect((res as unknown as { json: jest.Mock }).json).toHaveBeenCalledWith({ success: true, data: { providers: [{ code: 'OSDE', sortOrder: 15 }] } });
    repo.listActive.mockRejectedValueOnce('boom');
    const [req2, res2] = reqRes();
    await ctrl.list(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(500);
    repo.listActive.mockRejectedValueOnce(new Error('db'));
    const [req3, res3] = reqRes();
    await ctrl.list(req3, res3);
    expect(res3.status).toHaveBeenCalledWith(500);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminInsuranceProvidersController:list' });
  });

  it('create: 400 quando o código não tem a forma do CHECK; 201 quando cria', async () => {
    const [bad, badRes] = reqRes({ code: 'swiss medical' });
    await ctrl.create(bad, badRes);
    expect(badRes.status).toHaveBeenCalledWith(400);
    expect(repo.create).not.toHaveBeenCalled();
    repo.create.mockResolvedValueOnce({ code: 'NUEVA', active: true, sortOrder: 34 });
    const [req, res] = reqRes({ code: 'NUEVA', aliases: ['Nueva OS'] });
    await ctrl.create(req, res);
    expect(repo.create).toHaveBeenCalledWith({ code: 'NUEVA', aliases: ['Nueva OS'] });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('create: duplicado → 409 com code; outro erro → 500 + reportError', async () => {
    repo.create.mockRejectedValueOnce(new InsuranceProviderExistsError('OSDE'));
    const [req, res] = reqRes({ code: 'OSDE' });
    await ctrl.create(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect((res as unknown as { json: jest.Mock }).json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSURANCE_PROVIDER_ALREADY_EXISTS', details: { code: 'OSDE' } }));
    repo.create.mockRejectedValueOnce(new Error('db'));
    const [req2, res2] = reqRes({ code: 'OSDE' });
    await ctrl.create(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(500);
    repo.create.mockRejectedValueOnce('string');
    const [req3, res3] = reqRes({ code: 'OSDE' });
    await ctrl.create(req3, res3);
    expect(res3.status).toHaveBeenCalledWith(500);
  });

  // C6: conflito na OUTRA unique da 311. Dizer "esse código já existe" para um código que não
  // existe fazia o admin desistir de cadastrar uma cobertura que o catálogo não tem.
  it('create: `sort_order` ocupado → 409 falando da POSIÇÃO, e sem citar o código como existente', async () => {
    repo.create.mockRejectedValueOnce(new InsuranceProviderSortOrderTakenError(15));
    const [req, res] = reqRes({ code: 'NOVA_OS', sortOrder: 15 });
    await ctrl.create(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    const body = (res as unknown as { json: jest.Mock }).json.mock.calls[0][0];
    expect(body).toEqual({ success: false, error: 'Insurance provider sort_order already taken', code: 'INSURANCE_PROVIDER_SORT_ORDER_TAKEN', details: { sortOrder: 15 } });
    expect(JSON.stringify(body)).not.toContain('already exists');
  });

  it('schema: aliases ≤ 20, sortOrder positivo, chave estranha recusada', () => {
    expect(createInsuranceProviderSchema.safeParse({ code: 'X1', sortOrder: 0 }).success).toBe(false);
    expect(createInsuranceProviderSchema.safeParse({ code: 'X1', aliases: Array(21).fill('a') }).success).toBe(false);
    expect(createInsuranceProviderSchema.safeParse({ code: 'X1', label: 'x' }).success).toBe(false);
    expect(createInsuranceProviderSchema.safeParse({ code: 'X1' }).success).toBe(true);
  });

  it('construtor sem repositório injetado constrói o real (pool preguiçoso — não abre conexão)', () => {
    expect(new AdminInsuranceProvidersController()).toBeInstanceOf(AdminInsuranceProvidersController);
  });
});
