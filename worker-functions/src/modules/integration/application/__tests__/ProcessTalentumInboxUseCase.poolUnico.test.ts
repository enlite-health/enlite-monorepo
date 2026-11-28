/**
 * ProcessTalentumInboxUseCase.poolUnico.test.ts — T-095-30 (spec 095 §3.2): o processador usa UMA conexão do pool.
 *
 * Defeito: o processador segura 1 conexão (lock + SAVEPOINT por linha) e, dentro dela, o `ProcessTalentumPrescreening` pegava
 * OUTRAS conexões do MESMO pool (`pool.connect()`/`pool.query()`). Com `DB_POOL_MAX=5` e 5 pushes simultâneos o pool
 * travava. Aqui o `ProcessTalentumPrescreening` é o REAL (só o banco e o Pub/Sub são dublês): o pool falso conta
 * `connect()` e `query()` diretos, e o resto tem de ir pelo client da transação. Caminhos: veredito, mudança manual,
 * expiração, conflito humano (+ criação de vaga, que também roda no client).
 */
import type { Pool } from 'pg';
import { ProcessTalentumInboxUseCase } from '../ProcessTalentumInboxUseCase';
import { ProcessTalentumPrescreening } from '@modules/matching/application/ProcessTalentumPrescreening';
import type { ITalentumInboxRepository, TalentumInboxRow } from '../../domain/TalentumInbox';

jest.mock('@shared/logging', () => ({
  ...jest.requireActual('@shared/logging'),
  reportError: jest.fn(),
}));

type Scenario = { stored: string | null; lastChangedBy: string | 'sem-trilha'; previousStage?: string | null };

const payloadFor = (over: { subtype: string; statusLabel?: string; source?: string }) => ({
  action: 'PRESCREENING_RESPONSE',
  subtype: over.subtype,
  data: {
    prescreening: { id: 'tp-1', name: 'CASO 1' },
    profile: { id: 'prof-1', firstName: 'A', lastName: 'B', email: 'sintetico@example.test', phoneNumber: '+5491100001111', registerQuestions: [] },
    response: { id: 'r1', state: [], score: 80, statusLabel: over.statusLabel, source: over.source },
  },
});

