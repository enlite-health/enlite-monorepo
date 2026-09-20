/**
 * O que estes testes travam (ABAC país Fase 1):
 *  - o client fixado VOLTA para o pool quando o cliente desliga no meio
 *    (`close` sem `finish`) — é o vazamento que esvaziaria o pool em minutos;
 *  - `finish` + `close` juntos devolvem UMA vez só;
 *  - sem store no ALS (job fora de request) o middleware é transparente;
 *  - a rota que vai para o log de request não classificada é SANITIZADA (o path
 *    cru levaria id de paciente e telefone para o Cloud Logging).
 */

import { EventEmitter } from 'events';
import type { Request, Response, NextFunction } from 'express';
import { loggingAls } from '@shared/logging';
import { dbSessionMiddleware, sanitizeRoute } from '../dbSessionMiddleware';
import * as requestDbSession from '../requestDbSession';
import { acquireSessionClient } from '../requestDbSession';

function makePool() {
  const client = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn().mockResolvedValue(client), query: jest.fn() };
  return { pool: pool as never, rawPool: pool, client };
}

function makeRes(): Response & EventEmitter {
  return new EventEmitter() as unknown as Response & EventEmitter;
}

const req = { method: 'GET', path: '/api/admin/patients' } as unknown as Request;
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('dbSessionMiddleware', () => {
  it('abre a sessão no ALS e registra método + rota sanitizada', () => {
    const res = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    loggingAls.run({ traceId: 't' }, () => {
      dbSessionMiddleware(
        { method: 'PATCH', path: '/api/admin/patients/9d1f2e3a-1111-4222-8333-444455556666/general' } as unknown as Request,
        res,
        next,
      );
      const store = loggingAls.getStore()!;
      expect(store.dbSession).toEqual({ released: false });
      expect(store.requestMethod).toBe('PATCH');
      expect(store.requestRoute).toBe('/api/admin/patients/:id/general');
    });

    expect(next).toHaveBeenCalled();
  });

  it('sem store no ALS é transparente: só chama next()', () => {
    const next = jest.fn() as unknown as NextFunction;
    expect(() => dbSessionMiddleware(req, makeRes(), next)).not.toThrow();
    expect(next).toHaveBeenCalled();
  });

  it('`close` SEM `finish` devolve o client fixado (uma vez)', async () => {
    const { pool, client } = makePool();
    const res = makeRes();

    await loggingAls.run({ traceId: 't' }, async () => {
      dbSessionMiddleware(req, res, jest.fn() as unknown as NextFunction);
      const session = loggingAls.getStore()!.dbSession!;
      await acquireSessionClient(pool, session);

      res.emit('close');
      await flush();

      expect(client.release).toHaveBeenCalledTimes(1);
      expect(session.released).toBe(true);
    });
  });

  it('`finish` e `close` juntos NÃO devolvem duas vezes', async () => {
    const { pool, client } = makePool();
    const res = makeRes();

    await loggingAls.run({ traceId: 't' }, async () => {
      dbSessionMiddleware(req, res, jest.fn() as unknown as NextFunction);
      await acquireSessionClient(pool, loggingAls.getStore()!.dbSession!);

      res.emit('finish');
      res.emit('close');
      await flush();

      expect(client.release).toHaveBeenCalledTimes(1);
    });
  });

  it('falha ao encerrar a sessão vira LOG, não exceção no fim da resposta', async () => {
    const spy = jest
      .spyOn(requestDbSession, 'releaseDbSession')
      .mockRejectedValueOnce(new Error('pool morreu'));
    const res = makeRes();

    await loggingAls.run({ traceId: 't' }, async () => {
      dbSessionMiddleware(req, res, jest.fn() as unknown as NextFunction);
      expect(() => res.emit('finish')).not.toThrow();
      await flush();
    });

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('sanitizeRoute', () => {
  it.each([
    ['/api/admin/patients/9d1f2e3a-1111-4222-8333-444455556666', '/api/admin/patients/:id'],
    ['/api/dedup/groups/+5491133334444', '/api/dedup/groups/:id'],
    ['/api/workers/12345/documents', '/api/workers/:id/documents'],
    ['/api/admin/patients', '/api/admin/patients'],
    ['/health', '/health'],
    // MEDIUM 14/08: nome legítimo de rota ≥20 chars NÃO pode colapsar —
    // era exatamente o diagnóstico que o modo relatório perdia.
    ['/api/internal/rota-ficticia-de-teste-longa', '/api/internal/rota-ficticia-de-teste-longa'],
    ['/api/internal/bulk-dispatch-incomplete-workers', '/api/internal/bulk-dispatch-incomplete-workers'],
    // Token opaco ≥20 (dígito ou case misto) segue colapsando: não vaza pro log.
    ['/api/account-link/tok_9f8e7d6c5b4a39281706', '/api/account-link/:id'],
    ['/api/account-link/eyJhbGciOiJIUzI1NiJ9abc', '/api/account-link/:id'],
  ])('%s → %s', (path, expected) => {
    expect(sanitizeRoute(path)).toBe(expected);
  });

  it('não deixa telefone nem uuid escaparem para o log', () => {
    const route = sanitizeRoute('/api/dedup/groups/5491133334444');
    expect(route).not.toContain('5491133334444');
  });
});
