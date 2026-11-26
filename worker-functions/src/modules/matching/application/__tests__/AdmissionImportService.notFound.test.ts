/**
 * `not_found` depois de 3 h (design D10): a reunião expira com `not_recorded` e o host é avisado NA MESMA transação; o vínculo NÃO é tocado
 * (nenhum `markBroken`/rebaixamento). Reunião que terminou antes do 1º vínculo só expira (`not_found`, sem aviso). Antes de 3 h: espera.
 * Portas em dublê; sem rede nem banco. A transação é simulada: só o que sai de `withActorContext` sem lançar fica "commitado".
 */
const mockRead = jest.fn();
const committed = new Set<unknown>();

jest.mock('@shared/database/sessionAdvisoryLock', () => ({
  withSessionAdvisoryLock: async (_db: unknown, _key: string, fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }),
}));
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: async (_db: unknown, fn: (cli: unknown) => Promise<unknown>) => {
    const cli = {};
    const out = await fn(cli);
    committed.add(cli);
    return out;
  },
}));
jest.mock('../AdmissionTranscriptReader', () => ({
  ...jest.requireActual('../AdmissionTranscriptReader'),
  AdmissionTranscriptReader: jest.fn().mockImplementation(() => ({ read: mockRead })),
}));

import { AdmissionImportService } from '../AdmissionImportService';
import { ADMISSION_IMPORT_NAMING, type ImportSubject } from '../ports/ImportPorts';

const HOUR = 3_600_000;
const ended = new Date('2026-10-27T10:00:00Z');
const subject: ImportSubject = {
  id: 'appt-1', country: 'AR', host_email: 'op@enlite.test', admission_code: 'ENC-ABC123', slot_start: ended, status: 'booked',
  conference_ended_at: ended, import_status: 'waiting', import_attempts: 1, patient_is_test: false, rehearsal_until: null,
};

function build(linkAfterEnd = false, noticeFails = false) {
  const repo = {
    listDueIds: jest.fn(), find: jest.fn().mockResolvedValue(subject), setState: jest.fn().mockResolvedValue(undefined),
    hasEvent: jest.fn(), hasSkippedTest: jest.fn().mockResolvedValue(false), hasBlockedReason: jest.fn(),
    countModelSummaryFailures: jest.fn().mockResolvedValue(0),
    lastBlockedEvent: jest.fn().mockResolvedValue(null), countRemindersSince: jest.fn().mockResolvedValue(0),
  };
  const tokens = {
    withHostAccess: jest.fn(), markBroken: jest.fn(),
    hasLinkedSince: jest.fn().mockResolvedValue(false),
    linkCreatedAfter: jest.fn().mockResolvedValue(linkAfterEnd),
  };
  const events = { append: jest.fn().mockResolvedValue(undefined) };
  const notices = { notify: noticeFails ? jest.fn().mockRejectedValue(new Error('insert do sino falhou')) : jest.fn().mockResolvedValue(undefined) };
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const svc = new AdmissionImportService({
    repo, tokens, events, notices, log, db: {} as never,
    destination: { naming: ADMISSION_IMPORT_NAMING } as never,
    mcp: {} as never, vault: {} as never, summary: {} as never,
  } as never);
  return { svc, repo, tokens, events, notices };
}

describe('AdmissionImportService — reunião não encontrada (D10)', () => {
  beforeEach(() => {
    committed.clear();
    mockRead.mockResolvedValue({ kind: 'verdict', decision: { kind: 'none', reason: 'not_found' } });
  });

  it('(a) not_found ≥ 3 h → expired/not_recorded + 1 aviso ao host; nenhuma chamada que mude o vínculo', async () => {
    const { svc, repo, tokens, events, notices } = build();
    expect(await svc.importOne('appt-1', new Date(ended.getTime() + 4 * HOUR))).toBe('expired');
    expect(repo.setState).toHaveBeenCalledWith('appt-1', 'expired', expect.anything());
    expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'import_expired', reason: 'not_recorded' }), expect.anything());
    expect(notices.notify).toHaveBeenCalledTimes(1);
    expect(notices.notify).toHaveBeenCalledWith(
      repo.setState.mock.calls[0][2], // MESMA transação do estado
      expect.objectContaining({ stage: 'expired', reason: 'not_recorded', hostEmail: 'op@enlite.test', warnManagement: false }),
    );
    expect(tokens.markBroken).not.toHaveBeenCalled();
    expect(tokens.withHostAccess).not.toHaveBeenCalled();
  });

  it('(b) not_found < 3 h → waiting; sem aviso, sem mexer no vínculo', async () => {
    const { svc, repo, tokens, notices } = build();
    expect(await svc.importOne('appt-1', new Date(ended.getTime() + 2 * HOUR))).toBe('waiting');
    expect(repo.setState).toHaveBeenCalledWith('appt-1', 'waiting', expect.anything(), { countAttempt: true });
    expect(notices.notify).not.toHaveBeenCalled();
    expect(tokens.markBroken).not.toHaveBeenCalled();
  });

  it('(c) reunião terminou ANTES do 1º vínculo + not_found ≥ 3 h → expired/not_found, SEM aviso', async () => {
    const { svc, repo, events, notices } = build(true);
    expect(await svc.importOne('appt-1', new Date(ended.getTime() + 4 * HOUR))).toBe('expired');
    expect(repo.setState).toHaveBeenCalledWith('appt-1', 'expired', expect.anything());
    expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'import_expired', reason: 'not_found' }), expect.anything());
    expect(notices.notify).not.toHaveBeenCalled();
  });

  it('(d) o INSERT do sino falha → a expiração desfaz (o aviso nasce na MESMA transação)', async () => {
    const { svc, repo } = build(false, true);
    await expect(svc.importOne('appt-1', new Date(ended.getTime() + 4 * HOUR))).rejects.toThrow('insert do sino falhou');
    expect(repo.setState).toHaveBeenCalledWith('appt-1', 'expired', expect.anything());
    expect(committed.has(repo.setState.mock.calls[0][2])).toBe(false);
  });
});
