/**
 * O que estes testes travam (ABAC país Fase 1, task 3.3):
 *  - cron/webhook/MCP declaram `system` com o rótulo que vai para
 *    `app.system_context` (e daí para o `resource_access_log`);
 *  - rota pública declara `public` — classe própria, não staff sem país;
 *  - rótulo VAZIO explode na MONTAGEM da rota, não em produção: a policy da
 *    migration 271 exige contexto não-vazio, então um rótulo em branco seria
 *    zero linha em runtime, no meio do plantão.
 */

import { loggingAls } from '@shared/logging';
import { publicContextMiddleware, systemContextMiddleware } from '../systemContextMiddleware';
import { currentDbContext, type DbSession } from '../requestDbSession';

function runInRequest(fn: () => void): DbSession {
  const session: DbSession = { released: false };
  loggingAls.run({ traceId: 't', dbSession: session }, fn);
  return session;
}

describe('systemContextMiddleware', () => {
  it('declara contexto de sistema com o rótulo e segue', () => {
    const next = jest.fn();
    const session = runInRequest(() => {
      systemContextMiddleware('job:outbox')({} as never, {} as never, next);
      expect(currentDbContext()).toEqual({ kind: 'system', systemContext: 'job:outbox' });
    });

    expect(session.context).toEqual({ kind: 'system', systemContext: 'job:outbox' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('recusa rótulo vazio na montagem da rota', () => {
    expect(() => systemContextMiddleware('   ')).toThrow(/rótulo/);
    expect(() => systemContextMiddleware('')).toThrow(/rótulo/);
  });
});

describe('publicContextMiddleware', () => {
  it('declara contexto público (classe própria, não staff)', () => {
    const next = jest.fn();
    const session = runInRequest(() => {
      publicContextMiddleware('public:/leads')({} as never, {} as never, next);
    });

    expect(session.context).toEqual({ kind: 'public', systemContext: 'public:/leads' });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('recusa rótulo vazio na montagem da rota', () => {
    expect(() => publicContextMiddleware(' ')).toThrow(/rótulo/);
  });

  it('fora de request não explode (job legado chamando a mesma pilha)', () => {
    const next = jest.fn();
    expect(() => publicContextMiddleware('public:/x')({} as never, {} as never, next)).not.toThrow();
    expect(next).toHaveBeenCalled();
  });
});
