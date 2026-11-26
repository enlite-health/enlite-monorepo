/**
 * ProcessTalentumInboxUseCase.test.ts — T-095-30 (spec 095 §3.2).
 *
 * (a) ordem: as linhas da chave rodam UMA a UMA, na ordem entregue (received_at);
 * (b) linha PROCESSED não reprocessa (nem toma lock);
 * (c) erro marca FAILED (só code/constraint), relança, e as marcas ficam duráveis (COMMIT antes do throw);
 * (d) o lock da chave ENVOLVE as transações próprias do ProcessTalentumPrescreening (log de eventos + exclusão mútua);
 * (e) PRESCREENING (criação de vaga) → o caso de uso de vaga, sem passar pelo processador de resposta.
 * Pool, inbox e casos de uso são dublês; payload sintético.
 */
import { ProcessTalentumInboxUseCase, describeError } from '../ProcessTalentumInboxUseCase';
import type { ITalentumInboxRepository, TalentumInboxRow, TalentumInboxState } from '../../domain/TalentumInbox';

const K = { p: 'tp-1', c: 'prof-1' };

const responsePayload = (marker: string) => ({
  action: 'PRESCREENING_RESPONSE',
  subtype: 'COMPLETED',
  data: {
    prescreening: { id: K.p, name: 'CASO 1' },
    profile: { id: K.c, firstName: 'A', lastName: 'B', email: 'sintetico@example.test', phoneNumber: marker },
    response: { id: 'r1', state: [] },
  },
});

function row(id: string, over: Partial<TalentumInboxRow> = {}): TalentumInboxRow {
  return {
    id, receivedAt: new Date('2026-11-25T10:00:00Z'), action: 'PRESCREENING_RESPONSE', subtype: 'COMPLETED',
    talentumPrescreeningId: K.p, talentumProfileId: K.c, environment: 'production', state: 'RECEIVED', attempts: 0,
    payloadEnc: `ENC(${id})`, ...over,
  };
}

/** Mundo fake: eventos em ordem global, exclusão mútua do lock (solto no COMMIT/ROLLBACK), inbox em memória. */
function buildWorld(rows: TalentumInboxRow[], payloads: Record<string, unknown>) {
  const events: string[] = [];
  const states = new Map<string, TalentumInboxState>(rows.map((r) => [r.id, r.state]));
  const errorCodes = new Map<string, string>();
  const lockQueue: Array<() => void> = [];
  let lockHeld = false;
  let nextClient = 1;

  const releaseLock = () => {
    lockHeld = false;
    lockQueue.shift()?.();
  };

  const pool = {
    connect: async () => {
      const name = `c${nextClient++}`;
      let holdsLock = false;
      return {
        query: jest.fn(async (sql: string) => {
          if (sql === 'COMMIT' || sql === 'ROLLBACK') {
            events.push(`${name}:${sql}`);
            if (holdsLock) { holdsLock = false; releaseLock(); }
          } else if (sql === 'BEGIN') events.push(`${name}:BEGIN`);
          else if (/SAVEPOINT/.test(sql)) events.push(`${name}:${sql}`);
          return { rows: [] };
        }),
        release: jest.fn(),
        markLock: () => { holdsLock = true; },
        name,
      };
    },
    query: jest.fn(async () => ({ rows: [] })),
  };

  const inbox: ITalentumInboxRepository = {
    insertReceived: jest.fn(),
    findById: jest.fn(async (_c, id) => {
      const r = rows.find((x) => x.id === id);
      return r ? { ...r, state: states.get(id)! } : null;
    }),
    lockKey: jest.fn(async (client: any) => {
      if (lockHeld) await new Promise<void>((res) => lockQueue.push(res));
      lockHeld = true;
      client.markLock();
      events.push(`${client.name}:lock`);
    }),
    pendingForKey: jest.fn(async (_c, _p, _k, also: string[] = []) =>
      rows.filter((r) => states.get(r.id) === 'RECEIVED' || (also.includes(r.id) && states.get(r.id) !== 'PROCESSED'))
        .map((r) => ({ ...r, state: states.get(r.id)! }))),
    decryptPayload: jest.fn(async (r) => payloads[String(r.payloadEnc).slice(4, -1)]),
    markProcessed: jest.fn(async (_c, id) => { states.set(id, 'PROCESSED'); events.push(`mark:${id}:PROCESSED`); }),
    markFailed: jest.fn(async (_c, id, code) => { states.set(id, 'FAILED'); errorCodes.set(id, code); events.push(`mark:${id}:FAILED`); }),
    markState: jest.fn(),
  };
  return { events, states, errorCodes, pool, inbox };
}

