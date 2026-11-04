import type { Pool } from 'pg';
import { parseMode, run } from '../talentum-repontar-vaga-dona';

describe('talentum-repontar-vaga-dona', () => {
  it('exige exatamente um de --dry-run/--apply', () => {
    expect(parseMode(['--dry-run'])).toBe('dry-run');
    expect(parseMode(['--apply'])).toBe('apply');
    expect(() => parseMode([])).toThrow(/exatamente um/);
    expect(() => parseMode(['--apply', '--dry-run'])).toThrow(/exatamente um/);
  });

  /** Pool fake: devolve as linhas pendentes e registra o que a transação da linha executou. */
  function fakePool(status: string) {
    const executed: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        executed.push({ sql: sql.trim().split(/\s+/).slice(0, 3).join(' '), params });
        return { rows: [], rowCount: sql.includes('INSERT INTO worker_job_applications') ? 1 : 0 };
      },
      release: () => undefined,
    };
    const pool = {
      query: async () => ({ rows: [{ id: 'tp-1', worker_id: 'w-1', stored: 'jp-old', owner: 'jp-owner', status }] }),
      connect: async () => client,
    } as unknown as Pool;
    return { pool, executed };
  }

  const wjaStage = (executed: Array<{ sql: string; params?: unknown[] }>) =>
    executed.find((e) => e.sql.startsWith('INSERT INTO worker_job_applications'))?.params?.[2];

  it('(2) ANALYZED cru (sem statusLabel) NÃO grava WJA — gravar "ANALYZED" violaria o CHECK', async () => {
    const { pool, executed } = fakePool('ANALYZED');
    const r = await run(pool, 'apply', () => undefined);
    expect(r.repointed).toBe(1);
    expect(r.wjaInserted).toBe(0);
    expect(executed.some((e) => e.sql.startsWith('INSERT INTO worker_job_applications'))).toBe(false);
  });

  it('mapeia como o webhook: INITIATED→PRE_SCREENING, QUALIFIED igual, PENDING nada', async () => {
    for (const [status, expected] of [['INITIATED', 'PRE_SCREENING'], ['QUALIFIED', 'QUALIFIED'], ['IN_DOUBT', 'IN_DOUBT']] as const) {
      const { pool, executed } = fakePool(status);
      await run(pool, 'apply', () => undefined);
      expect(wjaStage(executed)).toBe(expected);
    }
    const { pool, executed } = fakePool('PENDING');
    await run(pool, 'apply', () => undefined);
    expect(wjaStage(executed)).toBeUndefined();
  });

  it('(3) NOT_QUALIFIED: WJA REJECTED + a transição do webhook (encuadre RECHAZADO + eventos audit-only) na MESMA transação', async () => {
    const { pool, executed } = fakePool('NOT_QUALIFIED');
    await run(pool, 'apply', () => undefined);

    expect(wjaStage(executed)).toBe('REJECTED');
    const heads = executed.map((e) => e.sql);
    expect(heads).toContain('UPDATE encuadres SET');
    expect(heads.filter((h) => h.startsWith('INSERT INTO domain_events'))).toHaveLength(2);
    expect(heads[0]).toBe('BEGIN');
    expect(heads[heads.length - 1]).toBe('COMMIT');
    const mid = heads.indexOf('UPDATE encuadres SET');
    expect(mid).toBeGreaterThan(heads.indexOf('BEGIN'));
    expect(mid).toBeLessThan(heads.indexOf('COMMIT'));
  });

  it('dry-run dá ROLLBACK e não confirma nada', async () => {
    const { pool, executed } = fakePool('NOT_QUALIFIED');
    await run(pool, 'dry-run', () => undefined);
    expect(executed.map((e) => e.sql)).toContain('ROLLBACK');
    expect(executed.map((e) => e.sql)).not.toContain('COMMIT');
  });
});
