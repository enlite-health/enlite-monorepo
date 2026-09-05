/**
 * AdminPatientAddressesController — PATCH da logística por endereço (spec 012, US-B2; lex C2.3/C2.6).
 *   400 params / body (teto 2000, chave estranha, nada a atualizar — e o valor NUNCA na resposta);
 *   404 endereço de outro paciente; 200 com só as colunas presentes; 500 sem eco do corpo;
 *   trilha SEM valor: uid, ids e TAMANHO por campo.
 */
const mockQuery = jest.fn();
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@shared/database/DatabaseConnection', () => ({ DatabaseConnection: { getInstance: jest.fn(() => ({ getPool: jest.fn(() => ({ query: mockQuery })) })) } }));
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn(() => ({ principal: { id: 'uid-1' } })) } }));

import { Request, Response } from 'express';
import type { Pool } from 'pg';
import { logger, reportError } from '@shared/logging';
import { AdminPatientAddressesController, updatePatientAddressSchema, ACCESS_NOTES_MAX } from '../AdminPatientAddressesController';

const P = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const SECRET = 'portero de 8 a 12 (valor que não sai) 4c1d';

function reqRes(params: Record<string, unknown>, body: Record<string, unknown>): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [{ params, body, query: {} } as unknown as Request, { json, status } as unknown as Response];
}
const bodyOf = (res: Response) => ((res as unknown as { status: jest.Mock }).status.mock.results[0].value.json as jest.Mock).mock.calls[0][0];

describe('AdminPatientAddressesController.updatePatientAddress', () => {
  beforeEach(() => jest.clearAllMocks());
  const ctrl = new AdminPatientAddressesController();

  it('400: params inválidos; body com chave estranha; teto 2000 — sem ecoar o valor; nada a atualizar', async () => {
    const [r1, s1] = reqRes({ patientId: 'x', addressId: A }, {});
    await ctrl.updatePatientAddress(r1, s1);
    expect(s1.status).toHaveBeenCalledWith(400);
    const [r2, s2] = reqRes({ patientId: P, addressId: A }, { address_formatted: 'hack' });
    await ctrl.updatePatientAddress(r2, s2);
    expect(s2.status).toHaveBeenCalledWith(400);
    const [r3, s3] = reqRes({ patientId: P, addressId: A }, { access_notes: 'n'.repeat(ACCESS_NOTES_MAX + 1) + SECRET });
    await ctrl.updatePatientAddress(r3, s3);
    expect(s3.status).toHaveBeenCalledWith(400);
    expect(JSON.stringify(bodyOf(s3))).not.toContain(SECRET);
    expect(bodyOf(s3)).toEqual({ success: false, error: 'Invalid body', details: { fields: ['access_notes'] } });
    const [r4, s4] = reqRes({ patientId: P, addressId: A }, {});
    await ctrl.updatePatientAddress(r4, s4);
    expect(s4.status).toHaveBeenCalledWith(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('200: só as colunas presentes entram no SET (null limpa); trilha sem valor com tamanhos', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: A }] });
    const [req, res] = reqRes({ patientId: P, addressId: A }, { access_notes: SECRET, logistics_corridor: null });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE patient_addresses SET logistics_corridor = \$3, access_notes = \$4, updated_at = NOW\(\)/);
    expect(sql).not.toMatch(/neighborhood/);
    expect(params).toEqual([A, P, null, SECRET]);
    const logged = (logger.info as jest.Mock).mock.calls[0][0];
    expect(logged).toEqual({ msg: 'patient_address.logistics_updated', uid: 'uid-1', patientId: P, addressId: A, fields: { access_notes: SECRET.length, logistics_corridor: 0 } });
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain(SECRET);
  });

  it('404 quando o endereço não é do paciente (0 linhas); rowCount ausente também é 404', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const [req, res] = reqRes({ patientId: P, addressId: A }, { neighborhood: 'Centro' });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const [req2, res2] = reqRes({ patientId: P, addressId: A }, { neighborhood: 'Centro' });
    await ctrl.updatePatientAddress(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(404);
  });

  it('500: erro do banco → resposta genérica (sem details) e reportError sem o corpo; erro não-Error idem; sem ator → uid null', async () => {
    (require('@modules/identity').AuthMiddleware.getAuthContext as jest.Mock).mockReturnValueOnce(undefined);
    mockQuery.mockRejectedValueOnce(new Error(`violates check ${SECRET}`));
    const [req, res] = reqRes({ patientId: P, addressId: A }, { access_notes: SECRET });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(bodyOf(res)).toEqual({ success: false, error: 'Failed to update patient address' });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminPatientAddressesController:updatePatientAddress', patientId: P });
    mockQuery.mockRejectedValueOnce('string-error');
    const [req2, res2] = reqRes({ patientId: P, addressId: A }, { access_notes: SECRET });
    await ctrl.updatePatientAddress(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(500);
    // trilha com uid null quando não há contexto de auth
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: A }] });
    (require('@modules/identity').AuthMiddleware.getAuthContext as jest.Mock).mockReturnValueOnce(undefined);
    const [req3, res3] = reqRes({ patientId: P, addressId: A }, { neighborhood: 'x' });
    await ctrl.updatePatientAddress(req3, res3);
    expect((logger.info as jest.Mock).mock.calls.at(-1)[0].uid).toBeNull();
  });

  it('construtor aceita pool injetado; schema exporta o teto', () => {
    const pool = { query: jest.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: A }] }) } as unknown as Pool;
    expect(new AdminPatientAddressesController(pool)).toBeInstanceOf(AdminPatientAddressesController);
    expect(updatePatientAddressSchema.safeParse({ access_notes: null }).success).toBe(true);
    expect(ACCESS_NOTES_MAX).toBe(2000);
  });
});
