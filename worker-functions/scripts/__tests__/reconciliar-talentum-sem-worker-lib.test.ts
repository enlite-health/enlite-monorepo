/** Reconciliação das candidatas do Talentum sem worker: dry-run não grava, apply grava só o resolvível, ambíguo vai à lista. */
import type { PoolClient } from 'pg';
import {
  formatOutcome, formatTotals, parseReconcileArgs, reconcile, stageFromStatus,
  type Outcome, type PendingRow, type ReconcileDeps, type TalentumReader,
} from '../reconciliar-talentum-sem-worker-lib';

const row = (n: number, status = 'QUALIFIED'): PendingRow => ({
  id: `row-${n}`, talentumPrescreeningId: `tp-${n}`, talentumProfileId: `prof-${n}`, status, jobPostingId: 'jp-1', talentumProjectId: 'proj-1',
});

/** Banco em memória com transação: o que a transação escreve só vira "committed" se ela não lançar (COMMIT × ROLLBACK). */
function fakeDb(workersBySelect: Record<string, string[]>) {
  const committed: string[] = [];
  const selectCalls: unknown[][] = [];
  const runInTransaction: ReconcileDeps['runInTransaction'] = async (fn) => {
    const pending: string[] = [];
    const client = {
      query: async (sql: string, params: unknown[]) => {
        if (sql.includes('FROM workers')) {
          selectCalls.push(params);
          return { rows: (workersBySelect[String(params[0])] ?? []).map((id) => ({ id })) };
        }
        pending.push(sql.trim().split(/\s+/).slice(0, 3).join(' '));
        return { rows: [] };
      },
    } as unknown as PoolClient;
    const result = await fn(client); // lançar = ROLLBACK: `pending` é descartado
    committed.push(...pending);
    return result;
  };
  return { committed, selectCalls, runInTransaction };
}

function talentum(): TalentumReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    candidates: async () => {
      calls.push('candidates');
      return [1, 2, 3].map((n) => ({ profileId: `prof-${n}`, firstName: 'A', lastName: 'B', phoneNumber: '541155261243' }));
    },
    readyForInterview: async () => {
      calls.push('ready');
      return [{ profileId: 'prof-1', email: 'x@y.com' }];
    },
  };
}

describe('parseReconcileArgs', () => {
  it('exatamente um modo; sem modo ou com os dois → recusa', () => {
    expect(parseReconcileArgs(['--dry-run'])).toEqual({ mode: 'dry-run' });
    expect(parseReconcileArgs(['--apply'])).toEqual({ mode: 'apply' });
    expect(() => parseReconcileArgs([])).toThrow('exatamente um');
    expect(() => parseReconcileArgs(['--apply', '--dry-run'])).toThrow('exatamente um');
  });
});

describe('stageFromStatus', () => {
  it('mesma conversão do webhook', () => {
    expect(stageFromStatus('INITIATED')).toBe('PRE_SCREENING');
    expect(stageFromStatus('QUALIFIED')).toBe('QUALIFIED');
    expect(stageFromStatus('PENDING')).toBeNull();
  });
});

