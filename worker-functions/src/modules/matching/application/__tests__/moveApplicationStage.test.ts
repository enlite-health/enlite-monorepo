import type { PoolClient } from 'pg';
import { moveApplicationStage, type MoveApplicationStageInput } from '../moveApplicationStage';

/**
 * moveApplicationStage — o miolo da mudança de estágio (spec 052, T-30a). O client é um
 * dublê que responde à leitura da etapa anterior e registra toda query, para provar o que
 * é (e o que NÃO é) escrito.
 */

type Row = { application_funnel_stage: string | null; source: string | null; messaged_at: string | null };

function fakeClient(prev: Row | null) {
  const query = jest.fn(async (sql: string) => {
    if (/FROM worker_job_applications WHERE worker_id/.test(sql)) return { rows: prev ? [prev] : [] };
    if (/INSERT INTO domain_events/.test(sql)) return { rows: [{ id: 'evt-1' }] };
    return { rows: [] };
  });
  return { client: { query } as unknown as PoolClient, query };
}

const SENT = '2026-10-01T10:00:00Z';
const from = (stage: string): Row => ({ application_funnel_stage: stage, source: 'manual', messaged_at: SENT });
const base: MoveApplicationStageInput = {
  workerId: 'w1', jobPostingId: 'j1', encuadreId: 'e1', targetStage: 'SELECTED', actorUid: 'staff-1',
};
const writes = (q: jest.Mock) =>
  q.mock.calls.map((c) => c[0] as string).filter((s) => /INSERT|UPDATE|set_config/i.test(s));

describe('moveApplicationStage', () => {
  it('(a) sem options, COMPLETED → SELECTED sem motivo recusa MOVE_REASON_REQUIRED/JUMP e NÃO escreve', async () => {
    const { client, query } = fakeClient(from('COMPLETED'));
    const r = await moveApplicationStage(client, base);
    expect(r).toEqual({ moved: false, code: 'MOVE_REASON_REQUIRED', reason: 'JUMP' });
    expect(writes(query)).toHaveLength(0);
  });

  it('(b) com skipJumpReason, COMPLETED → SELECTED e → QUICK_RESPONSE_TEAM movem sem motivo', async () => {
    const a = fakeClient(from('COMPLETED'));
    const rSel = await moveApplicationStage(a.client, base, { skipJumpReason: true });
    expect(rSel).toEqual({ moved: true, previousStage: 'COMPLETED', eventId: 'evt-1' });
    expect(a.query.mock.calls.some((c) => /INSERT INTO worker_job_applications/.test(c[0]))).toBe(true);
    expect(a.query.mock.calls.some((c) => /UPDATE encuadres SET resultado = 'SELECCIONADO'/.test(c[0]))).toBe(true);

    const b = fakeClient(from('COMPLETED'));
    const rQrt = await moveApplicationStage(b.client, { ...base, targetStage: 'QUICK_RESPONSE_TEAM' }, { skipJumpReason: true });
    expect(rQrt).toEqual({ moved: true, previousStage: 'COMPLETED', eventId: null });
  });

  it('(c) com skipJumpReason, COMPLETED → REJECTED sem motivo continua recusando ENTER_REJECTED', async () => {
    const { client, query } = fakeClient(from('COMPLETED'));
    const r = await moveApplicationStage(client, { ...base, targetStage: 'REJECTED' }, { skipJumpReason: true });
    expect(r).toEqual({ moved: false, code: 'MOVE_REASON_REQUIRED', reason: 'ENTER_REJECTED' });
    expect(writes(query)).toHaveLength(0);
  });

  it('(d) com skipJumpReason, REJECTED → COMPLETED sem motivo continua recusando LEAVE_REJECTED', async () => {
    const { client, query } = fakeClient(from('REJECTED'));
    const r = await moveApplicationStage(client, { ...base, targetStage: 'COMPLETED' }, { skipJumpReason: true });
    expect(r).toEqual({ moved: false, code: 'MOVE_REASON_REQUIRED', reason: 'LEAVE_REJECTED' });
    expect(writes(query)).toHaveLength(0);
  });

  it('(e) eventSource vai no payload do evento; o default é kanban', async () => {
    const payloadOf = (q: jest.Mock) =>
      JSON.parse(q.mock.calls.find((c) => /INSERT INTO domain_events/.test(c[0]))![1][1]);

    const enq = fakeClient(from('CONFIRMED'));
    await moveApplicationStage(enq.client, base, { eventSource: 'enquadre' });
    expect(payloadOf(enq.query)).toMatchObject({ source: 'enquadre', previousStage: 'CONFIRMED', actorUid: 'staff-1' });

    const def = fakeClient(from('CONFIRMED'));
    await moveApplicationStage(def.client, base);
    expect(payloadOf(def.query).source).toBe('kanban');
  });

  it('(f) QUICK_RESPONSE_TEAM não emite evento (como hoje)', async () => {
    const { client, query } = fakeClient(from('SELECTED'));
    const r = await moveApplicationStage(client, { ...base, targetStage: 'QUICK_RESPONSE_TEAM' });
    expect(r).toEqual({ moved: true, previousStage: 'SELECTED', eventId: null });
    expect(query.mock.calls.some((c) => /INSERT INTO domain_events/.test(c[0]))).toBe(false);
  });

  it('motivo válido é carimbado antes do upsert; motivo fora da lista recusa MOVE_REASON_INVALID', async () => {
    const ok = fakeClient(from('COMPLETED'));
    await moveApplicationStage(ok.client, { ...base, reasonCategory: 'OTHER' });
    const sqls = ok.query.mock.calls.map((c) => c[0] as string);
    expect(sqls.findIndex((s) => /set_config\('app.move_reason'/.test(s))).toBeLessThan(
      sqls.findIndex((s) => /INSERT INTO worker_job_applications/.test(s)),
    );

    const bad = fakeClient(from('COMPLETED'));
    const r = await moveApplicationStage(bad.client, { ...base, reasonCategory: 'NAO_EXISTE' });
    expect(r).toEqual({ moved: false, code: 'MOVE_REASON_INVALID', reason: 'JUMP' });
    expect(writes(bad.query)).toHaveLength(0);
  });
});