function build(payload: unknown, sc: Scenario, action: 'RESPONSE' | 'CREATED' = 'RESPONSE') {
  const events: string[] = [];
  const clientSqls: string[] = [];

  const client = {
    query: jest.fn(async (sql: string) => {
      clientSqls.push(sql);
      if (sql === 'COMMIT') events.push('COMMIT');
      if (sql.includes('FROM talentum_prescreenings WHERE')) return { rows: sc.stored ? [{ status: sc.stored }] : [] };
      if (sql.includes('worker_job_application_stage_history')) {
        return { rows: sc.lastChangedBy === 'sem-trilha' ? [] : [{ changed_by: sc.lastChangedBy, new_value: 'REJECTED' }] };
      }
      if (sql.includes('INSERT INTO domain_events')) return { rows: [{ id: 'evt-1' }] };
      if (sql.includes('WITH RECURSIVE chain')) return { rows: [{ id: 'w-1', depth: 0, merged_into_id: null }] };
      if (sql.includes('current_setting')) return { rows: [{ g0: null, g1: null, g2: null }] };
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => client), query: jest.fn(async () => ({ rows: [] })) };

  // Repositório/lookups dublês que SÓ funcionam rebindados: provam que o `withPool` aponta para a conexão da transação.
  const bound = (p: Pool) => ({
    upsertPrescreening: jest.fn(async (dto: any) => {
      await p.query('/* repo */ SELECT 1');
      return { prescreening: { id: 'ps-1', talentumPrescreeningId: 'tp-1', status: dto.status, workerId: 'w-1', jobPostingId: 'jp-1' }, previousJobPostingId: 'jp-1' };
    }),
    insertDivergence: jest.fn(),
    upsertWorkerJobApplicationFromTalentum: jest.fn(async (_d: any, c: any) => {
      await (c ?? p).query('/* wja */ SELECT 1');
      return { previousStage: sc.previousStage ?? null };
    }),
    upsertQuestion: jest.fn(async () => { await p.query('/* q */ SELECT 1'); return { question: { id: 'q-1' }, created: true }; }),
    upsertResponse: jest.fn(async () => { await p.query('/* r */ SELECT 1'); return { response: { id: 'r-1' }, created: true }; }),
    withPool: jest.fn(),
  });
  const unboundGuard = () => { throw new Error('usou o repositório sem rebind (pool do processo)'); };
  const repo: any = { withPool: (p: Pool) => bound(p), upsertPrescreening: unboundGuard, upsertWorkerJobApplicationFromTalentum: unboundGuard, upsertQuestion: unboundGuard, upsertResponse: unboundGuard, insertDivergence: unboundGuard };
  const workerLookup: any = {
    withPool: (p: Pool) => ({
      findByEmailNormalized: async () => { await p.query('/* email */ SELECT 1'); return { getValue: () => ({ id: 'w-1' }), ids: ['w-1'], ambiguousCount: 1 }; },
      findByPhoneCandidates: async () => ({ getValue: () => null, ids: [] }),
      findByCuit: async () => ({ getValue: () => null }),
    }),
  };
  const jobLookup: any = {
    withPool: (p: Pool) => ({
      findByTalentumPrescreeningId: async () => { await p.query('/* vaga */ SELECT 1'); return { id: 'jp-1' }; },
      findByTitleILike: async () => null,
    }),
  };
  const pubsub: any = { publish: jest.fn(async () => { events.push('publish'); return 'm'; }) };
  const notifier = { notify: jest.fn(async () => undefined) };
  const prescreening = new ProcessTalentumPrescreening(repo, workerLookup, jobLookup, pool as unknown as Pool, pubsub, notifier);
  const creator = { execute: jest.fn(async (_d: any, _e: any, c: any) => { await c.query('/* vaga criada */ SELECT 1'); }) };

  const created = action === 'CREATED';
  const row: TalentumInboxRow = {
    id: 'i1', receivedAt: new Date('2026-11-25T10:00:00Z'), action: created ? 'PRESCREENING' : 'PRESCREENING_RESPONSE',
    subtype: created ? 'CREATED' : (payload as any).subtype, talentumPrescreeningId: 'tp-1', talentumProfileId: 'prof-1',
    environment: 'production', state: 'RECEIVED', attempts: 0, payloadEnc: 'ENC(i1)',
  } as TalentumInboxRow;
  const inbox: ITalentumInboxRepository = {
    insertReceived: jest.fn(),
    findById: jest.fn(async () => row),
    lockKey: jest.fn(async () => undefined),
    pendingForKey: jest.fn(async () => [row]),
    decryptPayload: jest.fn(async () => payload),
    markProcessed: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => undefined),
    markState: jest.fn(async () => undefined),
  } as unknown as ITalentumInboxRepository;

  const uc = new ProcessTalentumInboxUseCase(pool as unknown as Pool, inbox, prescreening, creator);
  return { uc, pool, client, notifier, creator, events, clientSqls, pubsub };
}

const expectSingleConnection = (w: ReturnType<typeof build>) => {
  expect(w.pool.connect).toHaveBeenCalledTimes(1); // a transação do processador
  expect(w.pool.query).toHaveBeenCalledTimes(0);   // nada solto no pool
};

