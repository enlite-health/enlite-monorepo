/**
 * applyExpiredTransition — expiração (D626, spec 095 §3.4). Mesma guarda de etapa de `applyNotQualifiedTransition`
 * (a ordem vem da `funnel_stage_precedence`, SQL, fonte única; o SQL real é provado no e2e T12, T-095-35); aqui o fake
 * responde a precedência com a ordem da mig 477 só para exercitar a decisão.
 *  - etapa > QUALIFIED (SELECTED/QRT): nada muda;
 *  - etapa ≤ QUALIFIED: encuadre RECHAZADO/TALENTUM_EXPIRED + WJA REJECTED + evento audit-only `auto_expired`.
 */
import { applyExpiredTransition, evaluateFunnelGuard, toPersistedFunnelStage, deriveFunnelStage, TALENTUM_EXPIRED_REASON } from '../talentumFunnel';

const PREC: Record<string, number> = {
  INVITED: 0, PRE_SCREENING: 1, IN_PROGRESS: 2, COMPLETED: 3, IN_DOUBT: 4, QUALIFIED: 5, SELECTED: 7, REJECTED: 7, QUICK_RESPONSE_TEAM: 8,
};

function fakeDb(lastChangedBy?: string | null | 'sem-trilha') {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('funnel_stage_precedence')) return { rows: [{ above: (PREC[String(params?.[0])] ?? -1) > PREC.QUALIFIED }] };
      if (sql.includes('worker_job_application_stage_history')) {
        return { rows: lastChangedBy === undefined || lastChangedBy === 'sem-trilha' ? [] : [{ changed_by: lastChangedBy }] };
      }
      return { rows: [] };
    }),
  };
}
const writes = (db: ReturnType<typeof fakeDb>) => db.calls.filter((c) => /^\s*(UPDATE|INSERT)/.test(c.sql));

describe('applyExpiredTransition', () => {
  it.each(['SELECTED', 'QUICK_RESPONSE_TEAM'])('EXPIRED sobre %s (acima de QUALIFIED): não escreve nada', async (prev) => {
    const db = fakeDb();
    expect(await applyExpiredTransition(db, 'w', 'j', 'EXPIRED', prev, 'p')).toBe(false);
    expect(writes(db)).toEqual([]);
  });

  it.each(['INVITED', 'PRE_SCREENING', 'IN_PROGRESS', 'COMPLETED', 'IN_DOUBT', 'QUALIFIED', null])(
    'EXPIRED sobre %s: encuadre RECHAZADO/TALENTUM_EXPIRED, WJA REJECTED e evento funnel_stage.rejected auto_expired (processed)',
    async (prev) => {
      const db = fakeDb();
      expect(await applyExpiredTransition(db, 'w', 'j', 'EXPIRED', prev, 'p')).toBe(true);
      const w = writes(db);
      expect(w).toHaveLength(3);
      expect(w[0].sql).toContain("resultado = 'RECHAZADO'");
      expect(w[0].sql).toContain("rejection_reason_category = 'TALENTUM_EXPIRED'");
      expect(w[1].sql).toContain("application_funnel_stage = 'REJECTED'");
      expect(w[2].sql).toContain("'funnel_stage.rejected'");
      expect(w[2].sql).toContain("'processed'");
      expect(JSON.parse(String(w[2].params?.[0]))).toEqual({ workerId: 'w', jobPostingId: 'j', prescreeningId: 'p', source: 'auto_expired' });
      // nenhum evento `funnel_stage.not_qualified` (NQ) nem `qualified` (mensagem ao prestador) nasce da expiração
      expect(w.map((c) => c.sql).join('\n')).not.toContain('not_qualified');
      expect(w.map((c) => c.sql).join('\n')).not.toContain('funnel_stage.qualified');
    },
  );

  it('já REJECTED, ou veredito que não é EXPIRED: nada', async () => {
    const a = fakeDb();
    expect(await applyExpiredTransition(a, 'w', 'j', 'EXPIRED', 'REJECTED')).toBe(false);
    expect(writes(a)).toEqual([]);
    const b = fakeDb();
    expect(await applyExpiredTransition(b, 'w', 'j', 'NOT_QUALIFIED', 'INVITED')).toBe(false);
    expect(writes(b)).toEqual([]);
  });

  it('prescreeningId ausente → o evento grava prescreeningId=null, não undefined', async () => {
    const db = fakeDb();
    await applyExpiredTransition(db, 'w', 'j', 'EXPIRED', 'INVITED');
    expect(JSON.parse(String(writes(db)[2].params?.[0])).prescreeningId).toBeNull();
  });
});

describe('expiração: mapeamento de etapa e motivo', () => {
  it("subtype EXPIRED e ANALYZED + statusLabel EXPIRED → etapa 'EXPIRED'; persistida como REJECTED", () => {
    expect(deriveFunnelStage('EXPIRED')).toBe('EXPIRED');
    expect(deriveFunnelStage('ANALYZED', 'EXPIRED')).toBe('EXPIRED');
    expect(toPersistedFunnelStage('EXPIRED')).toBe('REJECTED');
    expect(TALENTUM_EXPIRED_REASON).toBe('TALENTUM_EXPIRED');
  });
});

describe('evaluateFunnelGuard na expiração: última movimentação não humana', () => {
  it('última linha de uid NOSSO → HUMAN_LAST (a expiração não desfaz o que a coordenação fez)', async () => {
    expect(await evaluateFunnelGuard(fakeDb('staff:uid-1'), 'w', 'j', false, 'EXPIRED')).toBe('HUMAN_LAST');
  });
  it('última linha automática/sem trilha → segue; o mesmo uid nosso com OUTRA etapa (ex.: COMPLETED) também segue', async () => {
    expect(await evaluateFunnelGuard(fakeDb(''), 'w', 'j', false, 'EXPIRED')).toBeNull();
    expect(await evaluateFunnelGuard(fakeDb('system:x'), 'w', 'j', false, 'EXPIRED')).toBeNull();
    expect(await evaluateFunnelGuard(fakeDb('sem-trilha'), 'w', 'j', false, 'EXPIRED')).toBeNull();
    expect(await evaluateFunnelGuard(fakeDb('staff:uid-1'), 'w', 'j', false, 'COMPLETED')).toBeNull();
  });
  it('última linha talentum:manual → AFTER_MANUAL também para a expiração', async () => {
    expect(await evaluateFunnelGuard(fakeDb('talentum:manual'), 'w', 'j', false, 'EXPIRED')).toBe('AFTER_MANUAL');
  });
});
