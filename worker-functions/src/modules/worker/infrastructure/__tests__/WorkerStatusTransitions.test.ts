/**
 * Unit — WorkerStatusTransitions (escritor único de workers.status, spec 093).
 * Mock de Pool/PoolClient; `_recalculateStatus` mockado (controla o status e chama o callback de escrita).
 */

jest.mock('../WorkerImportRepository', () => ({ recalculateStatus: jest.fn() }));

import {
  recalculate,
  recalculateInTransaction,
  restoreFromDisabled,
  disable,
  setStatus,
  publishStatusEventsAfterCommit,
} from '../WorkerStatusTransitions';
import { recalculateStatus as mockRecalculate } from '../WorkerImportRepository';
import type { PubSubClient } from '@shared/events/PubSubClient';

const mockedRecalculate = mockRecalculate as jest.MockedFunction<typeof mockRecalculate>;

function makeClient() {
  return { query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() };
}
function makePool(client = makeClient()) {
  return { connect: jest.fn().mockResolvedValue(client), query: jest.fn(), _client: client };
}
function makePubsub() {
  return { publish: jest.fn().mockResolvedValue('msg-1') };
}
const sqls = (client: ReturnType<typeof makeClient>) => client.query.mock.calls.map((c) => String(c[0]));

/** Status atual lido pela guarda C7 + INSERTs de domain_events devolvendo ids. */
function queryScript(client: ReturnType<typeof makeClient>, atual: string) {
  client.query.mockImplementation(async (sql: string) => {
    if (/SELECT status FROM workers/.test(sql)) return { rows: [{ status: atual }] };
    if (/INSERT INTO domain_events/.test(sql)) {
      return { rows: [{ id: `evt-${client.query.mock.calls.length}` }] };
    }
    return { rows: [] };
  });
}
function setupRecalculate(status: string) {
  mockedRecalculate.mockImplementation(async (_p, id, writeFn) => {
    await writeFn(id, status as never);
    return status as never;
  });
}

const ACTOR = { id: 'staff:abc', source: 'staff' } as never;

afterEach(() => jest.clearAllMocks());

