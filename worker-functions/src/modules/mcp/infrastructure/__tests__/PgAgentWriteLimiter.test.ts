import type { Pool } from 'pg';
import { AGENT_WRITE_LIMIT_PER_MIN } from '../../domain/AgentCapabilityCells';
import type { AgentCallRecord } from '../../application/AgentWriteLimiter';
import { PgAgentWriteLimiter } from '../PgAgentWriteLimiter';

/**
 * Lógica do limitador contra um cliente ROTEIRIZADO (o que ele pergunta, em que ordem, o que decide). A prova com Postgres real
 * (concorrência de 2 conexões somando exatamente 10, janela de 60 s, erro de pool) é `tests/e2e/agent-limitador-078.e2e.test.ts`.
 */
function fakePool(opts: { count?: number; retryMs?: number | null; failOn?: RegExp; connectFails?: boolean } = {}) {
  const log: string[] = [];
  const inserts: unknown[][] = [];
  const client = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      log.push(s.split(' ').slice(0, 2).join(' '));
      if (opts.failOn?.test(s)) throw new Error('boom');
      if (/^SELECT count/.test(s)) return { rows: [{ n: opts.count ?? 0, retry_ms: opts.retryMs ?? 4200 }] };
      if (/^INSERT INTO iam.permission_audit_log/.test(s)) inserts.push(params ?? []);
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => { if (opts.connectFails) throw new Error('pool'); return client; }) };
  return { pool: pool as unknown as Pick<Pool, 'connect'>, log, inserts, client };
}
const escrita: AgentCallRecord = { uid: 'agent:luz', resource: 'worker', action: 'update', registroVersao: 'abc123abc123', gatilhoId: 'm1' };
const leitura: AgentCallRecord = { ...escrita, action: 'read' };

describe('PgAgentWriteLimiter (lógica; contrato §5)', () => {
  it('escrita abaixo do teto: BEGIN, trava, conta, INSERT ALLOW, COMMIT — nessa ordem', async () => {
    const f = fakePool({ count: AGENT_WRITE_LIMIT_PER_MIN - 1 });
    await expect(new PgAgentWriteLimiter(f.pool).admit(escrita)).resolves.toEqual({ ok: true });
    expect(f.log).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock(hashtext(\'agent-write:\'', 'SELECT count(*)::int', 'INSERT INTO', 'COMMIT']);
    expect(f.inserts[0][5]).toBe('ALLOW');
    expect(f.client.release).toHaveBeenCalledTimes(1);
  });

  it('11ª escrita (count == teto): recusa AGENT_RATE_LIMITED com retryAfterMs > 0 e grava 1 linha DENY (e commita)', async () => {
    const f = fakePool({ count: AGENT_WRITE_LIMIT_PER_MIN, retryMs: 4200 });
    const r = await new PgAgentWriteLimiter(f.pool).admit(escrita);
    expect(r).toEqual({ ok: false, code: 'AGENT_RATE_LIMITED', retryAfterMs: 4200 });
    expect(f.inserts).toHaveLength(1);
    expect(f.inserts[0][5]).toBe('DENY');
    expect(f.log[f.log.length - 1]).toBe('COMMIT');
  });

  it('o teto é o configurado (3): a 4ª recusa, a 3ª passa', async () => {
    const lim = (n: number) => new PgAgentWriteLimiter(fakePool({ count: n }).pool, 3).admit(escrita);
    expect((await lim(2)).ok).toBe(true);
    expect((await lim(3)).ok).toBe(false);
  });

  it('leitura (action=read) NÃO conta nem trava: só a linha ALLOW, mesmo com o teto estourado', async () => {
    const f = fakePool({ count: 999 });
    await expect(new PgAgentWriteLimiter(f.pool).admit(leitura)).resolves.toEqual({ ok: true });
    expect(f.log).toEqual(['BEGIN', 'INSERT INTO', 'COMMIT']);
  });

  it('a linha grava actor_kind=agente explícito, o uid, o gatilho e a versão do registro', async () => {
    const f = fakePool();
    await new PgAgentWriteLimiter(f.pool).admit(escrita);
    const sqlInsert = f.client.query.mock.calls.map((c) => String(c[0])).find((s) => /INSERT INTO/.test(s))!;
    expect(sqlInsert).toContain("'agente'");
    const p = f.inserts[0];
    expect([p[1], p[2], p[3], p[5], p[7], p[8]]).toEqual(['agent:luz', 'worker', 'update', 'ALLOW', 'm1', 'abc123abc123']);
  });

  it.each([
    ['o lock', /pg_advisory_xact_lock/],
    ['a contagem (passo 2)', /^SELECT count/],
    ['o INSERT', /^INSERT INTO iam/],
  ])('FAIL-CLOSED: erro em %s -> AGENT_LIMITER_UNAVAILABLE, ROLLBACK, e nenhuma linha ALLOW', async (_n, re) => {
    const f = fakePool({ failOn: re });
    const r = await new PgAgentWriteLimiter(f.pool).admit(escrita);
    expect(r).toEqual({ ok: false, code: 'AGENT_LIMITER_UNAVAILABLE' });
    expect(f.log).toContain('ROLLBACK');
    expect(f.log).not.toContain('COMMIT');
    expect(f.client.release).toHaveBeenCalledTimes(1);
  });

  it('FAIL-CLOSED: pool que não conecta -> AGENT_LIMITER_UNAVAILABLE (nada a liberar)', async () => {
    const f = fakePool({ connectFails: true });
    await expect(new PgAgentWriteLimiter(f.pool).admit(escrita)).resolves.toEqual({ ok: false, code: 'AGENT_LIMITER_UNAVAILABLE' });
    expect(f.client.release).not.toHaveBeenCalled();
  });
});
