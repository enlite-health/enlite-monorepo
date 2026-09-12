/**
 * AdminPatientAddressesController — PATCH da logística + principal + tipo por endereço
 * (spec 012, US-B2; spec 019, D310 item c; lex C2.3/C2.6).
 *
 *   400 params / body (teto 2000, chave estranha, enum fechado, address_type_other sem
 *     address_type="otro" — e o valor NUNCA na resposta);
 *   200: só as colunas presentes entram no SET; troca atômica de principal (demote + set na
 *     mesma transação); trilha SEM valor (booleano sai, texto/enum saem só como tamanho);
 *   404 endereço de outro paciente (ROLLBACK); 409 conflito de concorrência (unique violation);
 *   500 sem eco do corpo (ROLLBACK).
 *
 * Spec 019 muda o controller de `db.query()` direto para `db.connect()` (transação) — os testes
 * abaixo mockam um client com `query`/`release`.
 */
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn(() => Promise.resolve({ query: mockClientQuery, release: mockRelease }));
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock('@shared/database/DatabaseConnection', () => ({ DatabaseConnection: { getInstance: jest.fn(() => ({ getPool: jest.fn(() => ({ connect: mockConnect })) })) } }));
jest.mock('@modules/identity', () => ({ AuthMiddleware: { getAuthContext: jest.fn(() => ({ principal: { id: 'uid-1' } })) } }));

import { Request, Response } from 'express';
import type { Pool } from 'pg';
import { logger, reportError } from '@shared/logging';
import { AdminPatientAddressesController, updatePatientAddressSchema, ACCESS_NOTES_MAX, PATIENT_ADDRESS_TYPES } from '../AdminPatientAddressesController';

const P = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const SECRET = 'portero de 8 a 12 (valor que não sai) 4c1d';

function reqRes(params: Record<string, unknown>, body: Record<string, unknown>): [Request, Response] {
  const json = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json });
  return [{ params, body, query: {} } as unknown as Request, { json, status } as unknown as Response];
}
const bodyOf = (res: Response) => ((res as unknown as { status: jest.Mock }).status.mock.results[0].value.json as jest.Mock).mock.calls[0][0];

/** Fila padrão do client para o caminho feliz: BEGIN → (opcional demote) → UPDATE → COMMIT. */
function queueUpdate(opts: { demote?: boolean; rowCount: number }) {
  mockClientQuery.mockReset();
  mockClientQuery.mockResolvedValueOnce(undefined); // BEGIN
  if (opts.demote) mockClientQuery.mockResolvedValueOnce(undefined); // demote
  mockClientQuery.mockResolvedValueOnce({ rowCount: opts.rowCount, rows: opts.rowCount ? [{ id: A }] : [] }); // UPDATE
  mockClientQuery.mockResolvedValueOnce(undefined); // COMMIT ou ROLLBACK (chamador decide se lê)
}