describe('reconcile', () => {
  it('(d) dry-run executa tudo e dá ROLLBACK: NADA é gravado', async () => {
    const db = fakeDb({ 'talentum_prof-1': ['w-1'] });
    const out = await reconcile({ talentum: talentum(), runInTransaction: db.runInTransaction, listPending: async () => [row(1)] }, 'dry-run');

    expect(out).toEqual([{ kind: 'RESOLVED', rowId: 'row-1', workerId: 'w-1', stage: 'QUALIFIED', committed: false }]);
    expect(db.committed).toEqual([]);
  });

  it('apply grava vínculo, encuadre e etapa — e NENHUM domain_event/Pub/Sub (sem mensagem)', async () => {
    const db = fakeDb({ 'talentum_prof-1': ['w-1'] });
    const out = await reconcile({ talentum: talentum(), runInTransaction: db.runInTransaction, listPending: async () => [row(1)] }, 'apply');

    expect(out[0]).toMatchObject({ kind: 'RESOLVED', committed: true });
    expect(db.committed).toEqual(['UPDATE talentum_prescreenings SET', 'INSERT INTO encuadres', 'INSERT INTO worker_job_applications']);
    expect(db.committed.join(' ')).not.toContain('domain_events');
  });

  it('casa por telefone sem o 9 (candidatos incluem a forma com o 9) e por e-mail do ready-for-interview', async () => {
    const db = fakeDb({});
    await reconcile({ talentum: talentum(), runInTransaction: db.runInTransaction, listPending: async () => [row(1)] }, 'dry-run');

    const [authUid, email, phones] = db.selectCalls[0] as [string, string, string[]];
    expect(authUid).toBe('talentum_prof-1');
    expect(email).toBe('x@y.com');
    expect(phones).toContain('5491155261243');
  });

  it('ambíguo (>1 worker) NÃO é aplicado; sem worker e fora do Talentum idem', async () => {
    const db = fakeDb({ 'talentum_prof-1': ['w-1', 'w-2'] });
    const out = await reconcile(
      { talentum: talentum(), runInTransaction: db.runInTransaction, listPending: async () => [row(1), row(2), row(9)] },
      'apply',
    );

    expect(out.map((o) => o.kind)).toEqual(['AMBIGUOUS', 'NO_WORKER', 'NOT_IN_TALENTUM']);
    expect(db.committed).toEqual([]);
  });

  it('PENDING vincula mas não toca a candidatura; NOT_QUALIFIED é adiado (lista)', async () => {
    const db = fakeDb({ 'talentum_prof-1': ['w-1'] });
    const out = await reconcile(
      { talentum: talentum(), runInTransaction: db.runInTransaction, listPending: async () => [row(1, 'PENDING'), row(2, 'NOT_QUALIFIED')] },
      'apply',
    );

    expect(out[0]).toMatchObject({ kind: 'RESOLVED', stage: null });
    expect(out[1].kind).toBe('DEFERRED');
    expect(db.committed).toEqual(['UPDATE talentum_prescreenings SET', 'INSERT INTO encuadres']);
  });

  it('erro numa linha desfaz só ela; erro no GET do Talentum marca as linhas do projeto e segue', async () => {
    const failing: TalentumReader = { candidates: async () => { throw new Error('GET /projects/proj-1 → HTTP 500'); }, readyForInterview: async () => [] };
    const out = await reconcile({ talentum: failing, runInTransaction: fakeDb({}).runInTransaction, listPending: async () => [row(1)] }, 'apply');
    expect(out[0]).toMatchObject({ kind: 'ERROR' });

    const boom: ReconcileDeps['runInTransaction'] = async () => { throw new Error('db caiu'); };
    const out2 = await reconcile({ talentum: talentum(), runInTransaction: boom, listPending: async () => [row(1)] }, 'apply');
    expect(out2[0]).toEqual({ kind: 'ERROR', rowId: 'row-1', error: 'db caiu' });
  });

  it('relatório: só IDs e contagens', () => {
    const lines: string[] = [];
    const outs: Outcome[] = [
      { kind: 'RESOLVED', rowId: 'r1', workerId: 'w', stage: 'QUALIFIED', committed: false },
      { kind: 'AMBIGUOUS', rowId: 'r2', workerIds: ['a', 'b'] },
      { kind: 'DEFERRED', rowId: 'r3', reason: 'x' },
      { kind: 'ERROR', rowId: 'r4', error: 'e' },
      { kind: 'NO_WORKER', rowId: 'r5' },
    ];
    outs.forEach((o) => lines.push(formatOutcome(o)));
    expect(lines[1]).toContain('workers=a,b');
    expect(formatTotals(outs, 'dry-run')[0]).toContain('resolvidas=1 ambiguas=1 sem_worker=1');
    expect(formatTotals(outs, 'apply')[1]).toContain('apply');
  });
});
