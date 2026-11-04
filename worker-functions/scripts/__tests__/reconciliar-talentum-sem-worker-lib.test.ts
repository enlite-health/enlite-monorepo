/** Reconciliação das candidatas do Talentum sem worker: dry-run não grava, apply grava só o resolvível, ambíguo vai à lista. */
import type { PoolClient } from 'pg';
import {
  analyzedLabel, formatOutcome, formatTotals, parseReconcileArgs, reconcile, stageFromStatus,
  type Outcome, type PendingRow, type ReconcileDeps, type TalentumReader,
} from '../reconciliar-talentum-sem-worker-lib';

const row = (n: number, status = 'QUALIFIED'): PendingRow => ({
  id: `row-${n}`, talentumPrescreeningId: `tp-${n}`, talentumProfileId: `prof-${n}`, status, jobPostingId: 'jp-1', talentumProjectId: 'proj-1',
});

/** Banco em memória com transação: o que a transação escreve só vira "committed" se ela não lançar (COMMIT × ROLLBACK). */
function fakeDb(
  workersBySelect: Record<string, string[]>,
  opts: { workerInsert?: 'ok' | 'collision' | 'boom'; previousStage?: string | null } = {},
) {
  const committed: string[] = [];
  const selectCalls: unknown[][] = [];
  const params: Record<string, unknown[]> = {};
  const runInTransaction: ReconcileDeps['runInTransaction'] = async (fn) => {
    const pending: string[] = [];
    const client = {
      query: async (sql: string, p: unknown[]) => {
        if (sql.includes('FROM workers')) {
          selectCalls.push(p);
          return { rows: (workersBySelect[String(p[0])] ?? []).map((id) => ({ id })) };
        }
        const head = sql.trim().split(/\s+/).slice(0, 3).join(' ');
        if (head.startsWith('SELECT application_funnel_stage')) {
          return { rows: opts.previousStage ? [{ application_funnel_stage: opts.previousStage }] : [] };
        }
        if (head.startsWith('INSERT INTO workers')) {
          if (opts.workerInsert === 'collision') throw Object.assign(new Error('duplicate key value violates unique constraint "x"'), { code: '23505' });
          if (opts.workerInsert === 'boom') throw new Error('falha do banco');
          params['workers'] = p;
          pending.push(head);
          return { rows: [{ id: 'w-new' }] };
        }
        if (head.startsWith('SAVEPOINT') || head.startsWith('RELEASE') || head.startsWith('ROLLBACK')) return { rows: [] };
        pending.push(head);
        params[head] = p;
        return { rows: [] };
      },
    } as unknown as PoolClient;
    const result = await fn(client); // lançar = ROLLBACK: `pending` é descartado
    committed.push(...pending);
    return result;
  };
  return { committed, selectCalls, params, runInTransaction };
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

  it('(1) ANALYZED NUNCA vira etapa "ANALYZED" (viola o CHECK): usa o statusLabel do Talentum; sem label, não toca', () => {
    expect(stageFromStatus('ANALYZED', 'QUALIFIED')).toBe('QUALIFIED');
    expect(stageFromStatus('ANALYZED', 'NOT_QUALIFIED')).toBe('NOT_QUALIFIED');
    expect(stageFromStatus('ANALYZED', 'IN_DOUBT')).toBe('IN_DOUBT');
    expect(stageFromStatus('ANALYZED', 'PENDING')).toBeNull();
    expect(stageFromStatus('ANALYZED', null)).toBeNull();
    expect(stageFromStatus('ANALYZED', 'lixo')).toBeNull();
  });

  it('analyzedLabel: campo statusLabel da candidata, ou QUALIFIED se está na lista de qualificados', () => {
    expect(analyzedLabel({ profileId: 'p', statusLabel: 'IN_DOUBT' }, false)).toBe('IN_DOUBT');
    expect(analyzedLabel({ profileId: 'p' }, true)).toBe('QUALIFIED');
    expect(analyzedLabel({ profileId: 'p' }, false)).toBeNull();
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

  it('PENDING vincula mas não toca a candidatura', async () => {
    const db = fakeDb({ 'talentum_prof-1': ['w-1'] });
    const out = await reconcile({ talentum: talentum(), runInTransaction: db.runInTransaction, listPending: async () => [row(1, 'PENDING')] }, 'apply');

    expect(out[0]).toMatchObject({ kind: 'RESOLVED', stage: null });
    expect(db.committed).toEqual(['UPDATE talentum_prescreenings SET', 'INSERT INTO encuadres']);
  });

  it('(1) ANALYZED grava a etapa do statusLabel (QUALIFIED via lista de qualificados), nunca "ANALYZED"', async () => {
    const db = fakeDb({ 'talentum_prof-1': ['w-1'] });
    const out = await reconcile({ talentum: talentum(), runInTransaction: db.runInTransaction, listPending: async () => [row(1, 'ANALYZED')] }, 'apply');

    expect(out[0]).toMatchObject({ kind: 'RESOLVED', stage: 'QUALIFIED' });
    expect(db.params['INSERT INTO worker_job_applications']).toEqual(['w-1', 'jp-1', 'QUALIFIED']);
  });

  it('(2) NOT_QUALIFIED aplica a transição do webhook: WJA REJECTED + encuadre RECHAZADO + eventos audit-only, sem mensagem', async () => {
    const db = fakeDb({ 'talentum_prof-1': ['w-1'] });
    const out = await reconcile({ talentum: talentum(), runInTransaction: db.runInTransaction, listPending: async () => [row(1, 'NOT_QUALIFIED')] }, 'apply');

    expect(out[0]).toMatchObject({ kind: 'RESOLVED', stage: 'REJECTED', committed: true });
    expect(db.params['INSERT INTO worker_job_applications']).toEqual(['w-1', 'jp-1', 'REJECTED']);
    expect(db.committed).toEqual([
      'UPDATE talentum_prescreenings SET', 'INSERT INTO encuadres', 'INSERT INTO worker_job_applications',
      'UPDATE encuadres SET', 'INSERT INTO domain_events', 'UPDATE worker_job_applications SET', 'INSERT INTO domain_events',
    ]);
    expect(db.params['UPDATE encuadres SET']).toEqual(['w-1', 'jp-1']);
  });

  it('(2) NOT_QUALIFIED com WJA já REJECTED não repete a transição (como o webhook)', async () => {
    const db = fakeDb({ 'talentum_prof-1': ['w-1'] }, { previousStage: 'REJECTED' });
    await reconcile({ talentum: talentum(), runInTransaction: db.runInTransaction, listPending: async () => [row(1, 'NOT_QUALIFIED')] }, 'apply');

    expect(db.committed).not.toContain('UPDATE encuadres SET');
  });

  it('(3) sem worker: cria pelo auto-create do webhook (INSERT workers) e segue o funil com o id novo', async () => {
    const db = fakeDb({}, { workerInsert: 'ok' });
    const out = await reconcile({ talentum: talentum(), runInTransaction: db.runInTransaction, listPending: async () => [row(1)] }, 'apply');

    expect(out[0]).toMatchObject({ kind: 'RESOLVED', workerId: 'w-new', committed: true });
    expect(db.params['workers']).toEqual(['talentum_prof-1', 'x@y.com', '5491155261243']);
    expect(db.committed).toContain('INSERT INTO workers');
    expect(db.params['UPDATE talentum_prescreenings SET']![0]).toBe('w-new');
  });

  it('(3) auto-create que colide ou falha vai para a lista (NO_WORKER com causa) e não insiste', async () => {
    for (const mode of ['collision', 'boom'] as const) {
      const db = fakeDb({}, { workerInsert: mode });
      const out = await reconcile({ talentum: talentum(), runInTransaction: db.runInTransaction, listPending: async () => [row(1)] }, 'apply');

      expect(out[0]).toMatchObject({ kind: 'NO_WORKER', rowId: 'row-1' });
      expect((out[0] as { reason?: string }).reason).toBeTruthy();
      expect(db.committed).toEqual([]);
    }
  });

  it('erro numa linha desfaz só ela; erro no GET do Talentum marca as linhas do projeto e segue', async () => {
    const failing: TalentumReader = { candidates: async () => { throw new Error('GET /projects/proj-1 → HTTP 500'); }, readyForInterview: async () => [] };
    const lines: string[] = [];
    const out = await reconcile({ talentum: failing, runInTransaction: fakeDb({}).runInTransaction, listPending: async () => [row(1)], log: (l) => lines.push(l) }, 'apply');
    expect(out[0]).toMatchObject({ kind: 'ERROR' });
    // (4) a linha de erro sai identificada (id + causa), inclusive o erro do GET do projeto
    expect(lines).toEqual([expect.stringMatching(/^ERROR row=row-1 talentum GET: .*HTTP 500/)]);

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
