/**
 * C6 — o id da trilha pode ser resolvido só no HANDLER.
 *
 * ⚠️ Por que isto existe: `GET /workers/by-phone` acha o worker PELO TELEFONE,
 * e o telefone não pode ser o identificador da trilha — ele é o próprio dado
 * pessoal, e gravá-lo publicaria em tabela auditada exatamente o que a trilha
 * existe para proteger. O UUID só existe depois que o handler roda; antes desta
 * mudança o middleware saía por `next()` no início e a rota ficava **sem trilha,
 * em silêncio** — o pior modo de falha de uma auditoria.
 */

import type { Request, Response } from 'express';
import { EventEmitter } from 'events';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logResourceAccess } from '../resourceAccessLog';

jest.mock('@shared/database/DatabaseConnection');

const query = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  query.mockResolvedValue({ rows: [], rowCount: 1 });
  (DatabaseConnection.getInstance as jest.Mock).mockReturnValue({ getPool: () => ({ query }) });
});

function makeRes(statusCode: number): Response {
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  (res as unknown as { statusCode: number }).statusCode = statusCode;
  return res as Response;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const inserts = () => query.mock.calls.filter((c) => String(c[0]).includes('resource_access_log'));

const TELEFONE = '+5491133445566';
const UUID = 'w-uuid-1';

describe('C6 — trilha de rota que resolve o recurso dentro do handler', () => {
  it('o id publicado pelo HANDLER vira a linha — o middleware roda antes e mesmo assim grava', async () => {
    const req = {
      params: {},
      query: { phone: TELEFONE },
      user: { uid: 'u-ana', roles: ['recruiter'] },
    } as unknown as Request;
    const res = makeRes(200);
    query.mockResolvedValueOnce({ rows: [{ country: 'AR' }] });

    // ordem real: middleware → handler → finish
    logResourceAccess('worker', 'read_by_phone', (r) => r.recursoAcessadoId)(req, res, jest.fn());
    req.recursoAcessadoId = UUID; // é o handler resolvendo o worker
    res.emit('finish');
    await flush();

    expect(inserts()).toHaveLength(1);
    expect(inserts()[0][1]).toEqual(['u-ana', 'recruiter', 'worker', UUID, 'read_by_phone', expect.any(String)]);
  });

  it('o TELEFONE não aparece em lugar nenhum do que foi gravado', async () => {
    const req = {
      params: {}, query: { phone: TELEFONE },
      user: { uid: 'u-ana', roles: ['recruiter'] },
    } as unknown as Request;
    const res = makeRes(200);
    query.mockResolvedValueOnce({ rows: [{ country: 'AR' }] });

    logResourceAccess('worker', 'read_by_phone', (r) => r.recursoAcessadoId)(req, res, jest.fn());
    req.recursoAcessadoId = UUID;
    res.emit('finish');
    await flush();

    // Fronteira: TUDO que foi para o banco, não só o parâmetro que eu lembrei.
    const tudo = JSON.stringify(query.mock.calls);
    expect(tudo).not.toContain(TELEFONE);
    expect(tudo).not.toContain('5491133445566');
  });

  it('handler que NÃO achou worker (404) não grava — e não grava lixo', async () => {
    const req = {
      params: {}, query: { phone: TELEFONE },
      user: { uid: 'u-ana', roles: ['recruiter'] },
    } as unknown as Request;
    const res = makeRes(404);

    logResourceAccess('worker', 'read_by_phone', (r) => r.recursoAcessadoId)(req, res, jest.fn());
    res.emit('finish');
    await flush();

    expect(inserts()).toHaveLength(0);
  });

  it('200 sem id publicado não grava linha órfã — melhor sem linha que com linha errada', async () => {
    const req = { params: {}, user: { uid: 'u-ana', roles: ['recruiter'] } } as unknown as Request;
    const res = makeRes(200);

    logResourceAccess('worker', 'read_by_phone', (r) => r.recursoAcessadoId)(req, res, jest.fn());
    res.emit('finish');
    await flush();

    expect(inserts()).toHaveLength(0);
  });

  it('quem usa `req.params.id` não mudou de comportamento — a mesma linha de antes', async () => {
    // O ponto da mudança era adiar SÓ o id. Para o chamador antigo, avaliar
    // antes ou depois dá o mesmo valor: o param não muda no meio da request.
    const req = { params: { id: 'pat-1' }, user: { uid: 'u-flor', roles: ['recruiter'] } } as unknown as Request;
    const res = makeRes(200);
    query.mockResolvedValueOnce({ rows: [{ country: 'AR' }] });

    logResourceAccess('patient')(req, res, jest.fn());
    res.emit('finish');
    await flush();

    expect(inserts()[0][1]).toEqual(['u-flor', 'recruiter', 'patient', 'pat-1', 'read_detail', expect.any(String)]);
  });
});
