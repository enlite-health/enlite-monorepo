/**
 * ProcessTalentumInboxUseCase.validacao.test.ts — T-095-32 (spec 095 §3.2/§3.4).
 *
 * O Zod completo saiu do ack e roda aqui: o que antes era 400 no controller agora vira estado da linha da inbox.
 *  - formato desconhecido (action/subtype fora do que se entende) → UNSUPPORTED, sem tentar o schema;
 *  - schema recusado → REJECTED_SCHEMA + reportError só com as CHAVES (nunca valores);
 *  - nenhum dos dois relança (o Pub/Sub não reentrega; o alarme da F4 cobre).
 * Cada `it` abaixo tem como par um caso do TalentumWebhookController.test.ts antigo (37, removidos no T-095-21),
 * na mesma ordem; o par vai no título entre colchetes ([N]).
 * Inbox, pool e casos de uso são dublês; payload sintético.
 */
jest.mock('@shared/logging', () => ({
  ...jest.requireActual('@shared/logging'),
  reportError: jest.fn(),
}));

import { reportError } from '@shared/logging';
import { ProcessTalentumInboxUseCase } from '../ProcessTalentumInboxUseCase';
import type { TalentumInboxRow } from '../../domain/TalentumInbox';
import { TalentumPrescreeningPayloadSchema } from '../../interfaces/webhooks/validators/talentumPrescreeningSchema';

const VALOR = 'VALOR-SENSIVEL-XYZ';

function responsePayload(o: Record<string, any> = {}) {
  return {
    action: 'PRESCREENING_RESPONSE',
    subtype: o.subtype ?? 'INITIATED',
    data: {
      prescreening: { id: 'tp-001', name: 'Test Case', ...(o.prescreening || {}) },
      profile: {
        id: 'prof-001', firstName: 'Test', lastName: 'User', email: 'test@example.com', phoneNumber: '+5491100000000',
        cuil: '20-12345678-9', registerQuestions: [], ...(o.profile || {}),
      },
      response: { id: 'resp-001', state: [], ...(o.response || {}) },
    },
  } as any;
}

const createdPayload = (_id = 'talentum-project-001') => ({ action: 'PRESCREENING', subtype: 'CREATED', data: { _id, name: 'Operario de producción' } });

async function run(payload: unknown, env: 'production' | 'test' = 'production') {
  const row: TalentumInboxRow = {
    id: 'i1', receivedAt: new Date('2026-11-25T10:00:00Z'), action: 'X', subtype: null, talentumPrescreeningId: 'tp-001',
    talentumProfileId: 'prof-001', environment: env, state: 'RECEIVED', attempts: 0, payloadEnc: 'ENC',
  };
  const inbox = {
    insertReceived: jest.fn(),
    findById: jest.fn(async () => row),
    lockKey: jest.fn(),
    pendingForKey: jest.fn(async () => [row]),
    decryptPayload: jest.fn(async () => payload),
    markProcessed: jest.fn(),
    markFailed: jest.fn(),
    markState: jest.fn(),
  };
  const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
  const pool = { connect: jest.fn(async () => client), query: jest.fn() };
  const processor = { execute: jest.fn().mockResolvedValue({ ok: true }) };
  const creator = { execute: jest.fn().mockResolvedValue({ created: true }) };
  const logSpy = jest.spyOn(console, 'log').mockImplementation();
  let thrown: unknown;
  let result: any;
  try {
    result = await new ProcessTalentumInboxUseCase(pool as any, inbox as any, processor, creator).execute('i1');
  } catch (e) {
    thrown = e;
  }
  const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  logSpy.mockRestore();
  return { inbox, processor, creator, thrown, result, logged };
}

beforeEach(() => jest.clearAllMocks());

function expectSettled(r: Awaited<ReturnType<typeof run>>, state: 'UNSUPPORTED' | 'REJECTED_SCHEMA') {
  expect(r.thrown).toBeUndefined();
  expect(r.inbox.markState).toHaveBeenCalledWith(expect.anything(), 'i1', state, expect.any(String));
  expect(r.inbox.markProcessed).not.toHaveBeenCalled();
  expect(r.inbox.markFailed).not.toHaveBeenCalled();
  expect(r.processor.execute).not.toHaveBeenCalled();
  expect(r.creator.execute).not.toHaveBeenCalled();
}