describe('ProcessTalentumInboxUseCase', () => {
  it('(a) processa as linhas da chave uma a uma, na ordem entregue (nunca em paralelo)', async () => {
    const rows = [row('i1'), row('i2'), row('i3')];
    const w = buildWorld(rows, { i1: responsePayload('1'), i2: responsePayload('2'), i3: responsePayload('3') });
    const delays: Record<string, number> = { '1': 30, '2': 10, '3': 0 }; // a primeira é a mais lenta: em paralelo terminaria por último
    const processor = {
      execute: jest.fn(async (p: any) => {
        const m = p.data.profile.phoneNumber;
        w.events.push(`proc:start:${m}`);
        await new Promise((r) => setTimeout(r, delays[m]));
        w.events.push(`proc:end:${m}`);
      }),
    };

    const r = await new ProcessTalentumInboxUseCase(w.pool as any, w.inbox, processor, { execute: jest.fn() }).execute('i3');

    expect(r).toEqual({ inboxId: 'i3', outcome: 'PROCESSED', processed: 3 });
    expect(w.events.filter((e) => e.startsWith('proc:'))).toEqual([
      'proc:start:1', 'proc:end:1', 'proc:start:2', 'proc:end:2', 'proc:start:3', 'proc:end:3',
    ]);
    expect([...w.states.values()]).toEqual(['PROCESSED', 'PROCESSED', 'PROCESSED']);
    expect(processor.execute).toHaveBeenCalledWith(expect.anything(), { environment: 'production', client: expect.anything(), afterCommit: expect.any(Function) });
  });

  it('(b) linha PROCESSED não reprocessa: nem lock, nem transação, nem caso de uso', async () => {
    const w = buildWorld([row('i1', { state: 'PROCESSED' })], { i1: responsePayload('1') });
    const processor = { execute: jest.fn() };

    const r = await new ProcessTalentumInboxUseCase(w.pool as any, w.inbox, processor, { execute: jest.fn() }).execute('i1');

    expect(r.outcome).toBe('ALREADY_PROCESSED');
    expect(processor.execute).not.toHaveBeenCalled();
    expect(w.inbox.lockKey).not.toHaveBeenCalled();
    // A leitura da linha vai pelo client (T-095-30: 0 pool.query): abre e fecha a transação, sem lock nem marca.
    expect(w.events).toEqual(['c1:BEGIN', 'c1:COMMIT']);
  });

  it('linha inexistente → NOT_FOUND sem lançar (reentrega infinita não adianta)', async () => {
    const w = buildWorld([], {});
    const r = await new ProcessTalentumInboxUseCase(w.pool as any, w.inbox, { execute: jest.fn() }, { execute: jest.fn() }).execute('nada');
    expect(r.outcome).toBe('NOT_FOUND');
    expect(w.events).toEqual(['c1:BEGIN', 'c1:COMMIT']);
  });

  it('(c) erro marca FAILED só com code/constraint, relança o erro original e as marcas ficam duráveis (COMMIT antes do throw)', async () => {
    const rows = [row('i1'), row('i2'), row('i3')];
    const w = buildWorld(rows, { i1: responsePayload('1'), i2: responsePayload('2'), i3: responsePayload('3') });
    const pgErr = Object.assign(new Error('duplicate key value violates unique constraint (sintetico@example.test)'), { code: '23505', constraint: 'uq_x' });
    const processor = { execute: jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(pgErr) };

    await expect(
      new ProcessTalentumInboxUseCase(w.pool as any, w.inbox, processor, { execute: jest.fn() }).execute('i1'),
    ).rejects.toBe(pgErr);

    expect(w.states.get('i1')).toBe('PROCESSED');
    expect(w.states.get('i2')).toBe('FAILED');
    expect(w.states.get('i3')).toBe('RECEIVED'); // ordem: a mais nova espera a reentrega
    expect(w.errorCodes.get('i2')).toBe('code=23505 constraint=uq_x');
    expect(JSON.stringify([...w.errorCodes])).not.toContain('sintetico');
    expect(processor.execute).toHaveBeenCalledTimes(2);
    const log = w.events.join('|');
    expect(log).toContain('c1:ROLLBACK TO SAVEPOINT talentum_inbox_row');
    expect(log.indexOf('mark:i2:FAILED')).toBeLessThan(log.indexOf('c1:COMMIT'));
    expect(log).not.toContain('c1:ROLLBACK|'); // a transação externa NÃO faz rollback
  });

  it('reentrega de linha FAILED: ela entra no lote (alsoIds) e, ao passar, vira PROCESSED', async () => {
    const w = buildWorld([row('i1', { state: 'FAILED', attempts: 1 })], { i1: responsePayload('1') });
    const processor = { execute: jest.fn() };

    const r = await new ProcessTalentumInboxUseCase(w.pool as any, w.inbox, processor, { execute: jest.fn() }).execute('i1');

    expect(w.inbox.pendingForKey).toHaveBeenCalledWith(expect.anything(), K.p, K.c, ['i1']);
    expect(r).toMatchObject({ outcome: 'PROCESSED', processed: 1 });
    expect(w.states.get('i1')).toBe('PROCESSED');
  });

  it('UNSUPPORTED/REJECTED_SCHEMA: o push não reprocessa; o redrive (reprocess) sim', async () => {
    const mk = () => buildWorld([row('i1', { state: 'UNSUPPORTED' })], { i1: responsePayload('1') });
    const w1 = mk();
    const p1 = { execute: jest.fn() };
    expect((await new ProcessTalentumInboxUseCase(w1.pool as any, w1.inbox, p1, { execute: jest.fn() }).execute('i1')).outcome).toBe('SKIPPED');
    expect(p1.execute).not.toHaveBeenCalled();

    const w2 = mk();
    const p2 = { execute: jest.fn() };
    const r = await new ProcessTalentumInboxUseCase(w2.pool as any, w2.inbox, p2, { execute: jest.fn() }).execute('i1', { reprocess: true });
    expect(r).toMatchObject({ outcome: 'PROCESSED', processed: 1 });
    expect(p2.execute).toHaveBeenCalledTimes(1);
  });

  it('(d) o lock da chave ENVOLVE as transações do caso de uso: lock antes, COMMIT depois, e duas entregas da mesma chave não se sobrepõem', async () => {
    const w = buildWorld([row('i1'), row('i2', { receivedAt: new Date('2026-11-25T10:00:05Z') })], {
      i1: responsePayload('1'), i2: responsePayload('2'),
    });
    // cada execução do caso de uso abre a transação PRÓPRIA (BEGIN ... COMMIT) numa conexão que não é a do lock
    const processor = {
      execute: jest.fn(async (p: any) => {
        const own = await w.pool.connect();
        const tag = `own-${p.data.profile.phoneNumber}`;
        w.events.push(`${tag}:BEGIN`);
        await new Promise((r) => setTimeout(r, 15));
        w.events.push(`${tag}:COMMIT`);
        own.release();
      }),
    };
    const uc = new ProcessTalentumInboxUseCase(w.pool as any, w.inbox, processor, { execute: jest.fn() });

    // dois pushes concorrentes da MESMA chave (Pub/Sub entrega 2x)
    await Promise.all([uc.execute('i1'), uc.execute('i2')]);

    const ev = w.events.filter((e) => /:lock$|:COMMIT$|^own-.*:(BEGIN|COMMIT)$/.test(e) && !e.startsWith('mark'));
    const lock1 = ev.findIndex((e) => e.endsWith(':lock'));
    const firstExternalCommit = ev.findIndex((e, i) => i > lock1 && /^c\d+:COMMIT$/.test(e));
    const ownEvents = ev.slice(lock1, firstExternalCommit).filter((e) => e.startsWith('own-'));
    // tudo que o caso de uso fez (BEGIN/COMMIT próprios) cabe ENTRE o lock e o COMMIT externo da primeira entrega
    expect(ownEvents.length).toBeGreaterThanOrEqual(4);
    // o 2º lock só é tomado depois do COMMIT externo do 1º
    const secondLock = ev.findIndex((e, i) => i > lock1 && e.endsWith(':lock'));
    expect(secondLock).toBeGreaterThan(firstExternalCommit);
    // a 2ª entrega encontra tudo PROCESSED (a 1ª levou as duas linhas): o caso de uso rodou 2x no total
    expect(processor.execute).toHaveBeenCalledTimes(2);
  });

  it('(e) PRESCREENING (criação de vaga) → caso de uso de vaga com data + environment; o processador de resposta NÃO roda', async () => {
    const created = { action: 'PRESCREENING', subtype: 'CREATED', data: { _id: 'proj-1', name: 'CASO 9' } };
    const w = buildWorld([row('i1', { action: 'PRESCREENING', subtype: 'CREATED', talentumProfileId: null, environment: 'test' })], { i1: created });
    const processor = { execute: jest.fn() };
    const creator = { execute: jest.fn() };

    const r = await new ProcessTalentumInboxUseCase(w.pool as any, w.inbox, processor, creator).execute('i1');

    expect(creator.execute).toHaveBeenCalledWith({ _id: 'proj-1', name: 'CASO 9' }, 'test', expect.anything());
    expect(processor.execute).not.toHaveBeenCalled();
    expect(r.outcome).toBe('PROCESSED');
  });
});

describe('describeError', () => {
  it('erro do pg → só code/constraint; erro nosso → 1ª linha', () => {
    expect(describeError({ code: '23505', constraint: 'c', message: 'Key (email)=(x@y.z)' })).toBe('code=23505 constraint=c');
    expect(describeError(new Error('falhou\nstack'))).toBe('falhou');
  });
});