describe('AdminPatientAddressesController.updatePatientAddress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnect.mockImplementation(() => Promise.resolve({ query: mockClientQuery, release: mockRelease }));
  });
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
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('400: address_type fora da lista fechada', async () => {
    const [req, res] = reqRes({ patientId: P, addressId: A }, { address_type: 'quintal_do_vizinho' });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(bodyOf(res)).toEqual({ success: false, error: 'Invalid body', details: { fields: ['address_type'] } });
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('400: address_type_other sem address_type="otro" na mesma requisição — sem ecoar o valor', async () => {
    const [req, res] = reqRes({ patientId: P, addressId: A }, { address_type_other: SECRET });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(bodyOf(res)).toEqual({ success: false, error: 'Invalid body', details: { fields: ['address_type_other'] } });
    expect(JSON.stringify(bodyOf(res))).not.toContain(SECRET);

    const [req2, res2] = reqRes({ patientId: P, addressId: A }, { address_type: 'domicilio_propio', address_type_other: SECRET });
    await ctrl.updatePatientAddress(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(400);
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it('400: address_type_other com 41 caracteres → teto do servidor', () => {
    expect(updatePatientAddressSchema.safeParse({ address_type: 'otro', address_type_other: 'x'.repeat(41) }).success).toBe(false);
    expect(updatePatientAddressSchema.safeParse({ address_type: 'otro', address_type_other: 'x'.repeat(40) }).success).toBe(true);
  });

  it('200: address_type + address_type_other="otro" juntos — aceito, sem troca de principal', async () => {
    queueUpdate({ rowCount: 1 });
    const [req, res] = reqRes({ patientId: P, addressId: A }, { address_type: 'otro', address_type_other: 'Casa de la tía' });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const updateCall = mockClientQuery.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE patient_addresses SET address_type = \$3, address_type_other = \$4, updated_at = NOW\(\)/);
    expect(updateCall[1]).toEqual([A, P, 'otro', 'Casa de la tía']);
    // Trilha SEM valor: nem o enum, nem o texto do "Otro".
    const logged = (logger.info as jest.Mock).mock.calls[0][0];
    expect(logged.fields).toEqual({ address_type: 'otro'.length, address_type_other: 'Casa de la tía'.length });
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain('Casa de la tía');
  });

  it('200: address_type = null limpa o campo ("sin especificar")', async () => {
    queueUpdate({ rowCount: 1 });
    const [req, res] = reqRes({ patientId: P, addressId: A }, { address_type: null });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const updateCall = mockClientQuery.mock.calls[1];
    expect(updateCall[1]).toEqual([A, P, null]);
  });

  it('200: is_default=true → demove o principal anterior NA MESMA TRANSAÇÃO, antes do UPDATE do próprio endereço', async () => {
    queueUpdate({ demote: true, rowCount: 1 });
    const [req, res] = reqRes({ patientId: P, addressId: A }, { is_default: true });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockClientQuery.mock.calls[0][0]).toBe('BEGIN');
    const demoteCall = mockClientQuery.mock.calls[1];
    expect(demoteCall[0]).toMatch(/UPDATE patient_addresses SET is_default = false\s+WHERE patient_id = \$1 AND is_default AND archived_at IS NULL AND id <> \$2/);
    expect(demoteCall[1]).toEqual([P, A]);
    const updateCall = mockClientQuery.mock.calls[2];
    expect(updateCall[0]).toMatch(/is_default = true/);
    expect(mockClientQuery.mock.calls[3][0]).toBe('COMMIT');
    const logged = (logger.info as jest.Mock).mock.calls[0][0];
    expect(logged.fields).toEqual({ is_default: true });
  });

  it('200: is_default=false → só desmarca o próprio (sem tocar em outros), booleano sai como valor na trilha', async () => {
    queueUpdate({ rowCount: 1 });
    const [req, res] = reqRes({ patientId: P, addressId: A }, { is_default: false });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(mockClientQuery).toHaveBeenCalledTimes(3); // BEGIN, UPDATE, COMMIT — sem demote
    const updateCall = mockClientQuery.mock.calls[1];
    expect(updateCall[0]).toMatch(/is_default = \$3/);
    expect(updateCall[1]).toEqual([A, P, false]);
  });

  it('200: só as colunas presentes entram no SET (null limpa); trilha sem valor com tamanhos', async () => {
    queueUpdate({ rowCount: 1 });
    const [req, res] = reqRes({ patientId: P, addressId: A }, { access_notes: SECRET, logistics_corridor: null });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(200);
    const updateCall = mockClientQuery.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE patient_addresses SET logistics_corridor = \$3, access_notes = \$4, updated_at = NOW\(\)/);
    expect(updateCall[0]).not.toMatch(/neighborhood/);
    expect(updateCall[1]).toEqual([A, P, null, SECRET]);
    const logged = (logger.info as jest.Mock).mock.calls[0][0];
    expect(logged).toEqual({ msg: 'patient_address.logistics_updated', uid: 'uid-1', patientId: P, addressId: A, fields: { access_notes: SECRET.length, logistics_corridor: 0 } });
    expect(JSON.stringify((logger.info as jest.Mock).mock.calls)).not.toContain(SECRET);
  });

  it('404 quando o endereço não é do paciente (0 linhas) — ROLLBACK, sem COMMIT', async () => {
    queueUpdate({ rowCount: 0 });
    const [req, res] = reqRes({ patientId: P, addressId: A }, { neighborhood: 'Centro' });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClientQuery).not.toHaveBeenCalledWith('COMMIT');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('404 quando rowCount vem ausente (undefined, driver não garante) — `?? 0` cobre o mesmo caminho', async () => {
    mockClientQuery.mockReset();
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce({ rowCount: undefined, rows: [] }) // UPDATE sem rowCount
      .mockResolvedValueOnce(undefined); // ROLLBACK
    const [req, res] = reqRes({ patientId: P, addressId: A }, { neighborhood: 'Centro' });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('500 quando o UPDATE E o ROLLBACK falham (duplo erro) — a exceção original ainda sobe, release chamado', async () => {
    mockClientQuery.mockReset();
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('update falhou')) // UPDATE
      .mockRejectedValueOnce(new Error('rollback também falhou')); // ROLLBACK
    const [req, res] = reqRes({ patientId: P, addressId: A }, { neighborhood: 'Centro' });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(reportError).toHaveBeenCalledWith(
      new Error('update falhou'),
      { source: 'AdminPatientAddressesController:updatePatientAddress', patientId: P },
    );
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('409: conflito de concorrência (unique_violation no índice parcial) — resposta tratada, não 500', async () => {
    mockClientQuery.mockReset();
    mockClientQuery
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockResolvedValueOnce(undefined) // demote
      .mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' })) // UPDATE falha
      .mockResolvedValueOnce(undefined); // ROLLBACK

    const [req, res] = reqRes({ patientId: P, addressId: A }, { is_default: true });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(bodyOf(res)).toEqual({ success: false, error: 'Concurrent update — try again' });
    expect(mockClientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('500: erro do banco → resposta genérica (sem details) e reportError sem o corpo; erro não-Error idem; sem ator → uid null', async () => {
    (require('@modules/identity').AuthMiddleware.getAuthContext as jest.Mock).mockReturnValueOnce(undefined);
    mockClientQuery.mockReset();
    mockClientQuery
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error(`violates check ${SECRET}`))
      .mockResolvedValueOnce(undefined);
    const [req, res] = reqRes({ patientId: P, addressId: A }, { access_notes: SECRET });
    await ctrl.updatePatientAddress(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(bodyOf(res)).toEqual({ success: false, error: 'Failed to update patient address' });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'AdminPatientAddressesController:updatePatientAddress', patientId: P });

    mockClientQuery.mockReset();
    mockClientQuery.mockResolvedValueOnce(undefined).mockRejectedValueOnce('string-error').mockResolvedValueOnce(undefined);
    const [req2, res2] = reqRes({ patientId: P, addressId: A }, { access_notes: SECRET });
    await ctrl.updatePatientAddress(req2, res2);
    expect(res2.status).toHaveBeenCalledWith(500);

    // trilha com uid null quando não há contexto de auth
    queueUpdate({ rowCount: 1 });
    (require('@modules/identity').AuthMiddleware.getAuthContext as jest.Mock).mockReturnValueOnce(undefined);
    const [req3, res3] = reqRes({ patientId: P, addressId: A }, { neighborhood: 'x' });
    await ctrl.updatePatientAddress(req3, res3);
    expect((logger.info as jest.Mock).mock.calls.at(-1)[0].uid).toBeNull();
  });

  it('construtor aceita pool injetado; schema exporta o teto e a lista fechada', () => {
    const pool = { connect: jest.fn() } as unknown as Pool;
    expect(new AdminPatientAddressesController(pool)).toBeInstanceOf(AdminPatientAddressesController);
    expect(updatePatientAddressSchema.safeParse({ access_notes: null }).success).toBe(true);
    expect(ACCESS_NOTES_MAX).toBe(2000);
    expect(PATIENT_ADDRESS_TYPES).toContain('escuela');
    expect(PATIENT_ADDRESS_TYPES).toHaveLength(8);
  });
});
