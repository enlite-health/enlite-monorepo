/**
 * UncoveredShiftsAlertUseCase — spec 069 F4 (T402/T411). A transação e as tabelas são do banco real (e2e `069-rotina-diaria`);
 * aqui `withActorContext` entrega um client fantasma e repropaga erro, como o real. Nenhum e-mail real: o `email` é um dublê e o
 * `EmailChannelUnavailableError` é o MESMO tipo que o serviço real lança em `NODE_ENV=test`.
 */
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({}) }) },
}));
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({ reportError: (...a: unknown[]) => mockReportError(...a) }));
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: jest.fn(async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ __client: true })),
}));

import { UncoveredShiftsAlertUseCase } from '../UncoveredShiftsAlertUseCase';
import { EmailChannelUnavailableError } from '@modules/identity/infrastructure/EmailService';

const NOW = new Date('2026-11-03T02:30:00Z'); // AR/BR: 23:30 de 02/11 → operationDate 2026-11-02, janela 02/11…08/11
const ASOF = '2026-11-02'; // segunda-feira

/** Uma faixa semanal (segunda 08-12, weekday 1) sem ninguém alocado: vira 1 turno `uncovered` por segunda da janela. */
const faixaSemAlocacao = (serviceId: string, weekday = 1) => ({
  slots: [{ slotId: `slot-${serviceId}-${weekday}`, serviceId, weekday, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null }],
  assignments: [],
  absences: [],
});
const montado = { itineraryAssembled: true, patientStatus: 'ACTIVE' };

interface Opts {
  universe?: Record<string, Array<{ patientId: string; facts: { itineraryAssembled: boolean; patientStatus: string | null }; inputs: unknown }>>;
  labels?: Array<{ patientId: string; serviceId: string; patientName: string; serviceCode: string }>;
  recipients?: Array<{ uid: string; email: string | null; countries: string[] }>;
  skippedNoCountry?: number;
  /** uid, ou `uid@AAAA-MM-DD` para uma linha de OUTRO dia (janela de 3 dias). */
  retryable?: string[];
  /** uids cuja reivindicação PERDE a corrida (outra execução já pegou a linha). */
  claimLost?: string[];
  claimError?: boolean;
  notifyError?: (uid: string) => unknown;
  sendError?: unknown;
  universeError?: string;
  recipientsError?: boolean;
  retryableError?: boolean;
  markError?: boolean;
}

function montar(o: Opts = {}) {
  const reader = {
    readUniverse: jest.fn(async (_c: unknown, country: string) => {
      if (o.universeError === country) throw new Error('boom universo');
      return o.universe?.[country] ?? [];
    }),
    readLabels: jest.fn(async () => o.labels ?? []),
  };
  const recipients = {
    resolve: jest.fn(async () => {
      if (o.recipientsError) throw new Error('boom destinatários');
      return { recipients: o.recipients ?? [], skippedNoCountry: o.skippedNoCountry ?? 0 };
    }),
  };
  const dispatches = {
    insertPending: jest.fn(async (_c: unknown, i: { recipientUid: string }) => {
      const err = o.notifyError?.(i.recipientUid);
      if (err) throw err;
    }),
    listRetryable: jest.fn(async () => {
      if (o.retryableError) throw new Error('boom retryable');
      return (o.retryable ?? (o.recipients ?? []).map((r) => r.uid)).map((s) => {
        const [recipientUid, operationDate = ASOF] = s.split('@');
        return { operationDate, recipientUid };
      });
    }),
    claimEmail: jest.fn(async (_c: unknown, i: { recipientUid: string }) => {
      if (o.claimError) throw new Error('boom claim');
      return !(o.claimLost ?? []).includes(i.recipientUid);
    }),
    markEmail: jest.fn(async (..._a: unknown[]) => {
      if (o.markError) throw new Error('boom mark');
    }),
  };
  const publisher = { publishItineraryUncoveredShifts: jest.fn(async () => 'ev-1') };
  const email = {
    sendItineraryUncoveredShiftsDigest: jest.fn(async () => {
      if (o.sendError) throw o.sendError;
    }),
  };
  const uc = new UncoveredShiftsAlertUseCase(reader as never, recipients as never, dispatches as never, publisher as never, email as never);
  return { uc, reader, recipients, dispatches, publisher, email };
}

