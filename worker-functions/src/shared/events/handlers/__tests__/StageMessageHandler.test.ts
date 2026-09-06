/**
 * StageMessageHandler.test.ts — a mensagem por etapa (DEC-12), guard a guard (lex 29/08).
 * Régua: as queries e a ordem (mocks puros); a trilha em funnel_stage_message_log.
 */
jest.mock('../../../logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), child: jest.fn() },
  reportError: jest.fn(),
  loggingAls: { run: jest.fn((_: unknown, fn: () => unknown) => fn()), getStore: jest.fn() },
}));

import { createStageMessageHandler, STAGE_MESSAGE_COOLDOWN } from '../StageMessageHandler';

type Q = jest.Mock;
const payload = { workerId: 'w1', jobPostingId: 'j1', source: 'kanban', actorUid: 'staff-1', previousStage: 'INVITED' };
const vacancyRow = { case_number: 42, country: 'AR' };
const workerRow = { id: 'w1', status: 'REGISTERED', country: 'AR', opted_out: false };
const configOn = { template_slug: 'qualified_reprogram_confirm', enabled: true, builtin: null, body: 'Caso {{case_number}} — {{worker_name}}', category: 'UTILITY', is_active: true };

function program(q: Q, opts: { vacancy?: unknown[]; worker?: unknown[]; config?: unknown[] } = {}): void {
  q.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM job_postings')) return { rows: opts.vacancy ?? [vacancyRow] };
    if (sql.includes('FROM workers')) return { rows: opts.worker ?? [workerRow] };
    if (sql.includes('FROM funnel_stage_messages')) return { rows: opts.config ?? [configOn] };
    if (sql.includes('INSERT INTO funnel_stage_message_log')) return { rows: [] };
    throw new Error(`pool query inesperada: ${sql.slice(0, 50)}`);
  });
}

function makeDb(q: Q, client: { query: jest.Mock; release: jest.Mock }) {
  return { query: q, connect: jest.fn().mockResolvedValue(client) };
}
function makeClient(dup: unknown[] = []) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM funnel_stage_message_log')) return { rows: dup };
    if (sql.includes('INSERT INTO messaging_outbox')) return { rows: [{ id: 'outbox-1' }] };
    return { rows: [] };
  });
  return { query, release: jest.fn() };
}
const logInsert = (q: Q) => q.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO funnel_stage_message_log'));