describe('UNSUPPORTED: formato desconhecido (não tenta o schema)', () => {
  it('[1] body vazio {} → UNSUPPORTED (action ausente), sem relançar', async () => {
    expectSettled(await run({}), 'UNSUPPORTED');
  });
  it('[2] body null → UNSUPPORTED', async () => {
    expectSettled(await run(null), 'UNSUPPORTED');
  });
  it('[3] body undefined → UNSUPPORTED', async () => {
    expectSettled(await run(undefined), 'UNSUPPORTED');
  });
  it('[4] sem action → UNSUPPORTED', async () => {
    expectSettled(await run({ subtype: 'CREATED', data: { _id: 'x', name: 'y' } }), 'UNSUPPORTED');
  });
  it('[5] PRESCREENING sem subtype → UNSUPPORTED', async () => {
    expectSettled(await run({ action: 'PRESCREENING', data: { _id: 'x', name: 'y' } }), 'UNSUPPORTED');
  });
  it('[6] combinação inválida (PRESCREENING + ANALYZED) → UNSUPPORTED', async () => {
    expectSettled(await run({ action: 'PRESCREENING', subtype: 'ANALYZED', data: { _id: 'x', name: 'y' } }), 'UNSUPPORTED');
  });
  it('subtype novo de PRESCREENING_RESPONSE (fora do enum) → UNSUPPORTED sem tentar o schema e sem reportError', async () => {
    const r = await run(responsePayload({ subtype: 'ALGO_NOVO' }));
    expectSettled(r, 'UNSUPPORTED');
    expect(r.inbox.markState).toHaveBeenCalledWith(expect.anything(), 'i1', 'UNSUPPORTED', 'UNSUPPORTED_SUBTYPE');
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe('REJECTED_SCHEMA: schema completo recusado', () => {
  it('[7] prescreening.id ausente → REJECTED_SCHEMA', async () => {
    const p = responsePayload();
    delete p.data.prescreening.id;
    expectSettled(await run(p), 'REJECTED_SCHEMA');
  });
  it('[8] prescreening.id string vazia → REJECTED_SCHEMA', async () => {
    expectSettled(await run(responsePayload({ prescreening: { id: '' } })), 'REJECTED_SCHEMA');
  });
  it('[9] e-mail inválido → REJECTED_SCHEMA', async () => {
    expectSettled(await run(responsePayload({ profile: { email: 'not-an-email' } })), 'REJECTED_SCHEMA');
  });
  it('[10] profile ausente → REJECTED_SCHEMA', async () => {
    const p = responsePayload();
    delete p.data.profile;
    expectSettled(await run(p), 'REJECTED_SCHEMA');
  });
  it('[11] response ausente → REJECTED_SCHEMA', async () => {
    const p = responsePayload();
    delete p.data.response;
    expectSettled(await run(p), 'REJECTED_SCHEMA');
  });
  it('[12] campo extra dentro de prescreening (strict) → REJECTED_SCHEMA + reportError só com as chaves, nenhum valor do payload', async () => {
    const p = responsePayload({ response: { statusLabel: VALOR } });
    p.data.prescreening.extraField = VALOR;
    const r = await run(p);

    expectSettled(r, 'REJECTED_SCHEMA');
    expect(reportError).toHaveBeenCalledTimes(1);
    const [err, ctx] = (reportError as jest.Mock).mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toMatchObject({ kind: 'TALENTUM_PAYLOAD_REJECTED', inboxId: 'i1', paths: ['data'] });
    // nenhum valor do payload (nem e-mail, telefone, nome, CUIL, nem o valor inválido) em reportError, log ou error_code
    const everything = JSON.stringify([(reportError as jest.Mock).mock.calls, r.inbox.markState.mock.calls, r.logged, (err as Error).message]);
    for (const v of [VALOR, 'test@example.com', '+5491100000000', '20-12345678-9', 'Test Case', 'User']) {
      expect(everything).not.toContain(v);
    }
  });
  it('[15] o detalhe do erro Zod não vai ao ack: sai como `paths` (só chaves de primeiro nível) no alarme', async () => {
    await run({ action: 'PRESCREENING_RESPONSE', subtype: 'INITIATED', data: { prescreening: { id: 'a' } } });
    const [, ctx] = (reportError as jest.Mock).mock.calls[0];
    expect(Array.isArray(ctx.paths)).toBe(true);
    expect(ctx.paths.every((k: unknown) => typeof k === 'string')).toBe(true);
    expect(ctx).not.toHaveProperty('details');
  });
  it('[34] registerQuestion com questionId vazio → REJECTED_SCHEMA', async () => {
    const r = await run(responsePayload({ profile: { registerQuestions: [{ questionId: '', question: 'Test?', answer: 'yes', responseType: 'TEXT' }] } }));
    expectSettled(r, 'REJECTED_SCHEMA');
  });
  it('[35] registerQuestion com campo extra (strict) → REJECTED_SCHEMA', async () => {
    const r = await run(responsePayload({ profile: { registerQuestions: [{ questionId: 'q1', question: 'Test?', answer: 'yes', responseType: 'TEXT', extra: 'nope' }] } }));
    expectSettled(r, 'REJECTED_SCHEMA');
  });
  it('[37] response.state com item de question vazia → REJECTED_SCHEMA', async () => {
    const r = await run(responsePayload({ response: { state: [{ questionId: 'q1', question: '', answer: 'yes', responseType: 'TEXT' }] } }));
    expectSettled(r, 'REJECTED_SCHEMA');
  });
});

describe('aceitos: o schema deixa passar e o caso de uso chama o processador', () => {
  const processed = (r: Awaited<ReturnType<typeof run>>) => {
    expect(r.thrown).toBeUndefined();
    expect(r.inbox.markProcessed).toHaveBeenCalledWith(expect.anything(), 'i1');
    expect(r.inbox.markState).not.toHaveBeenCalled();
  };
  it('[13] cuil ausente (opcional) → processa', async () => {
    const p = responsePayload();
    delete p.data.profile.cuil;
    const r = await run(p);
    processed(r);
    expect(r.processor.execute.mock.calls[0][0].data.profile.cuil).toBeUndefined();
  });
  it('[14] todos os subtypes válidos de PRESCREENING_RESPONSE → processa cada um', async () => {
    for (const subtype of ['INITIATED', 'IN_PROGRESS', 'COMPLETED', 'ANALYZED']) {
      const r = await run(responsePayload({ subtype }));
      processed(r);
      expect(r.processor.execute.mock.calls[0][0].subtype).toBe(subtype);
    }
  });
  it('[16] e-mail é normalizado para minúsculas antes do caso de uso', async () => {
    const r = await run(responsePayload({ profile: { email: 'Test@EXAMPLE.com' } }));
    processed(r);
    expect(r.processor.execute.mock.calls[0][0].data.profile.email).toBe('test@example.com');
  });
  it('[17] e-mail com Unicode no local-part (RFC 6531) → processa', async () => {
    const r = await run(responsePayload({ profile: { email: 'maría.redondo@bue.edu.ar' } }));
    processed(r);
    expect(r.processor.execute.mock.calls[0][0].data.profile.email).toBe('maría.redondo@bue.edu.ar');
  });
  it('[18] registerQuestions ausente → default []', async () => {
    const p = responsePayload();
    delete p.data.profile.registerQuestions;
    const r = await run(p);
    processed(r);
    expect(r.processor.execute.mock.calls[0][0].data.profile.registerQuestions).toEqual([]);
  });
  it('[19] response.state ausente → default []', async () => {
    const p = responsePayload();
    delete p.data.response.state;
    const r = await run(p);
    processed(r);
    expect(r.processor.execute.mock.calls[0][0].data.response.state).toEqual([]);
  });
  it('response.source (marcador de mudança manual, T-095-33) é aceito e chega ao caso de uso', async () => {
    const r = await run(responsePayload({ subtype: 'ANALYZED', response: { statusLabel: 'QUALIFIED', source: 'MANUAL' } }));
    processed(r);
    expect(r.processor.execute.mock.calls[0][0].data.response.source).toBe('MANUAL');
  });
  it('expiração (T-095-34): subtype EXPIRED e statusLabel EXPIRED são aceitos e chegam ao caso de uso', async () => {
    const r1 = await run(responsePayload({ subtype: 'EXPIRED' }));
    processed(r1);
    expect(r1.processor.execute.mock.calls[0][0].subtype).toBe('EXPIRED');
    const r2 = await run(responsePayload({ subtype: 'ANALYZED', response: { statusLabel: 'EXPIRED' } }));
    processed(r2);
    expect(r2.processor.execute.mock.calls[0][0].data.response.statusLabel).toBe('EXPIRED');
  });
  it('[36] answer vazia em registerQuestion → processa', async () => {
    const r = await run(responsePayload({ profile: { registerQuestions: [{ questionId: 'q1', question: 'Test?', answer: '', responseType: 'TEXT' }] } }));
    processed(r);
  });
});

describe('roteamento por action e propagação de environment', () => {
  it('[20] PRESCREENING.CREATED chama o caso de uso de vaga (e só ele)', async () => {
    const r = await run(createdPayload());
    expect(r.creator.execute).toHaveBeenCalledWith({ _id: 'talentum-project-001', name: 'Operario de producción' }, 'production', expect.anything());
    expect(r.processor.execute).not.toHaveBeenCalled();
    expect(r.inbox.markProcessed).toHaveBeenCalled();
  });
  it('[21] PRESCREENING_RESPONSE chama o ProcessTalentumPrescreening (e só ele)', async () => {
    const r = await run(responsePayload());
    expect(r.processor.execute).toHaveBeenCalledTimes(1);
    expect(r.creator.execute).not.toHaveBeenCalled();
  });
  it('[22] environment=production na linha → production no caso de uso', async () => {
    const r = await run(responsePayload(), 'production');
    expect(r.processor.execute).toHaveBeenCalledWith(expect.anything(), { environment: 'production', client: expect.anything(), afterCommit: expect.any(Function) });
  });
  it('[23] environment=test na linha → test no caso de uso (e no de vaga)', async () => {
    const r1 = await run(responsePayload(), 'test');
    expect(r1.processor.execute).toHaveBeenCalledWith(expect.anything(), { environment: 'test', client: expect.anything(), afterCommit: expect.any(Function) });
    const r2 = await run(createdPayload(), 'test');
    expect(r2.creator.execute).toHaveBeenCalledWith(expect.anything(), 'test', expect.anything());
  });
  // [24] e [25] (partnerContext ausente / isTest indefinido → production) são do ACK: o default é gravado na coluna
  // `environment` da inbox. Cobertos em TalentumWebhookController.test.ts (test.each "propagação de environment").
});

describe('falha do caso de uso: FAILED + relança, sem PII no error_code', () => {
  it('[26] caso de uso lança → linha FAILED e o erro original é relançado (o push responde 5xx)', async () => {
    const err = new Error('DB connection refused');
    const r = await runFailing(responsePayload(), err);
    expect(r.thrown).toBe(err);
    expect(r.inbox.markFailed).toHaveBeenCalledWith(expect.anything(), 'i1', 'DB connection refused');
  });
  it('[27] a mensagem de um erro do pg nunca chega ao error_code (só code/constraint)', async () => {
    const err = Object.assign(new Error('FATAL: password authentication failed for user x'), { code: '28P01' });
    const r = await runFailing(responsePayload(), err);
    expect(r.inbox.markFailed).toHaveBeenCalledWith(expect.anything(), 'i1', 'code=28P01');
    expect(JSON.stringify(r.inbox.markFailed.mock.calls)).not.toContain('password');
  });
  it('[28] o log da falha traz a chave externa (talentumPrescreeningId) e o inboxId, nunca e-mail/telefone/nome', async () => {
    const r = await runFailing(responsePayload({ prescreening: { id: 'external-tp-999' } }), new Error('timeout'));
    expect(r.logged).toContain('inboxId=i1');
    expect(r.logged).toContain('talentumPrescreeningId=tp-001');
    for (const v of ['test@example.com', '+5491100000000', 'Test', 'User']) expect(r.logged).not.toContain(v);
  });
  it('[29] caso de uso de vaga lança → FAILED + relança', async () => {
    const err = new Error('DB error');
    const r = await runFailing(createdPayload(), err, 'creator');
    expect(r.thrown).toBe(err);
    expect(r.inbox.markFailed).toHaveBeenCalledWith(expect.anything(), 'i1', 'DB error');
  });
  it('[32] lança valor não-Error (string) → FAILED com o texto, relança o valor', async () => {
    const r = await runFailing(responsePayload(), 'raw string error');
    expect(r.thrown).toBe('raw string error');
    expect(r.inbox.markFailed).toHaveBeenCalledWith(expect.anything(), 'i1', 'raw string error');
  });
  it('[33] caso de uso de vaga lança valor não-Error (42) → FAILED, relança', async () => {
    const r = await runFailing(createdPayload(), 42, 'creator');
    expect(r.thrown).toBe(42);
    expect(r.inbox.markFailed).toHaveBeenCalledWith(expect.anything(), 'i1', '42');
  });
});

describe('resultado de execute (o que o push/redrive devolve; contagens, sem corpo)', () => {
  it('[30] PRESCREENING_RESPONSE → { inboxId, outcome: PROCESSED, processed: 1 }, sem dado do payload', async () => {
    const r = await run(responsePayload());
    expect(r.result).toEqual({ inboxId: 'i1', outcome: 'PROCESSED', processed: 1 });
  });
  it('[31] PRESCREENING.CREATED → o mesmo formato', async () => {
    const r = await run(createdPayload());
    expect(r.result).toEqual({ inboxId: 'i1', outcome: 'PROCESSED', processed: 1 });
  });
});

describe('schema (unit, sem o caso de uso)', () => {
  it('o discriminated union aceita só as duas variantes e exige o subtype literal de cada uma', () => {
    expect(TalentumPrescreeningPayloadSchema.safeParse(createdPayload()).success).toBe(true);
    expect(TalentumPrescreeningPayloadSchema.safeParse(responsePayload()).success).toBe(true);
    expect(TalentumPrescreeningPayloadSchema.safeParse({ action: 'PRESCREENING', subtype: 'ANALYZED', data: { _id: 'x', name: 'y' } }).success).toBe(false);
  });
});

async function runFailing(payload: unknown, error: unknown, which: 'processor' | 'creator' = 'processor') {
  // reaproveita `run`, mas com o dublê escolhido rejeitando
  const row: TalentumInboxRow = {
    id: 'i1', receivedAt: new Date(), action: 'X', subtype: null, talentumPrescreeningId: 'tp-001', talentumProfileId: 'prof-001',
    environment: 'production', state: 'RECEIVED', attempts: 0, payloadEnc: 'ENC',
  };
  const inbox = {
    insertReceived: jest.fn(), findById: jest.fn(async () => row), lockKey: jest.fn(), pendingForKey: jest.fn(async () => [row]),
    decryptPayload: jest.fn(async () => payload), markProcessed: jest.fn(), markFailed: jest.fn(), markState: jest.fn(),
  };
  const client = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
  const pool = { connect: jest.fn(async () => client), query: jest.fn() };
  const processor = { execute: jest.fn().mockImplementation(() => (which === 'processor' ? Promise.reject(error) : Promise.resolve())) };
  const creator = { execute: jest.fn().mockImplementation(() => (which === 'creator' ? Promise.reject(error) : Promise.resolve())) };
  const logSpy = jest.spyOn(console, 'log').mockImplementation();
  let thrown: unknown;
  try {
    await new ProcessTalentumInboxUseCase(pool as any, inbox as any, processor, creator).execute('i1');
  } catch (e) {
    thrown = e;
  }
  const logged = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
  logSpy.mockRestore();
  return { inbox, thrown, logged };
}