const um = (patientId: string, serviceId: string, facts = montado) => ({ patientId, facts, inputs: faixaSemAlocacao(serviceId) });

describe('UncoveredShiftsAlertUseCase (spec 069 F4)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('T402 caminho feliz: turnos por (paciente, serviço) → 1 aviso in-app + despacho PENDING + e-mail; operationDate = a do país (2026-11-02)', async () => {
    const { uc, publisher, dispatches, email } = montar({
      universe: { AR: [um('p1', 's1'), um('p2', 's2')] },
      labels: [
        { patientId: 'p1', serviceId: 's1', patientName: 'Ana Gómez', serviceCode: 'AT' },
        { patientId: 'p2', serviceId: 's2', patientName: 'Beto Díaz', serviceCode: 'FA' },
      ],
      recipients: [{ uid: 'u1', email: 'qa.um@enlite.test', countries: ['AR'] }],
    });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });

    expect(r).toEqual({
      operationDate: ASOF, alertRecipients: 1, notified: 1, alreadySent: 0, emailsSent: 1, emailsSkipped: 0, emailsFailed: 0, skippedNoCountry: 0, failures: 0,
    });
    // janela [02/11, 08/11]: UMA segunda-feira (02/11) por faixa — 1 turno por serviço, primeiro dia = 02/11
    expect(publisher.publishItineraryUncoveredShifts).toHaveBeenCalledWith(expect.anything(), {
      recipientUid: 'u1',
      operationDate: ASOF,
      items: [
        { patientId: 'p1', serviceId: 's1', shifts: 1, firstDate: ASOF },
        { patientId: 'p2', serviceId: 's2', shifts: 1, firstDate: ASOF },
      ],
    });
    expect(dispatches.insertPending).toHaveBeenCalledWith(expect.anything(), { operationDate: ASOF, recipientUid: 'u1', eventId: 'ev-1' });
    const [to, items, date, horizon] = email.sendItineraryUncoveredShiftsDigest.mock.calls[0] as unknown as [string, Array<{ patientName: string; serviceCode: string }>, string, number];
    expect([to, date, horizon]).toEqual(['qa.um@enlite.test', ASOF, 7]);
    expect(items.map((i) => `${i.patientName}/${i.serviceCode}`)).toEqual(['Ana Gómez/AT', 'Beto Díaz/FA']);
    expect(dispatches.markEmail).toHaveBeenCalledWith(expect.anything(), { operationDate: ASOF, recipientUid: 'u1', status: 'SENT', errorCode: null });
  });

  it('o payload in-app é só ids e números: nenhum nome de paciente sai para o publisher', async () => {
    const { uc, publisher } = montar({
      universe: { AR: [um('p1', 's1')] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'Nome Secreto', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
    });
    await uc.execute({ now: NOW, countries: ['AR'] });
    expect(JSON.stringify(publisher.publishItineraryUncoveredShifts.mock.calls)).not.toContain('Nome Secreto');
  });

  it('universo P13 NA regra: montado+ON_HOLD e não montado não geram item; o ACTIVE montado gera (controle positivo)', async () => {
    const { uc, publisher } = montar({
      universe: {
        AR: [
          um('ativo', 's-a'),
          um('em-espera', 's-h', { itineraryAssembled: true, patientStatus: 'ON_HOLD' }),
          um('nao-montado', 's-n', { itineraryAssembled: false, patientStatus: 'ACTIVE' }),
        ],
      },
      labels: [{ patientId: 'ativo', serviceId: 's-a', patientName: 'A', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
    });
    await uc.execute({ now: NOW, countries: ['AR'] });
    const items = (publisher.publishItineraryUncoveredShifts.mock.calls[0] as unknown as [unknown, { items: Array<{ patientId: string }> }])[1].items;
    expect(items.map((i) => i.patientId)).toEqual(['ativo']);
  });

  it('janela: turno em hoje+7 (segunda 09/11) não entra; só a segunda de hoje (02/11) conta', async () => {
    const { uc, publisher } = montar({
      universe: { AR: [{ patientId: 'p1', facts: montado, inputs: faixaSemAlocacao('s1', 1) }] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
    });
    await uc.execute({ now: NOW, countries: ['AR'] });
    const item = (publisher.publishItineraryUncoveredShifts.mock.calls[0] as unknown as [unknown, { items: Array<{ shifts: number; firstDate: string }> }])[1].items[0];
    expect(item).toMatchObject({ shifts: 1, firstDate: ASOF });
  });

  it('vários turnos no mesmo serviço: conta turnos e guarda o 1º dia', async () => {
    const duas = {
      slots: [
        { slotId: 'a', serviceId: 's1', weekday: 1, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null }, // seg 02/11
        { slotId: 'b', serviceId: 's1', weekday: 3, startTime: '08:00', endTime: '12:00', validFrom: '2026-01-01', validTo: null }, // qua 04/11
      ],
      assignments: [],
      absences: [],
    };
    const { uc, publisher } = montar({
      universe: { AR: [{ patientId: 'p1', facts: montado, inputs: duas }] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
    });
    await uc.execute({ now: NOW, countries: ['AR'] });
    expect((publisher.publishItineraryUncoveredShifts.mock.calls[0] as unknown as [unknown, { items: unknown[] }])[1].items).toEqual([
      { patientId: 'p1', serviceId: 's1', shifts: 2, firstDate: '2026-11-02' },
    ]);
  });

  it('nada descoberto: nada é gravado nem enviado (e nenhuma leitura de nome)', async () => {
    const { uc, publisher, email, reader, dispatches } = montar({
      universe: { AR: [{ patientId: 'p1', facts: montado, inputs: { slots: [], assignments: [], absences: [] } }] },
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
    });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(r).toMatchObject({ alertRecipients: 0, notified: 0, emailsSent: 0 });
    expect(reader.readLabels).not.toHaveBeenCalled();
    expect(publisher.publishItineraryUncoveredShifts).not.toHaveBeenCalled();
    expect(dispatches.insertPending).not.toHaveBeenCalled();
    expect(email.sendItineraryUncoveredShiftsDigest).not.toHaveBeenCalled();
  });

  it('P10: destinatário só-AR não recebe paciente BR; destinatário AR+BR recebe os dois; sem item no seu escopo = não recebe nada', async () => {
    const { uc, publisher } = montar({
      universe: { AR: [um('p-ar', 's-ar')], BR: [um('p-br', 's-br')] },
      labels: [
        { patientId: 'p-ar', serviceId: 's-ar', patientName: 'A', serviceCode: 'AT' },
        { patientId: 'p-br', serviceId: 's-br', patientName: 'B', serviceCode: 'AT' },
      ],
      recipients: [
        { uid: 'so-ar', email: 'a@x', countries: ['AR'] },
        { uid: 'ambos', email: 'b@x', countries: ['AR', 'BR'] },
        { uid: 'so-uy', email: 'c@x', countries: ['UY'] },
      ],
    });
    const r = await uc.execute({ now: NOW, countries: ['AR', 'BR'] });
    const porUid = new Map(publisher.publishItineraryUncoveredShifts.mock.calls.map((c) => { const a = c as unknown as [unknown, { recipientUid: string; items: Array<{ patientId: string }> }]; return [a[1].recipientUid, a[1].items.map((i) => i.patientId)]; }));
    expect(porUid.get('so-ar')).toEqual(['p-ar']);
    expect(porUid.get('ambos')?.sort()).toEqual(['p-ar', 'p-br']);
    expect(porUid.has('so-uy')).toBe(false);
    expect(r.alertRecipients).toBe(2);
  });

  it('skippedNoCountry vem dos destinatários e entra no resultado', async () => {
    const { uc } = montar({ skippedNoCountry: 3 });
    expect((await uc.execute({ now: NOW, countries: ['AR'] })).skippedNoCountry).toBe(3);
  });

  it('T409(c) idempotência: PK do despacho violada (23505) → alreadySent, sem e-mail novo e sem falha', async () => {
    const { uc, email, dispatches } = montar({
      universe: { AR: [um('p1', 's1')] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
      notifyError: () => Object.assign(new Error('duplicate key'), { code: '23505' }),
      retryable: [], // o despacho do dia já está SENT: nada a re-tentar
    });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(r).toMatchObject({ notified: 0, alreadySent: 1, failures: 0, emailsSent: 0 });
    expect(email.sendItineraryUncoveredShiftsDigest).not.toHaveBeenCalled();
    expect(dispatches.markEmail).not.toHaveBeenCalled();
  });

  it('re-chamada com despacho FAILED/PENDING do dia: reenvia o e-mail (retry), sem nova notificação; quem não está mais no escopo é ignorado', async () => {
    const { uc, email } = montar({
      universe: { AR: [um('p1', 's1')] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
      notifyError: () => Object.assign(new Error('dup'), { code: '23505' }),
      retryable: ['u1', 'saiu-do-escopo'],
    });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(r).toMatchObject({ notified: 0, alreadySent: 1, emailsSent: 1 });
    expect(email.sendItineraryUncoveredShiftsDigest).toHaveBeenCalledTimes(1);
  });

  it('D2c: linha REIVINDICADA por outra execução (claim perdido) → NÃO envia o 2º e-mail e nada é contado; reivindicar vem ANTES de enviar e de marcar', async () => {
    const base = {
      universe: { AR: [um('p1', 's1')] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
    };
    const perdeu = montar({ ...base, claimLost: ['u1'] });
    const r = await perdeu.uc.execute({ now: NOW, countries: ['AR'] });
    expect(perdeu.email.sendItineraryUncoveredShiftsDigest).not.toHaveBeenCalled();
    expect(perdeu.dispatches.markEmail).not.toHaveBeenCalled();
    expect(r).toMatchObject({ emailsSent: 0, emailsFailed: 0, emailsSkipped: 0, failures: 0 });
    // controle positivo: com a reivindicação ganha, o MESMO cenário envia e marca — claim < envio < mark
    const ganhou = montar(base);
    await ganhou.uc.execute({ now: NOW, countries: ['AR'] });
    expect(ganhou.dispatches.claimEmail).toHaveBeenCalledWith(expect.anything(), { operationDate: ASOF, recipientUid: 'u1' });
    const claim = ganhou.dispatches.claimEmail.mock.invocationCallOrder[0];
    expect(claim).toBeLessThan(ganhou.email.sendItineraryUncoveredShiftsDigest.mock.invocationCallOrder[0]);
    expect(ganhou.email.sendItineraryUncoveredShiftsDigest.mock.invocationCallOrder[0]).toBeLessThan(ganhou.dispatches.markEmail.mock.invocationCallOrder[0]);
  });

  it('D2c: erro ao reivindicar é contado em failures (reportError) e o destinatário seguinte continua; nenhum e-mail do que não foi reivindicado', async () => {
    const { uc, email } = montar({
      universe: { AR: [um('p1', 's1')] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
      claimError: true,
    });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(r.failures).toBe(1);
    expect(email.sendItineraryUncoveredShiftsDigest).not.toHaveBeenCalled();
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), { source: 'UncoveredShiftsAlertUseCase:claim' });
  });

  it('D2b: linha de DIA ANTERIOR ainda pendente é retomada — com a cobertura de AGORA (payload re-montado), reivindicada e marcada na chave DAQUELE dia; quem não tem mais turno descoberto não recebe nada', async () => {
    const { uc, email, dispatches } = montar({
      universe: { AR: [um('p1', 's1')] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [
        { uid: 'u1', email: 'a@x', countries: ['AR'] },
        { uid: 'u-sem-turno', email: 'b@x', countries: ['BR'] }, // BR sem universo: nada descoberto hoje
      ],
      notifyError: () => Object.assign(new Error('dup'), { code: '23505' }),
      retryable: ['u1@2026-10-31', 'u-sem-turno@2026-10-31'],
    });
    await uc.execute({ now: NOW, countries: ['AR'] });
    expect(dispatches.claimEmail).toHaveBeenCalledTimes(1);
    expect(dispatches.claimEmail).toHaveBeenCalledWith(expect.anything(), { operationDate: '2026-10-31', recipientUid: 'u1' });
    expect(dispatches.markEmail).toHaveBeenCalledWith(expect.anything(), { operationDate: '2026-10-31', recipientUid: 'u1', status: 'SENT', errorCode: null });
    const [to, items, date] = email.sendItineraryUncoveredShiftsDigest.mock.calls[0] as unknown as [string, unknown[], string];
    expect([to, items.length, date]).toEqual(['a@x', 1, ASOF]); // a data do DIGEST é a de hoje: o conteúdo é a cobertura de hoje
    expect(email.sendItineraryUncoveredShiftsDigest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ambiente de teste', 'SKIPPED_TEST'],
    ['sem SENDGRID_API_KEY', 'SKIPPED_NO_KEY'],
  ] as const)('T411 canal indisponível (%s) → %s: contado como skipped, não como falha, e nada vai ao SendGrid', async (motivo, status) => {
    const { uc, dispatches } = montar({
      universe: { AR: [um('p1', 's1')] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'qa.x@enlite.test', countries: ['AR'] }],
      sendError: new EmailChannelUnavailableError(motivo),
    });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(r).toMatchObject({ emailsSent: 0, emailsSkipped: 1, emailsFailed: 0, failures: 0 });
    expect(dispatches.markEmail).toHaveBeenCalledWith(expect.anything(), { operationDate: ASOF, recipientUid: 'u1', status, errorCode: null });
  });

  it('destinatário sem endereço → NO_ADDRESS (não chama o serviço de e-mail)', async () => {
    const { uc, email, dispatches } = montar({
      universe: { AR: [um('p1', 's1')] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: null, countries: ['AR'] }],
    });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(r.emailsSkipped).toBe(1);
    expect(email.sendItineraryUncoveredShiftsDigest).not.toHaveBeenCalled();
    expect(dispatches.markEmail).toHaveBeenCalledWith(expect.anything(), { operationDate: ASOF, recipientUid: 'u1', status: 'NO_ADDRESS', errorCode: null });
  });

  it.each([
    ['com code', Object.assign(new Error('mensagem com a@x.com'), { code: 403 }), '403'],
    ['com code texto', Object.assign(new Error('x'), { code: 'ECONNRESET' }), 'ECONNRESET'],
    ['só name', new TypeError('mensagem com a@x.com'), 'TypeError'],
    ['sem nada', { message: 'x' }, 'EMAIL_ERROR'],
  ])('falha real de envio (%s) → FAILED com código sem PII (nunca a mensagem)', async (_n, sendError, errorCode) => {
    const { uc, dispatches } = montar({
      universe: { AR: [um('p1', 's1')] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'a@x.com', countries: ['AR'] }],
      sendError,
    });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(r).toMatchObject({ emailsFailed: 1, emailsSent: 0, failures: 0 });
    expect(dispatches.markEmail).toHaveBeenCalledWith(expect.anything(), { operationDate: ASOF, recipientUid: 'u1', status: 'FAILED', errorCode });
  });

  it('falha ao ler o universo de um país: contada e reportada, o outro país segue', async () => {
    const { uc, publisher } = montar({
      universe: { BR: [um('p-br', 's-br')] },
      universeError: 'AR',
      labels: [{ patientId: 'p-br', serviceId: 's-br', patientName: 'B', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR', 'BR'] }],
    });
    const r = await uc.execute({ now: NOW, countries: ['AR', 'BR'] });
    expect(r.failures).toBe(1);
    expect(mockReportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ source: 'UncoveredShiftsAlertUseCase:select', country: 'AR' }));
    expect(publisher.publishItineraryUncoveredShifts).toHaveBeenCalledTimes(1);
  });

  it('falha ao resolver destinatários: contada, nada é enviado; erro não-Error é embrulhado', async () => {
    const { uc, publisher, recipients } = montar({ recipientsError: true });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(r.failures).toBe(1);
    expect(publisher.publishItineraryUncoveredShifts).not.toHaveBeenCalled();
    recipients.resolve.mockRejectedValueOnce('texto solto');
    await uc.execute({ now: NOW, countries: ['AR'] });
    expect(mockReportError).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'texto solto' }), expect.anything());
  });

  it('falha de banco ao criar a notificação de UM destinatário: contada, os outros seguem; erro não-Error embrulhado', async () => {
    const { uc, publisher } = montar({
      universe: { AR: [um('p1', 's1')] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [
        { uid: 'ruim', email: 'a@x', countries: ['AR'] },
        { uid: 'bom', email: 'b@x', countries: ['AR'] },
      ],
      notifyError: (uid) => (uid === 'ruim' ? 'falha crua' : null),
      retryable: ['bom'],
    });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(r).toMatchObject({ notified: 1, failures: 1, emailsSent: 1 });
    expect(publisher.publishItineraryUncoveredShifts).toHaveBeenCalledTimes(2);
    expect(mockReportError).toHaveBeenCalledWith(expect.objectContaining({ message: 'falha crua' }), expect.objectContaining({ source: 'UncoveredShiftsAlertUseCase:notify' }));
  });

  it('falha ao listar os despachos re-tentáveis: contada, sem e-mail (a in-app já foi); erro não-Error embrulhado', async () => {
    const { uc, email } = montar({
      universe: { AR: [um('p1', 's1')] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
      retryableError: true,
    });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(r).toMatchObject({ notified: 1, failures: 1, emailsSent: 0 });
    expect(email.sendItineraryUncoveredShiftsDigest).not.toHaveBeenCalled();
  });

  it('falha ao gravar o resultado do e-mail: contada (o e-mail já saiu)', async () => {
    const { uc } = montar({
      universe: { AR: [um('p1', 's1')] },
      labels: [{ patientId: 'p1', serviceId: 's1', patientName: 'A', serviceCode: 'AT' }],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
      markError: true,
    });
    const r = await uc.execute({ now: NOW, countries: ['AR'] });
    expect(r).toMatchObject({ emailsSent: 1, failures: 1 });
  });

  it('rótulo ausente (serviço baixado entre as leituras): usa o nome e o código de reserva, não derruba', async () => {
    const { uc, email } = montar({
      universe: { AR: [um('p1', 's1')] },
      labels: [],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
    });
    await uc.execute({ now: NOW, countries: ['AR'] });
    const items = (email.sendItineraryUncoveredShiftsDigest.mock.calls[0] as unknown as [string, Array<{ patientName: string; serviceCode: string }>])[1];
    expect(items).toEqual([expect.objectContaining({ patientName: 'Paciente sin nombre', serviceCode: '' })]);
  });

  it('ordem estável dos itens: por nome, depois código, depois id do serviço', async () => {
    const { uc, publisher } = montar({
      universe: { AR: [um('p1', 's2'), um('p2', 's1'), um('p3', 's3'), um('p4', 's4')] },
      labels: [
        { patientId: 'p1', serviceId: 's2', patientName: 'Zeta', serviceCode: 'AT' },
        { patientId: 'p2', serviceId: 's1', patientName: 'Alfa', serviceCode: 'FA' },
        { patientId: 'p3', serviceId: 's3', patientName: 'Alfa', serviceCode: 'AT' },
        { patientId: 'p4', serviceId: 's4', patientName: 'Alfa', serviceCode: 'AT' },
      ],
      recipients: [{ uid: 'u1', email: 'a@x', countries: ['AR'] }],
    });
    await uc.execute({ now: NOW, countries: ['AR'] });
    const ids = (publisher.publishItineraryUncoveredShifts.mock.calls[0] as unknown as [unknown, { items: Array<{ serviceId: string }> }])[1].items.map((i) => i.serviceId);
    expect(ids).toEqual(['s3', 's4', 's1', 's2']); // Alfa/AT(s3), Alfa/AT(s4), Alfa/FA(s1), Zeta/AT(s2)
  });

  it('construtor sem argumentos monta as dependências reais', () => {
    expect(new UncoveredShiftsAlertUseCase()).toBeInstanceOf(UncoveredShiftsAlertUseCase);
  });
});
