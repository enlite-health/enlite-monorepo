/**
 * Guard de UX do país (task 3.5). O que ele NÃO é: segurança — isso é a policy.
 * O que ele é: a diferença entre "403, sua conta opera em AR" e uma tela de
 * zeros que o operador lê como "não há pacientes no Brasil".
 */

import type { Request, Response } from 'express';
import { loggingAls } from '@shared/logging';
import { DatabaseConnection } from '../DatabaseConnection';
import { requireCountryScope } from '../countryScopeGuard';
import type { DbSession } from '../requestDbSession';

jest.mock('../DatabaseConnection');

const query = jest.fn();
const ORIGINAL_FLAG = process.env.COUNTRY_RLS_ENABLED;

beforeEach(() => {
  jest.clearAllMocks();
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  (DatabaseConnection.getInstance as jest.Mock).mockReturnValue({ getPool: () => ({ query }) });
  process.env.COUNTRY_RLS_ENABLED = 'true';
});

afterAll(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.COUNTRY_RLS_ENABLED;
  else process.env.COUNTRY_RLS_ENABLED = ORIGINAL_FLAG;
});

function makeRes() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

async function run(country: unknown, context: DbSession['context']) {
  const req = { query: { country } } as unknown as Request;
  const res = makeRes();
  const next = jest.fn();
  const session: DbSession = { context, released: false };
  await loggingAls.run({ traceId: 't', dbSession: session }, () =>
    (requireCountryScope() as (r: Request, s: Response, n: () => void) => Promise<void>)(req, res, next),
  );
  return { res, next };
}

describe('requireCountryScope', () => {
  it('mesmo país do operador → passa', async () => {
    const { next, res } = await run('AR', { kind: 'staff', uid: 'u1', country: 'AR' });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('sem `?country=` não opina — quem recorta é a RLS', async () => {
    const { next } = await run(undefined, { kind: 'staff', uid: 'u1', country: 'AR' });
    expect(next).toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('cross-país SEM grant → 403 explicando, não tela de zeros', async () => {
    const { next, res } = await run('BR', { kind: 'staff', uid: 'u1', country: 'AR' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].detail).toContain('AR');
    expect(res.json.mock.calls[0][0].detail).toContain('BR');
  });

  it('cross-país COM grant vivo → passa', async () => {
    query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 });
    const { next, res } = await run('BR', { kind: 'staff', uid: 'u1', country: 'AR' });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('staff sem jurisdição atribuída → 403 que aponta o conserto', async () => {
    const { res } = await run('AR', { kind: 'staff', uid: 'u1' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json.mock.calls[0][0].detail).toContain('jurisdição');
  });

  it('país inválido → 400, não 403', async () => {
    const { res } = await run('US', { kind: 'staff', uid: 'u1', country: 'AR' });
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('contexto de sistema não tem jurisdição própria → passa', async () => {
    const { next } = await run('BR', { kind: 'system', systemContext: 'job:x' });
    expect(next).toHaveBeenCalled();
  });

  it('falha ao checar o grant NÃO vira acesso (403 honesto)', async () => {
    query.mockRejectedValueOnce(new Error('banco fora'));
    const { next, res } = await run('BR', { kind: 'staff', uid: 'u1', country: 'AR' });
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('com a flag desligada é inerte (prod neutro até a virada)', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'false';
    const { next, res } = await run('BR', { kind: 'staff', uid: 'u1', country: 'AR' });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });
});