describe('StageMessageHandler', () => {
  let q: Q; let client: ReturnType<typeof makeClient>; let pubsub: { publish: jest.Mock }; let token: { generate: jest.Mock };
  const handler = (stage = 'COMPLETED') => createStageMessageHandler(makeDb(q, client) as never, pubsub as never, token as never, stage);

  beforeEach(() => {
    q = jest.fn(); client = makeClient(); pubsub = { publish: jest.fn().mockResolvedValue(null) }; token = { generate: jest.fn().mockResolvedValue('tk_name') };
  });

  it('feliz: etapa ligada com template elegível → outbox com variáveis da allowlist (nome como TOKEN), log queued com autoria, pubsub', async () => {
    program(q);
    await handler()(payload);
    const outboxCall = client.query.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO messaging_outbox')) as unknown as [string, unknown[]];
    expect(outboxCall[1]).toEqual(['w1', 'j1', 'qualified_reprogram_confirm', JSON.stringify({ case_number: '42', worker_name: 'tk_name' })]);
    expect(token.generate).toHaveBeenCalledWith('w1', 'worker_name');
    const logCall = client.query.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO funnel_stage_message_log')) as unknown as [string, unknown[]];
    expect(logCall[1]).toEqual(['w1', 'j1', 'COMPLETED', 'qualified_reprogram_confirm', 'staff-1', 'outbox-1', 'AR']);
    expect(client.query).toHaveBeenCalledWith('BEGIN');
    expect(client.query.mock.calls.some((c) => (c[0] as string).includes('pg_advisory_xact_lock'))).toBe(true);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
    expect(pubsub.publish).toHaveBeenCalledWith('outbox-enqueued', { outboxId: 'outbox-1' });
    // a config é lida por PAÍS da vaga
    const cfg = q.mock.calls.find((c) => (c[0] as string).includes('FROM funnel_stage_messages')) as unknown as [string, unknown[]];
    expect(cfg[1]).toEqual(['AR', 'COMPLETED']);
  });

  it('template sem placeholder → variables {} e sem chamada ao TokenService', async () => {
    program(q, { config: [{ ...configOn, body: 'Sin variables' }] });
    await handler()(payload);
    expect(token.generate).not.toHaveBeenCalled();
    const outboxCall = client.query.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO messaging_outbox')) as unknown as [string, unknown[]];
    expect(outboxCall[1][3]).toBe('{}');
  });

  describe('pulos contáveis (funnel_stage_message_log)', () => {
    const expectSkip = (reason: string, over: Partial<{ worker: unknown; job: unknown }> = {}) => {
      const call = logInsert(q) as unknown as [string, unknown[]];
      expect(call).toBeDefined();
      // status 'skipped' e outbox NULL vão no SQL (o helper só pula — B2 do gate 30/08); o motivo é o $7
      expect(call[0]).toContain("NULL, 'skipped', $7, $8");
      expect(call[1]).toHaveLength(8);
      expect(call[1][6]).toBe(reason);
      if (over.worker !== undefined) expect(call[1][0]).toBe(over.worker);
      if (over.job !== undefined) expect(call[1][1]).toBe(over.job);
      expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO messaging_outbox'), expect.anything());
      expect(pubsub.publish).not.toHaveBeenCalled();
    };

    it('evento que não veio do Kanban (Talentum audit-only) → SOURCE_NOT_HUMAN (lex C9)', async () => {
      program(q);
      await handler('REJECTED')({ ...payload, source: 'talentum' });
      expectSkip('SOURCE_NOT_HUMAN');
      const call = logInsert(q) as unknown as [string, unknown[]];
      expect(call[1][5]).toBe('talentum');
      await handler('REJECTED')({ ...payload, source: undefined });
    });

    it('vaga inexistente → VACANCY_NOT_FOUND (país do worker); worker inexistente → WORKER_NOT_FOUND', async () => {
      program(q, { vacancy: [] });
      await handler()(payload);
      expectSkip('VACANCY_NOT_FOUND', { job: null });
      q.mockReset(); client = makeClient(); pubsub.publish.mockClear();
      program(q, { worker: [] });
      await handler()(payload);
      expectSkip('WORKER_NOT_FOUND', { worker: null });
    });

    it('vaga E worker desconhecidos → só log, nenhuma linha (país indeterminado)', async () => {
      program(q, { vacancy: [], worker: [] });
      await handler()(payload);
      expect(logInsert(q)).toBeUndefined();
      expect(q.mock.calls.some((c) => (c[0] as string).includes('FROM funnel_stage_messages'))).toBe(false);
    });

    it('worker de outro país → COUNTRY_BLOCKED (lex C10 — L3 aberto); worker sem país herda o da vaga', async () => {
      program(q, { worker: [{ ...workerRow, country: 'BR' }] });
      await handler()(payload);
      expectSkip('COUNTRY_BLOCKED');
      q.mockReset(); client = makeClient(); pubsub.publish.mockClear();
      // worker.country null + vaga BR → bloqueado pelo país da VAGA; sem ator (payload sem actorUid) → actor_uid null
      program(q, { vacancy: [{ ...vacancyRow, country: 'BR' }], worker: [{ ...workerRow, country: null }] });
      await handler()({ ...payload, actorUid: undefined });
      expectSkip('COUNTRY_BLOCKED');
      expect((logInsert(q) as unknown as [string, unknown[]])[1][4]).toBeNull();
    });

    it('etapa desligada / sem linha / built-in → DISABLED (o estado padrão, não é erro)', async () => {
      program(q, { config: [{ ...configOn, enabled: false }] });
      await handler()(payload); expectSkip('DISABLED');
      q.mockReset(); client = makeClient(); program(q, { config: [] });
      await handler()(payload); expectSkip('DISABLED');
      q.mockReset(); client = makeClient(); program(q, { config: [{ ...configOn, builtin: 'interview_invite' }] });
      await handler('QUALIFIED')(payload); expectSkip('DISABLED');
    });

    it('ligada sem template → NO_TEMPLATE; template inativo → TEMPLATE_INACTIVE; MARKETING/deny-list/posicional → TEMPLATE_NOT_ALLOWED', async () => {
      program(q, { config: [{ ...configOn, template_slug: null }] });
      await handler()(payload); expectSkip('NO_TEMPLATE');
      q.mockReset(); client = makeClient(); program(q, { config: [{ ...configOn, is_active: false }] });
      await handler()(payload); expectSkip('TEMPLATE_INACTIVE');
      for (const bad of [{ category: 'MARKETING' }, { template_slug: 'complete_register_utility_v2' }, { body: 'Hola {{1}}' }]) {
        q.mockReset(); client = makeClient(); program(q, { config: [{ ...configOn, ...bad }] });
        await handler()(payload); expectSkip('TEMPLATE_NOT_ALLOWED');
      }
    });

    it('worker DISABLED → WORKER_DISABLED (lex C3-bis); opt-out → OPT_OUT com o predicado único (lex C2)', async () => {
      program(q, { worker: [{ ...workerRow, status: 'DISABLED' }] });
      await handler()(payload); expectSkip('WORKER_DISABLED');
      q.mockReset(); client = makeClient(); program(q, { worker: [{ ...workerRow, opted_out: true }] });
      await handler()(payload); expectSkip('OPT_OUT');
      const workerSql = q.mock.calls.find((c) => (c[0] as string).includes('FROM workers'))![0] as string;
      expect(workerSql).toMatch(/messaging_opt_out moo/);
      expect(workerSql).toMatch(/opted_in_at IS NULL/);
    });

    it('mesma etapa já enviada nos últimos 7 dias → ALREADY_SENT dentro da transação com lock (lex C3)', async () => {
      program(q); client = makeClient([{ id: 'log-old' }]);
      await handler()(payload);
      expectSkip('ALREADY_SENT');
      const dupSql = client.query.mock.calls.find((c) => (c[0] as string).includes('FROM funnel_stage_message_log'))![0] as string;
      expect(dupSql).toContain(`INTERVAL '${STAGE_MESSAGE_COOLDOWN}'`);
      expect(dupSql).toContain("status = 'queued'");
      expect(client.query).toHaveBeenCalledWith('COMMIT');
    });
  });

  it('erro dentro da transação → ROLLBACK, release e propaga (o processor marca failed)', async () => {
    program(q);
    client.query.mockImplementation(async (sql: string) => { if (sql.includes('INSERT INTO messaging_outbox')) throw new Error('db down'); return { rows: [] }; });
    await expect(handler()(payload)).rejects.toThrow('db down');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
    expect(pubsub.publish).not.toHaveBeenCalled();
  });
});

