/**
 * O que estes testes travam (ABAC país Fase 1, task 3.4):
 *  - UMA linha por abertura de dossiê, não por query;
 *  - só abertura bem-sucedida vira linha (404/403 não revelaram nada);
 *  - falha de auditoria não derruba a request (spec sensitive-access-log);
 *  - acesso a recurso de outro país é classificado como cross-país.
 */

import type { Request, Response } from 'express';
import { EventEmitter } from 'events';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  logResourceAccess,
  recordResourceAccess,
  resolveAccessOrigin,
} from '../resourceAccessLog';

jest.mock('@shared/database/DatabaseConnection');

const query = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  query.mockResolvedValue({ rows: [], rowCount: 1 });
  (DatabaseConnection.getInstance as jest.Mock).mockReturnValue({ getPool: () => ({ query }) });
});

/** `res` mínimo que sabe emitir `finish` — o gancho da trilha. */
function makeRes(statusCode: number): Response {
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  (res as unknown as { statusCode: number }).statusCode = statusCode;
  return res as Response;
}

const staffReq = {
  params: { id: 'pat-1' },
  user: { uid: 'u-flor', roles: ['recruiter'] },
} as unknown as Request;

/** Deixa a gravação assíncrona (disparada no `finish`) terminar. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('logResourceAccess', () => {
  it('abertura bem-sucedida grava UMA linha, com operador, recurso e ação', async () => {
    const res = makeRes(200);
    const next = jest.fn();
    query.mockResolvedValueOnce({ rows: [{ country: 'AR' }] }); // país do recurso

    logResourceAccess('patient')(staffReq, res, next);
    expect(next).toHaveBeenCalled();
    res.emit('finish');
    await flush();

    const inserts = query.mock.calls.filter((c) => String(c[0]).includes('resource_access_log'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toEqual(['u-flor', 'recruiter', 'patient', 'pat-1', 'read_detail', expect.any(String)]);
  });

  it('404 (paciente de outro país, sob RLS) NÃO vira linha — nada foi revelado', async () => {
    const res = makeRes(404);
    logResourceAccess('patient')(staffReq, res, jest.fn());
    res.emit('finish');
    await flush();

    expect(query.mock.calls.filter((c) => String(c[0]).includes('resource_access_log'))).toHaveLength(0);
  });

  it('sem operador identificado não afirma nada na trilha', async () => {
    const res = makeRes(200);
    const next = jest.fn();
    logResourceAccess('patient')({ params: { id: 'p1' } } as unknown as Request, res, next);
    res.emit('finish');
    await flush();

    expect(next).toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('falha da trilha não derruba a request', async () => {
    const res = makeRes(200);
    query.mockRejectedValue(new Error('banco fora'));

    expect(() => {
      logResourceAccess('worker')(staffReq, res, jest.fn());
      res.emit('finish');
    }).not.toThrow();
    await flush();
  });
});

describe('resolveAccessOrigin', () => {
  it('mesmo país → same_country', async () => {
    query.mockResolvedValueOnce({ rows: [{ country: 'AR' }] });
    expect(await resolveAccessOrigin({ kind: 'staff', uid: 'u', country: 'AR' }, 'patient', 'p1')).toBe(
      'same_country',
    );
  });

  it('país diferente → group_grant (só se chega lá por grant vivo)', async () => {
    query.mockResolvedValueOnce({ rows: [{ country: 'BR' }] });
    expect(await resolveAccessOrigin({ kind: 'staff', uid: 'u', country: 'AR' }, 'patient', 'p1')).toBe(
      'group_grant',
    );
  });

  it('cron/webhook/capability → system, sem consultar nada', async () => {
    expect(await resolveAccessOrigin({ kind: 'system', systemContext: 'job:x' }, 'worker', 'w1')).toBe('system');
    expect(query).not.toHaveBeenCalled();
  });

  it('país do recurso indeterminado → cross-país (erra sinalizando, não calando)', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    expect(await resolveAccessOrigin({ kind: 'staff', uid: 'u', country: 'AR' }, 'patient', 'sumiu')).toBe(
      'group_grant',
    );
  });
});

describe('recordResourceAccess', () => {
  it('engole o erro de gravação e loga (fail-safe)', async () => {
    query.mockRejectedValueOnce(new Error('append-only violado'));
    await expect(
      recordResourceAccess({
        operatorUid: 'u',
        operatorRole: 'admin',
        resourceType: 'worker',
        resourceId: 'w1',
        action: 'read_detail',
        origin: 'system',
      }),
    ).resolves.toBeUndefined();
  });
});
