/**
 * InvitePresentationMeetingUseCase.test.ts — guard a guard (lex 29/08: C1 vínculo, C2 país×telefone,
 * C8 opt-out predicado único, idempotência sob lock). Régua: queries e ordem (mocks puros) + trilha.
 */
jest.mock('../../../../shared/logging', () => ({
  logger: { child: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  reportError: jest.fn(),
}));

import { InvitePresentationMeetingUseCase, PRESENTATION_INVITE_COOLDOWN, PRESENTATION_INVITE_POLICY } from '../InvitePresentationMeetingUseCase';
import { evaluateTemplateEligibility } from '../StageTemplateEligibility';

type Q = jest.Mock;
const input = { workerId: 'w1', jobPostingId: 'j1', actorUid: 'staff-1', source: 'kanban' as const };
const workerRow = { id: 'w1', status: 'REGISTERED', country: 'AR', opted_out: false, phone_ar: true, has_link: true };
const cfgOn = { enabled: true, meet_link: 'https://meet.google.com/abc-defg-hij', schedule_label: 'Martes 18:00', template_slug: 'ar_presentacion_invite', body: 'Hola {{worker_name}} {{schedule_label}} {{meet_link}} BAJA', category: 'UTILITY', is_active: true };

function program(q: Q, opts: { worker?: unknown[]; cfg?: unknown[] } = {}): void {
  q.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM workers')) return { rows: opts.worker ?? [workerRow] };
    if (sql.includes('FROM presentation_invite_settings')) return { rows: opts.cfg ?? [cfgOn] };
    if (sql.includes('INSERT INTO presentation_invite_log')) return { rows: [] };
    throw new Error(`pool query inesperada: ${sql.slice(0, 50)}`);
  });
}
function makeClient(dup: unknown[] = []) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM presentation_invite_log')) return { rows: dup };
    if (sql.includes('INSERT INTO messaging_outbox')) return { rows: [{ id: 'outbox-1' }] };
    return { rows: [] };
  });
  return { query, release: jest.fn() };
}
const logInsert = (q: Q) => q.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO presentation_invite_log')) as unknown as [string, unknown[]] | undefined;