describe('a mensagem que sai é a que está ESCOLHIDA agora (DEC-12)', () => {
  const outboxInsert = (c: { query: jest.Mock }) => c.query.mock.calls.find((k) => (k[0] as string).includes('INSERT INTO messaging_outbox'));
  const trilhaInsert = (c: { query: jest.Mock }) => c.query.mock.calls.find((k) => (k[0] as string).includes('INSERT INTO funnel_stage_message_log'));
  const doubles = () => ({ pubsub: { publish: jest.fn().mockResolvedValue(null) }, token: { generate: jest.fn().mockResolvedValue('tk_name') } });

  it('trocar o template na config troca o slug enfileirado — sem reiniciar o handler', async () => {
    const q = jest.fn() as Q;
    const client = makeClient();
    const { pubsub, token } = doubles();
    const handler = createStageMessageHandler(makeDb(q, client) as never, pubsub as never, token as never, 'COMPLETED');

    program(q, { config: [{ ...configOn, template_slug: 'tpl_antigo' }] });
    await handler(payload);
    expect(outboxInsert(client)![1][2]).toBe('tpl_antigo');

    // Mesmo handler, mesma instância: só o banco mudou (foi o que o painel gravou).
    client.query.mockClear();
    program(q, { config: [{ ...configOn, template_slug: 'tpl_novo' }] });
    await handler({ ...payload, workerId: 'w2' });
    expect(outboxInsert(client)![1][2]).toBe('tpl_novo');
  });

  it('o slug do outbox, o da trilha e o da config são o MESMO — não há default escondido', async () => {
    const q = jest.fn() as Q;
    const client = makeClient();
    const { pubsub, token } = doubles();
    program(q, { config: [{ ...configOn, template_slug: 'tpl_escolhido' }] });
    await createStageMessageHandler(makeDb(q, client) as never, pubsub as never, token as never, 'COMPLETED')(payload);

    const outbox = outboxInsert(client)!;
    const trilha = trilhaInsert(client)!;
    expect(outbox[1][2]).toBe('tpl_escolhido');
    expect(trilha[1][3]).toBe('tpl_escolhido');
  });

  it('template cujo corpo aprovado pede mais slots do que sabemos preencher NÃO é enfileirado — com razão PRÓPRIA, não silêncio', async () => {
    const q = jest.fn() as Q;
    const client = makeClient();
    const { pubsub, token } = doubles();
    program(q, { config: [{ ...configOn, template_slug: 'ar_finalize_signup_luz', body: '(ver Twilio Content Builder: HX54d6)', body_twilio: 'Hola {{1}}, falta {{2}}' }] });
    await createStageMessageHandler(makeDb(q, client) as never, pubsub as never, token as never, 'COMPLETED')(payload);

    expect(outboxInsert(client)).toBeUndefined();
    // Razão própria: é a única que pode aparecer DEPOIS de a etapa estar ligada,
    // então confundi-la com 'nunca foi permitido' esconderia uma etapa que parou.
    expect((logInsert(q) as unknown as [string, unknown[]])[1][6]).toBe('TEMPLATE_SLOT_MISMATCH');
  });
});
