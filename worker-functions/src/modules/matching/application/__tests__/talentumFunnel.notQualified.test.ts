/**
 * applyNotQualifiedTransition — F3: NOT_QUALIFIED não rebaixa etapa humana ACIMA de QUALIFIED. A ordem vem da
 * `funnel_stage_precedence` (SQL, fonte única; o SQL real é provado em tests/e2e/talentum-nq-nao-rebaixa-etapa-humana.test.ts);
 * aqui o fake responde a consulta de precedência com a mesma ordem da mig 477 só para exercitar a decisão.
 */
import { applyNotQualifiedTransition } from '../talentumFunnel';

const PREC: Record<string, number> = {
  INVITED: 0, PRE_SCREENING: 1, IN_PROGRESS: 2, COMPLETED: 3, IN_DOUBT: 4, QUALIFIED: 5, CONFIRMED: 6, SELECTED: 7, REJECTED: 7, QUICK_RESPONSE_TEAM: 8,
};

function fakeDb() {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('funnel_stage_precedence')) return { rows: [{ above: (PREC[String(params?.[0])] ?? -1) > PREC.QUALIFIED }] };
      return { rows: [] };
    }),
  };
}
const writes = (db: ReturnType<typeof fakeDb>) => db.calls.filter((c) => /^\s*(UPDATE|INSERT)/.test(c.sql));

describe('applyNotQualifiedTransition (F3)', () => {
  it.each(['SELECTED', 'CONFIRMED', 'QUICK_RESPONSE_TEAM'])(
    'NOT_QUALIFIED sobre %s: não escreve nada (sem UPDATE de etapa, sem encuadre RECHAZADO, sem evento auto_not_qualified)',
    async (prev) => {
      const db = fakeDb();
      expect(await applyNotQualifiedTransition(db, 'w', 'j', 'NOT_QUALIFIED', prev, 'p')).toBe(false);
      expect(writes(db)).toEqual([]);
    },
  );

  it.each(['INVITED', 'QUALIFIED', 'IN_DOUBT', 'PRE_SCREENING', null])(
    'NOT_QUALIFIED sobre %s: rebaixa como antes (encuadre RECHAZADO, WJA REJECTED, evento auto_not_qualified)',
    async (prev) => {
      const db = fakeDb();
      expect(await applyNotQualifiedTransition(db, 'w', 'j', 'NOT_QUALIFIED', prev, 'p')).toBe(true);
      const w = writes(db);
      expect(w).toHaveLength(4);
      expect(w[0].sql).toContain("resultado = 'RECHAZADO'");
      expect(w[2].sql).toContain("application_funnel_stage = 'REJECTED'");
      expect(w[3].params?.[0]).toContain('auto_not_qualified');
    },
  );

  it.each([['REJECTED'], ['SELECTED']])('veredito que não é NOT_QUALIFIED ou já REJECTED: nada (%s)', async (prev) => {
    const db = fakeDb();
    expect(await applyNotQualifiedTransition(db, 'w', 'j', prev === 'REJECTED' ? 'NOT_QUALIFIED' : 'QUALIFIED', prev)).toBe(false);
    expect(writes(db)).toEqual([]);
  });
});