describe('WorkerStatusTransitions', () => {
  it('(a) set_config do flow com `true` roda ANTES do UPDATE, no mesmo client/transação', async () => {
    const client = makeClient();
    queryScript(client, 'INCOMPLETE_REGISTER');
    setupRecalculate('REGISTERED');

    await recalculate(makePool(client) as never, 'w-1', { flow: 'WIZARD_STEP' });

    const calls = sqls(client);
    const iBegin = calls.indexOf('BEGIN');
    const iFlow = calls.findIndex((s) => s.includes(`set_config('app.status_flow', $1, true)`));
    const iUpdate = calls.findIndex((s) => /UPDATE workers SET status/.test(s));
    expect(iBegin).toBeGreaterThanOrEqual(0);
    expect(iFlow).toBeGreaterThan(iBegin);
    expect(iUpdate).toBeGreaterThan(iFlow);
    const flowCall = client.query.mock.calls[iFlow];
    expect(flowCall[1]).toEqual(['WIZARD_STEP']);
  });

  it('(b) REGISTERED enfileira os 2 eventos no mesmo client e publica só APÓS o COMMIT', async () => {
    const client = makeClient();
    queryScript(client, 'INCOMPLETE_REGISTER');
    setupRecalculate('REGISTERED');
    const pubsub = makePubsub();
    pubsub.publish.mockImplementation(async () => {
      expect(sqls(client)).toContain('COMMIT'); // publish já viu o COMMIT
      return 'ok';
    });

    const out = await recalculate(makePool(client) as never, 'w-2', {
      flow: 'WORKER_DOCUMENT_UPLOAD',
      pubsub: pubsub as unknown as PubSubClient,
    });

    expect(out).toBe('REGISTERED');
    const calls = sqls(client);
    expect(calls.filter((s) => /INSERT INTO domain_events/.test(s))).toHaveLength(2);
    expect(calls.indexOf('COMMIT')).toBeGreaterThan(calls.map((s) => /INSERT INTO domain_events/.test(s)).lastIndexOf(true));
    expect(pubsub.publish).toHaveBeenCalledTimes(2);
    expect(pubsub.publish.mock.calls.map((c) => c[0]).sort()).toEqual([
      'worker-mirror-requested',
      'worker-registration-completed',
    ]);
  });

  it('(b2) falha de publish é engolida (best-effort), nos dois tópicos', async () => {
    const client = makeClient();
    queryScript(client, 'INCOMPLETE_REGISTER');
    setupRecalculate('REGISTERED');
    const pubsub = makePubsub();
    pubsub.publish.mockRejectedValue(new Error('UNAVAILABLE'));

    await expect(
      recalculate(makePool(client) as never, 'w-2b', { flow: 'WIZARD_STEP', pubsub: pubsub as never }),
    ).resolves.toBe('REGISTERED');
    expect(pubsub.publish).toHaveBeenCalledTimes(2);
  });

  it('(b3) transição não-REGISTERED: sem domain_events e sem publish', async () => {
    const client = makeClient();
    queryScript(client, 'REGISTERED');
    setupRecalculate('INCOMPLETE_REGISTER');
    const pubsub = makePubsub();

    await recalculate(makePool(client) as never, 'w-3', { flow: 'ADMIN_DOCUMENT_REVIEW', pubsub: pubsub as never });

    expect(sqls(client).filter((s) => s.includes('domain_events'))).toHaveLength(0);
    expect(pubsub.publish).not.toHaveBeenCalled();
  });

  it('(c) DISABLED não é recalculado: null, sem UPDATE e sem consultar o recálculo', async () => {
    const client = makeClient();
    queryScript(client, 'DISABLED');
    setupRecalculate('REGISTERED');

    const out = await recalculate(makePool(client) as never, 'w-baixado', { flow: 'WORKER_DOCUMENT_UPLOAD' });

    expect(out).toBeNull();
    expect(mockedRecalculate).not.toHaveBeenCalled();
    expect(sqls(client).some((s) => /UPDATE workers/.test(s))).toBe(false);
    expect(sqls(client).some((s) => s.includes('app.status_flow'))).toBe(false);
  });

  it('(c2) status inalterado: null, sem UPDATE', async () => {
    const client = makeClient();
    queryScript(client, 'REGISTERED');
    mockedRecalculate.mockResolvedValue(null);

    const out = await recalculate(makePool(client) as never, 'w-same', { flow: 'WIZARD_STEP' });

    expect(out).toBeNull();
    expect(sqls(client).some((s) => /UPDATE workers/.test(s))).toBe(false);
  });

  it('(d) actor presente: current_uid carimbado antes do UPDATE', async () => {
    const client = makeClient();
    queryScript(client, 'INCOMPLETE_REGISTER');
    setupRecalculate('REGISTERED');

    await recalculate(makePool(client) as never, 'w-4', { flow: 'ADMIN_STATUS_CHANGE', actor: ACTOR });

    const calls = client.query.mock.calls;
    const iUid = calls.findIndex((c) => String(c[0]).includes('app.current_uid'));
    const iUpdate = calls.findIndex((c) => /UPDATE workers SET status/.test(String(c[0])));
    expect(iUid).toBeGreaterThanOrEqual(0);
    expect(calls[iUid][1]).toEqual(['staff:abc']);
    expect(iUid).toBeLessThan(iUpdate);
  });

  it('(d2) recalculateInTransaction com actor carimba current_uid e NÃO faz BEGIN/COMMIT', async () => {
    const client = makeClient();
    queryScript(client, 'INCOMPLETE_REGISTER');
    setupRecalculate('REGISTERED');

    const out = await recalculateInTransaction(client as never, 'w-4b', { flow: 'ARCHIVE_REACTIVATION', actor: ACTOR });

    expect(out.newStatus).toBe('REGISTERED');
    expect(out.eventIds.mirror).toBeTruthy();
    expect(out.eventIds.registrationCompleted).toBeTruthy();
    const calls = sqls(client);
    expect(calls).not.toContain('BEGIN');
    expect(calls).not.toContain('COMMIT');
    expect(calls.some((s) => s.includes('app.current_uid'))).toBe(true);
  });

  it('(e) restoreFromDisabled grava INCOMPLETE_REGISTER e recalcula no MESMO client', async () => {
    const client = makeClient();
    queryScript(client, 'INCOMPLETE_REGISTER');
    setupRecalculate('REGISTERED');

    const out = await restoreFromDisabled(client as never, 'w-5', { flow: 'ARCHIVE_REACTIVATION' });

    const updates = client.query.mock.calls.filter((c) => /UPDATE workers SET status/.test(String(c[0])));
    expect(updates[0][1]).toEqual(['w-5', 'INCOMPLETE_REGISTER']);
    expect(updates[1][1]).toEqual(['w-5', 'REGISTERED']);
    expect(mockedRecalculate.mock.calls[0][0]).toBe(client); // mesmo client, não o pool
    expect(out.newStatus).toBe('REGISTERED');
    // cada UPDATE precedido do set_config do flow
    const calls = sqls(client);
    const flows = calls.map((s, i) => (s.includes('app.status_flow') ? i : -1)).filter((i) => i >= 0);
    const ups = calls.map((s, i) => (/UPDATE workers SET status/.test(s) ? i : -1)).filter((i) => i >= 0);
    expect(flows[0]).toBeLessThan(ups[0]);
    expect(flows[1]).toBeLessThan(ups[1]);
  });

  it('disable grava DISABLED com o flow declarado antes, no client do chamador', async () => {
    const client = makeClient();

    await disable(client as never, 'w-6', { flow: 'ACCOUNT_DEACTIVATION' });

    const calls = client.query.mock.calls;
    expect(String(calls[0][0])).toContain('app.status_flow');
    expect(calls[0][1]).toEqual(['ACCOUNT_DEACTIVATION']);
    expect(calls[1][1]).toEqual(['w-6', 'DISABLED']);
    expect(sqls(client)).not.toContain('BEGIN');
  });

  it('setStatus: BEGIN, flow, UPDATE, COMMIT na mesma transação', async () => {
    const client = makeClient();

    await setStatus(makePool(client) as never, 'w-7', 'INCOMPLETE_REGISTER', { flow: 'ADMIN_STATUS_CHANGE' });

    const calls = sqls(client);
    expect(calls[0]).toBe('BEGIN');
    expect(calls.findIndex((s) => s.includes('app.status_flow'))).toBeLessThan(
      calls.findIndex((s) => /UPDATE workers SET status/.test(s)),
    );
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('(f) erro → ROLLBACK, relança e nenhum publish', async () => {
    const client = makeClient();
    client.query.mockImplementation(async (sql: string) => {
      if (/UPDATE workers SET status/.test(sql)) throw new Error('DB_ERR');
      if (/SELECT status FROM workers/.test(sql)) return { rows: [{ status: 'INCOMPLETE_REGISTER' }] };
      return { rows: [] };
    });
    setupRecalculate('REGISTERED');
    const pubsub = makePubsub();

    await expect(
      recalculate(makePool(client) as never, 'w-8', { flow: 'WIZARD_STEP', pubsub: pubsub as never }),
    ).rejects.toThrow('DB_ERR');

    expect(sqls(client)).toContain('ROLLBACK');
    expect(sqls(client)).not.toContain('COMMIT');
    expect(pubsub.publish).not.toHaveBeenCalled();
  });

  it('publishStatusEventsAfterCommit sem pubsub não faz nada', async () => {
    await expect(
      publishStatusEventsAfterCommit('w', { mirror: 'a', registrationCompleted: 'b' }, null),
    ).resolves.toBeUndefined();
  });
});