describe('ProcessTalentumInboxUseCase — uma conexão só (T-095-30)', () => {
  it('veredito QUALIFIED: 1 connect(), 0 query() no pool; o Pub/Sub só sai DEPOIS do COMMIT', async () => {
    const w = build(payloadFor({ subtype: 'ANALYZED', statusLabel: 'QUALIFIED' }), { stored: 'COMPLETED', lastChangedBy: 'sem-trilha', previousStage: 'SCREENED' });
    const r = await w.uc.execute('i1');
    expect(r).toEqual({ inboxId: 'i1', outcome: 'PROCESSED', processed: 1 });
    expectSingleConnection(w);
    expect(w.clientSqls.some((s) => s.includes('/* repo */'))).toBe(true); // o repositório rebindado escreveu no client
    expect(w.clientSqls.some((s) => s.includes('/* email */'))).toBe(true); // o lookup também
    expect(w.clientSqls.some((s) => s.includes('funnel_stage.qualified'))).toBe(true);
    expect(w.events).toEqual(['COMMIT', 'publish']);
  });

  it('mudança manual (source=MANUAL, sem trilha): 1 connect(), 0 query(); o ator é carimbado no client', async () => {
    const w = build(payloadFor({ subtype: 'ANALYZED', statusLabel: 'QUALIFIED', source: 'MANUAL' }), { stored: 'COMPLETED', lastChangedBy: 'sem-trilha' });
    await w.uc.execute('i1');
    expectSingleConnection(w);
    expect(w.clientSqls.some((s) => /set_config\('app\.current_uid'/.test(s))).toBe(true);
  });

  it('expiração (statusLabel=EXPIRED): 1 connect(), 0 query(); carimba o motivo TALENTUM_EXPIRED no client', async () => {
    const w = build(payloadFor({ subtype: 'ANALYZED', statusLabel: 'EXPIRED' }), { stored: 'COMPLETED', lastChangedBy: 'sem-trilha', previousStage: 'SCREENED' });
    await w.uc.execute('i1');
    expectSingleConnection(w);
    expect(w.clientSqls.some((s) => s.includes("set_config('app.move_reason'"))).toBe(true);
  });

  it('conflito humano (manual × última linha de uid nosso): 1 connect(), 0 query(); o sino recebe o client da transação', async () => {
    const w = build(payloadFor({ subtype: 'ANALYZED', statusLabel: 'QUALIFIED', source: 'MANUAL' }), { stored: 'COMPLETED', lastChangedBy: 'staff:uid-1' });
    await w.uc.execute('i1');
    expectSingleConnection(w);
    expect(w.notifier.notify).toHaveBeenCalledTimes(1);
    expect(w.notifier.notify).toHaveBeenCalledWith(expect.anything(), { workerId: 'w-1', jobPostingId: 'jp-1', talentumPrescreeningId: 'tp-1' });
  });

  it('criação de vaga (PRESCREENING.CREATED): o caso de uso de vaga recebe o client da transação (0 query() no pool)', async () => {
    const payload = { action: 'PRESCREENING', subtype: 'CREATED', data: { _id: 'proj-1', name: 'CASO 9' } };
    const w = build(payload, { stored: null, lastChangedBy: 'sem-trilha' }, 'CREATED');
    await w.uc.execute('i1');
    expectSingleConnection(w);
    expect(w.creator.execute).toHaveBeenCalledWith({ _id: 'proj-1', name: 'CASO 9' }, 'production', w.client);
  });

  it('linha que falha desfaz o que gravou e NÃO publica no Pub/Sub; o erro original é relançado', async () => {
    const w = build(payloadFor({ subtype: 'ANALYZED', statusLabel: 'QUALIFIED' }), { stored: 'COMPLETED', lastChangedBy: 'sem-trilha', previousStage: 'SCREENED' });
    (w.client.query as jest.Mock).mockImplementation(async (sql: string) => {
      w.clientSqls.push(sql);
      if (sql === 'COMMIT') w.events.push('COMMIT');
      if (sql.includes('FROM talentum_prescreenings WHERE')) return { rows: [{ status: 'COMPLETED' }] };
      if (sql.includes('INSERT INTO domain_events')) return { rows: [{ id: 'evt-1' }] };
      if (sql.includes('WITH RECURSIVE chain')) return { rows: [{ id: 'w-1', depth: 0, merged_into_id: null }] };
      if (sql.includes('current_setting')) return { rows: [{ g0: null, g1: null, g2: null }] };
      if (sql.includes('INSERT INTO encuadres')) throw Object.assign(new Error('x'), { code: '23503' });
      if (sql.includes('/* wja */')) throw Object.assign(new Error('boom'), { code: '40001' });
      return { rows: [] };
    });
    await expect(w.uc.execute('i1')).rejects.toMatchObject({ code: '40001' });
    expectSingleConnection(w);
    expect(w.events).toEqual(['COMMIT']); // nada de 'publish'
  });
});