describe('InvitePresentationMeetingUseCase', () => {
  let q: Q; let client: ReturnType<typeof makeClient>; let pubsub: { publish: jest.Mock }; let tokens: { generate: jest.Mock };
  const uc = () => new InvitePresentationMeetingUseCase({ query: q, connect: jest.fn().mockResolvedValue(client) } as never, tokens as never, pubsub as never);

  beforeEach(() => {
    q = jest.fn(); client = makeClient(); pubsub = { publish: jest.fn().mockResolvedValue(null) }; tokens = { generate: jest.fn().mockResolvedValue('tk_name') };
  });

  it('PRESENTATION_INVITE_POLICY: a MESMA triagem das mensagens por etapa, com link+horário na allowlist, BAJA obrigatória e INATIVO por último', () => {
    const t = { slug: 'complete_register_x', body: 'Hola {{ worker_name }} {{schedule_label}} {{meet_link}} {{worker_name}} BAJA', category: 'UTILITY', is_active: false };
    expect(evaluateTemplateEligibility(t, PRESENTATION_INVITE_POLICY)).toEqual({ eligible: false, reason: 'INACTIVE', placeholders: ['worker_name', 'schedule_label', 'meet_link'], unsupported: [] });
    expect(evaluateTemplateEligibility({ ...t, is_active: true }, PRESENTATION_INVITE_POLICY).eligible).toBe(true); // deny-list de slug não se aplica aqui
    expect(evaluateTemplateEligibility({ ...t, body: 'Hola {{case_number}} BAJA' }, PRESENTATION_INVITE_POLICY).reason).toBe('PLACEHOLDERS');
    expect(evaluateTemplateEligibility({ ...t, body: 'Hola {{meet_link}}' }, PRESENTATION_INVITE_POLICY).reason).toBe('OPT_OUT_CLAUSE');
  });

  it('feliz: outbox com nome TOKENIZADO + link + rótulo, log queued com autoria/origem/vaga, lock, pubsub', async () => {
    program(q);
    const r = await uc().execute(input);
    expect(r).toEqual({ status: 'queued', outboxId: 'outbox-1' });
    const outbox = client.query.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO messaging_outbox')) as unknown as [string, unknown[]];
    expect(outbox[1]).toEqual(['w1', 'j1', 'ar_presentacion_invite', JSON.stringify({ worker_name: 'tk_name', schedule_label: 'Martes 18:00', meet_link: 'https://meet.google.com/abc-defg-hij' })]);
    expect(tokens.generate).toHaveBeenCalledWith('w1', 'worker_name');
    const log = client.query.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO presentation_invite_log')) as unknown as [string, unknown[]];
    expect(log[1]).toEqual(['w1', 'j1', 'staff-1', 'kanban', 'ar_presentacion_invite', 'outbox-1', 'AR']);
    expect(client.query.mock.calls.some((c) => (c[0] as string).includes('pg_advisory_xact_lock'))).toBe(true);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalled();
    expect(pubsub.publish).toHaveBeenCalledWith('outbox-enqueued', { outboxId: 'outbox-1' });
    // C8: predicado único de opt-out na query do worker
    const wsql = q.mock.calls.find((c) => (c[0] as string).includes('FROM workers'))![0] as string;
    expect(wsql).toMatch(/messaging_opt_out moo/); expect(wsql).toMatch(/opted_in_at IS NULL/);
    // C1: vínculo = aceite próprio E não importada
    expect(wsql).toMatch(/privacy_accepted_at IS NOT NULL/); expect(wsql).toMatch(/@enlite\.import/); expect(wsql).toMatch(/base1import/);
  });

  it('sem vaga → job null; rótulo com espaços em volta vai aparado; template sem {{schedule_label}} ignora o rótulo', async () => {
    program(q, { cfg: [{ ...cfgOn, schedule_label: '  Martes 18:00  ' }] });
    await uc().execute({ ...input, jobPostingId: null });
    const outbox = client.query.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO messaging_outbox')) as unknown as [string, unknown[]];
    expect(outbox[1][1]).toBeNull();
    expect(JSON.parse(outbox[1][3] as string).schedule_label).toBe('Martes 18:00');
    q.mockReset(); client = makeClient();
    program(q, { cfg: [{ ...cfgOn, schedule_label: null, body: 'Hola {{name}} {{meet_link}} BAJA' }] });
    const r = await uc().execute(input);
    expect(r.status).toBe('queued');
    const ob2 = client.query.mock.calls.find((c) => (c[0] as string).includes('INSERT INTO messaging_outbox')) as unknown as [string, unknown[]];
    expect(JSON.parse(ob2[1][3] as string)).toEqual({ name: 'tk_name', meet_link: 'https://meet.google.com/abc-defg-hij' });
  });

  describe('pulos contáveis', () => {
    const expectSkip = async (reason: string, over: { worker?: unknown[]; cfg?: unknown[] } = {}, extra?: (call: [string, unknown[]]) => void) => {
      q.mockReset(); client = makeClient(); pubsub.publish.mockClear(); program(q, over);
      const r = await uc().execute(input);
      expect(r).toEqual({ status: 'skipped', skipReason: reason });
      const call = logInsert(q)!; expect(call).toBeDefined();
      expect(call[0]).toContain("'skipped'"); expect(call[1][5]).toBe(reason); expect(call[1][2]).toBe('staff-1'); expect(call[1][3]).toBe('kanban');
      expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO messaging_outbox'), expect.anything());
      expect(pubsub.publish).not.toHaveBeenCalled();
      extra?.(call);
    };

    it('worker inexistente → WORKER_NOT_FOUND (worker_id null, país default); sem vaga → job null no log', async () => {
      await expectSkip('WORKER_NOT_FOUND', { worker: [] }, (c) => { expect(c[1][0]).toBeNull(); expect(c[1][1]).toBe('j1'); expect(c[1][6]).toBe('AR'); });
      q.mockReset(); program(q, { worker: [] });
      await uc().execute({ ...input, jobPostingId: undefined });
      expect(logInsert(q)![1][1]).toBeNull();
    });
    it('país ≠ AR → COUNTRY_BLOCKED; telefone não +54 → COUNTRY_MISMATCH (lex C2: dois sinais)', async () => {
      await expectSkip('COUNTRY_BLOCKED', { worker: [{ ...workerRow, country: 'BR' }] }, (c) => expect(c[1][6]).toBe('BR'));
      await expectSkip('COUNTRY_MISMATCH', { worker: [{ ...workerRow, phone_ar: false }] });
    });
    it('ficha importada / sem aceite → SIN_VINCULO (lex C1) — antes de qualquer leitura da config', async () => {
      await expectSkip('SIN_VINCULO', { worker: [{ ...workerRow, has_link: false }] }, () => {
        expect(q.mock.calls.some((c) => (c[0] as string).includes('FROM presentation_invite_settings'))).toBe(false);
      });
    });
    it('config desligada/inexistente → DISABLED_CONFIG (slug do template no log quando há, null quando não)', async () => {
      await expectSkip('DISABLED_CONFIG', { cfg: [{ ...cfgOn, enabled: false }] }, (c) => expect(c[1][4]).toBe('ar_presentacion_invite'));
      await expectSkip('DISABLED_CONFIG', { cfg: [{ ...cfgOn, enabled: false, template_slug: null }] }, (c) => expect(c[1][4]).toBeNull());
      await expectSkip('DISABLED_CONFIG', { cfg: [] }, (c) => expect(c[1][4]).toBeNull());
    });
    it('sem template → NO_TEMPLATE; inativo (Meta não aprovou) → TEMPLATE_INACTIVE; MARKETING/variável fora da allowlist/sem BAJA → TEMPLATE_NOT_ALLOWED', async () => {
      await expectSkip('NO_TEMPLATE', { cfg: [{ ...cfgOn, template_slug: null, body: null }] });
      await expectSkip('TEMPLATE_INACTIVE', { cfg: [{ ...cfgOn, is_active: false }] });
      await expectSkip('TEMPLATE_NOT_ALLOWED', { cfg: [{ ...cfgOn, category: 'MARKETING' }] });
      await expectSkip('TEMPLATE_NOT_ALLOWED', { cfg: [{ ...cfgOn, body: 'Hola {{1}} BAJA' }] });
      await expectSkip('TEMPLATE_NOT_ALLOWED', { cfg: [{ ...cfgOn, body: 'Hola {{meet_link}}' }] });
    });
    it('template com {{schedule_label}} e rótulo null/vazio/só espaços → NO_SCHEDULE_LABEL — nunca variável vazia na outbox', async () => {
      for (const schedule_label of [null, '', '   ']) await expectSkip('NO_SCHEDULE_LABEL', { cfg: [{ ...cfgOn, schedule_label }] }, (c) => expect(c[1][4]).toBe('ar_presentacion_invite'));
    });
    it('sem link → NO_MEET_LINK; DISABLED → WORKER_DISABLED; opt-out → OPT_OUT', async () => {
      await expectSkip('NO_MEET_LINK', { cfg: [{ ...cfgOn, meet_link: null }] });
      await expectSkip('WORKER_DISABLED', { worker: [{ ...workerRow, status: 'DISABLED' }] });
      await expectSkip('OPT_OUT', { worker: [{ ...workerRow, opted_out: true }] });
    });
    it('já convidada nos últimos 7 d → ALREADY_INVITED dentro da transação com lock', async () => {
      program(q); client = makeClient([{ id: 'old' }]);
      const r = await uc().execute(input);
      expect(r).toEqual({ status: 'skipped', skipReason: 'ALREADY_INVITED' });
      const dupSql = client.query.mock.calls.find((c) => (c[0] as string).includes('FROM presentation_invite_log'))![0] as string;
      expect(dupSql).toContain(`INTERVAL '${PRESENTATION_INVITE_COOLDOWN}'`); expect(dupSql).toContain("status = 'queued'");
      const ins = client.query.mock.calls.find((c) => (c[0] as string).includes("'ALREADY_INVITED'")) as unknown as [string, unknown[]];
      expect(ins[1]).toEqual(['w1', 'j1', 'staff-1', 'kanban', 'ar_presentacion_invite', 'AR']);
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(pubsub.publish).not.toHaveBeenCalled();
      // sem vaga: job null também no log do pulo dentro da transação
      q.mockReset(); program(q); client = makeClient([{ id: 'old' }]);
      await uc().execute({ ...input, jobPostingId: null });
      const ins2 = client.query.mock.calls.find((c) => (c[0] as string).includes("'ALREADY_INVITED'")) as unknown as [string, unknown[]];
      expect(ins2[1][1]).toBeNull();
    });
  });

  it('erro na transação → ROLLBACK, release, propaga', async () => {
    program(q);
    client.query.mockImplementation(async (sql: string) => { if (sql.includes('INSERT INTO messaging_outbox')) throw new Error('db down'); return { rows: [] }; });
    await expect(uc().execute(input)).rejects.toThrow('db down');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });
});
