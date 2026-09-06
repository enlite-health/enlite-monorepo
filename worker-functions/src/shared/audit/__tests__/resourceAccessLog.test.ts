/**
 * O que estes testes travam (ABAC país Fase 1, task 3.4):
 *  - UMA linha por abertura de dossiê, não por query;
 *  - só abertura bem-sucedida vira linha (404/403 não revelaram nada);
 *  - falha de auditoria não derruba a request (spec sensitive-access-log);
 *  - acesso a recurso de outro país é classificado como cross-país.
 */

import type { Request, Response } from 'express';
import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { logger, loggingAls } from '@shared/logging';
import { createRlsAwarePool } from '@shared/database/rlsAwarePool';
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

  it('D286: `action` como função da request é avaliada no `finish` — a linha carrega os containers servidos', async () => {
    const res = makeRes(200);
    query.mockResolvedValueOnce({ rows: [{ country: 'AR' }] });
    const req = { ...staffReq, permissionCells: ['patient:read', 'patient_identity:read'] } as unknown as Request;

    logResourceAccess('patient', (r) => `read_detail:${((r as unknown as { permissionCells: string[] }).permissionCells).join('+')}`)(req, res, jest.fn());
    res.emit('finish');
    await flush();

    const inserts = query.mock.calls.filter((c) => String(c[0]).includes('resource_access_log'));
    expect(inserts).toHaveLength(1);
    expect(inserts[0][1]).toEqual(['u-flor', 'recruiter', 'patient', 'pat-1', 'read_detail:patient:read+patient_identity:read', expect.any(String)]);
  });

  it('404 (paciente de outro país, sob RLS) NÃO vira linha — nada foi revelado', async () => {
    const res = makeRes(404);
    logResourceAccess('patient')(staffReq, res, jest.fn());
    res.emit('finish');
    await flush();

    expect(query.mock.calls.filter((c) => String(c[0]).includes('resource_access_log'))).toHaveLength(0);
  });

  it('papel do operador: roles[0] > role > "unknown" (a trilha nunca fica sem papel)', async () => {
    for (const [user, expected] of [
      [{ uid: 'u1', roles: ['recruiter', 'admin'] }, 'recruiter'],
      [{ uid: 'u2', role: 'community_manager' }, 'community_manager'],
      [{ uid: 'u3' }, 'unknown'],
    ] as const) {
      query.mockClear();
      const res = makeRes(200);
      logResourceAccess('worker')({ params: { id: 'w1' }, user } as unknown as Request, res, jest.fn());
      res.emit('finish');
      await flush();

      const insert = query.mock.calls.find((c) => String(c[0]).includes('resource_access_log'));
      expect(insert![1][1]).toBe(expected);
    }
  });

  it('id lido de onde a rota mandar (nem sempre é `params.id`)', async () => {
    const res = makeRes(200);
    logResourceAccess('worker', 'read_dossier', (req) => (req.params as Record<string, string>).workerId)(
      { params: { workerId: 'w-42' }, user: { uid: 'u1', roles: ['admin'] } } as unknown as Request,
      res,
      jest.fn(),
    );
    res.emit('finish');
    await flush();

    const insert = query.mock.calls.find((c) => String(c[0]).includes('resource_access_log'));
    expect(insert![1]).toEqual(['u1', 'admin', 'worker', 'w-42', 'read_dossier', expect.any(String)]);
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

  it('erro de banco ao ler o país → cross-país (sinaliza, com log próprio)', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    query.mockRejectedValueOnce(new Error('banco fora'));

    expect(await resolveAccessOrigin({ kind: 'staff', uid: 'u', country: 'AR' }, 'worker', 'w-77')).toBe(
      'group_grant',
    );

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'worker', resourceIdHash: expect.any(String) }),
      expect.stringContaining('falha ao classificar'),
    );
    warnSpy.mockRestore();
  });

  it('staff sem jurisdição atribuída é classificado como cross-país sem consultar', async () => {
    expect(await resolveAccessOrigin({ kind: 'staff', uid: 'u' }, 'patient', 'p1')).toBe('group_grant');
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

  /**
   * [lex C2] O log de falha carrega o uid do operador. Somar a ele o id do
   * paciente publicaria no Cloud Logging exatamente o vínculo
   * operador↔paciente que a trilha guarda em tabela auditada.
   */
  it('o log de falha NÃO leva o id do recurso — leva o hash', async () => {
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => undefined);
    query.mockRejectedValueOnce(new Error('append-only violado'));

    await recordResourceAccess({
      operatorUid: 'u-flor',
      operatorRole: 'admin',
      resourceType: 'patient',
      resourceId: 'paciente-secreto-123',
      action: 'read_detail',
      origin: 'system',
    });

    const payload = errorSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('paciente-secreto-123');
    expect(payload.resourceIdHash).toBe(
      createHash('sha256').update('paciente-secreto-123').digest('hex').slice(0, 12),
    );
    // O que sobra ainda permite reprocessar e correlacionar.
    expect(payload.operatorUid).toBe('u-flor');
    expect(payload.resourceType).toBe('patient');
    errorSpy.mockRestore();
  });

  it('o aviso de país indeterminado também vai com hash, não com o id', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    query.mockResolvedValueOnce({ rows: [] });

    await resolveAccessOrigin({ kind: 'staff', uid: 'u', country: 'AR' }, 'patient', 'pac-999');

    const payload = warnSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('pac-999');
    expect(payload.resourceIdHash).toEqual(expect.any(String));
    warnSpy.mockRestore();
  });
});

/**
 * A trilha faz DUAS queries (país do recurso + INSERT). Antes, cada uma abria
 * seu próprio `withSystemDbContext` — duas sessões, dois clients, dois pares de
 * `set_config` por abertura de dossiê. Agora é um ciclo só.
 */
describe('logResourceAccess — um único ciclo de contexto de sistema', () => {
  const ORIGINAL_FLAG = process.env.COUNTRY_RLS_ENABLED;
  afterEach(() => {
    if (ORIGINAL_FLAG === undefined) delete process.env.COUNTRY_RLS_ENABLED;
    else process.env.COUNTRY_RLS_ENABLED = ORIGINAL_FLAG;
  });

  it('lê o país e grava a linha na MESMA conexão de sistema', async () => {
    process.env.COUNTRY_RLS_ENABLED = 'true';
    const client = {
      query: jest.fn().mockResolvedValue({ rows: [{ country: 'AR' }], rowCount: 1 }),
      release: jest.fn(),
    };
    const rawPool = { query: jest.fn(), connect: jest.fn().mockResolvedValue(client) };
    (DatabaseConnection.getInstance as jest.Mock).mockReturnValue({
      getPool: () => createRlsAwarePool(rawPool as never),
    });

    const res = makeRes(200);
    // O middleware roda DENTRO da request (contexto de staff declarado) …
    loggingAls.run(
      { traceId: 't', dbSession: { context: { kind: 'staff', uid: 'u-flor', country: 'AR' }, released: false } },
      () => logResourceAccess('patient')(staffReq, res, jest.fn()),
    );
    // … e a gravação sai DEPOIS da resposta, fora do ALS daquela request.
    res.emit('finish');
    await flush();

    // UMA conexão para as duas queries — e ela volta pro pool no fim do ciclo.
    expect(rawPool.connect).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
    const sqls = client.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.filter((s) => s.includes('set_config'))).toHaveLength(2); // aplica + limpa
    expect(sqls.some((s) => s.includes('FROM patients'))).toBe(true);
    expect(sqls.some((s) => s.includes('resource_access_log'))).toBe(true);
  });
});
