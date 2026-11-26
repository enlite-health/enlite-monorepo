/**
 * ProcessTalentumInboxUseCase.prefetch.test.ts — T-095-30 (spec 095 §3.2): a busca no Talentum da criação de vaga
 * acontece ANTES do BEGIN da transação da linha, com 0 conexões abertas; a transação só grava.
 * Pool, inbox e casos de uso são dublês (espiões de ordem); payload sintético.
 */
import type { Pool } from 'pg';
import { ProcessTalentumInboxUseCase } from '../ProcessTalentumInboxUseCase';
import type { ITalentumInboxRepository, TalentumInboxRow } from '../../domain/TalentumInbox';

const payload = { action: 'PRESCREENING', subtype: 'CREATED', data: { _id: 'proj-1', name: 'CASO 9' } };

function build(prefetch: jest.Mock | undefined) {
  const events: string[] = [];
  let open = 0;
  const client = {
    query: jest.fn(async (sql: string) => {
      if (sql === 'BEGIN') { open += 1; events.push('BEGIN'); }
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { open -= 1; events.push(sql); }
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  const pool = { connect: jest.fn(async () => { events.push('connect'); return client; }), query: jest.fn(async () => ({ rows: [] })) };
  const row = {
    id: 'i1', receivedAt: new Date('2026-11-25T10:00:00Z'), action: 'PRESCREENING', subtype: 'CREATED',
    talentumPrescreeningId: 'proj-1', talentumProfileId: null, environment: 'production', state: 'RECEIVED', attempts: 0, payloadEnc: 'ENC(i1)',
  } as TalentumInboxRow;
  const inbox = {
    findById: jest.fn(async () => row),
    lockKey: jest.fn(async () => undefined),
    pendingForKey: jest.fn(async () => [row]),
    decryptPayload: jest.fn(async () => payload),
    markProcessed: jest.fn(async () => { events.push('markProcessed'); }),
    markFailed: jest.fn(async () => { events.push('markFailed'); }),
    markState: jest.fn(),
  } as unknown as ITalentumInboxRepository;
  const creator = {
    ...(prefetch ? { prefetch: jest.fn(async (d: any) => { events.push(`prefetch(open=${open})`); return prefetch(d); }) } : {}),
    execute: jest.fn(async (_d: any, _e: any, _c: any, pre: any) => { events.push(`execute(open=${open},pre=${JSON.stringify(pre)})`); }),
  };
  const uc = new ProcessTalentumInboxUseCase(pool as unknown as Pool, inbox, { execute: jest.fn() }, creator as any);
  return { uc, events, creator, inbox, pool };
}

describe('ProcessTalentumInboxUseCase — busca externa fora da transação (T-095-30)', () => {
  it('a chamada ao Talentum acontece com 0 conexões abertas; execute grava dentro da transação com o resultado', async () => {
    const w = build(jest.fn(async () => ({ prescreeningId: 'psc-9' })));
    const r = await w.uc.execute('i1');
    expect(r).toEqual({ inboxId: 'i1', outcome: 'PROCESSED', processed: 1 });
    const iPrefetch = w.events.findIndex((e) => e.startsWith('prefetch'));
    expect(w.events[iPrefetch]).toBe('prefetch(open=0)');
    const execIdx = w.events.findIndex((e) => e.startsWith('execute'));
    expect(w.events[execIdx]).toBe('execute(open=1,pre={"prescreeningId":"psc-9"})');
    // a ordem: o prefetch vem antes do BEGIN que contém o execute
    expect(w.events.slice(0, iPrefetch).filter((e) => e === 'BEGIN').length).toBe(w.events.slice(0, iPrefetch).filter((e) => e === 'COMMIT').length);
    expect(w.creator.prefetch).toHaveBeenCalledTimes(1); // a MESMA chamada de antes, uma vez só
  });

  it('a busca falha: nenhuma transação aberta durante ela; a linha vira FAILED e o erro é relançado', async () => {
    const w = build(jest.fn(async () => { throw Object.assign(new Error('x'), { code: 'ECONNRESET' }); }));
    await expect(w.uc.execute('i1')).rejects.toMatchObject({ code: 'ECONNRESET' });
    expect(w.events).toContain('prefetch(open=0)');
    expect(w.events.some((e) => e.startsWith('execute'))).toBe(false);
    expect(w.events).toContain('markFailed');
  });

  it('sem prefetch no dublê (comportamento antigo): execute roda sem resultado prévio', async () => {
    const w = build(undefined);
    await w.uc.execute('i1');
    expect(w.events).toContain('execute(open=1,pre=undefined)');
  });
});
