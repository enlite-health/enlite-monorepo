/**
 * `not_found` depois de 3 h: conta que JÁ importou com sucesso desde o vínculo é CERTA — a reunião só expira, o vínculo fica.
 * Conta sem nenhuma importação continua sendo derrubada (`wrong_account`). Antes de 3 h: espera. Portas em dublê; sem rede nem banco.
 */
const mockRead = jest.fn();

jest.mock('@shared/database/sessionAdvisoryLock', () => ({
  withSessionAdvisoryLock: async (_db: unknown, _key: string, fn: () => Promise<unknown>) => ({ acquired: true, value: await fn() }),
}));
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: async (_db: unknown, fn: (cli: unknown) => Promise<unknown>) => fn({}),
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

function build(hasImported: boolean) {
  const repo = {
    listDueIds: jest.fn(), find: jest.fn().mockResolvedValue(subject), setState: jest.fn().mockResolvedValue(undefined),
    hasEvent: jest.fn(), hasSkippedTest: jest.fn().mockResolvedValue(false), hasBlockedReason: jest.fn(),
    countModelSummaryFailures: jest.fn().mockResolvedValue(0),
  };
  const tokens = {
    withHostAccess: jest.fn(), markBroken: jest.fn(), markWrongAccount: jest.fn().mockResolvedValue(true),
    hasImportedSinceLinked: jest.fn().mockResolvedValue(hasImported),
  };
  const events = { append: jest.fn().mockResolvedValue(undefined) };
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const svc = new AdmissionImportService({
    repo, tokens, events, log, db: {} as never,
    destination: { naming: ADMISSION_IMPORT_NAMING } as never,
    mcp: {} as never, vault: {} as never, summary: {} as never,
  } as never);
  return { svc, repo, tokens, events };
}

describe('AdmissionImportService — not_found e o vínculo', () => {
  beforeEach(() => mockRead.mockResolvedValue({ kind: 'verdict', decision: { kind: 'none', reason: 'not_found' } }));

  it('(a) host com importação prévia + not_found ≥ 3 h → expira com not_found; markWrongAccount NÃO é chamado', async () => {
    const { svc, repo, tokens, events } = build(true);
    expect(await svc.importOne('appt-1', new Date(ended.getTime() + 4 * HOUR))).toBe('expired');
    expect(tokens.hasImportedSinceLinked).toHaveBeenCalledWith('op@enlite.test');
    expect(tokens.markWrongAccount).not.toHaveBeenCalled();
    expect(repo.setState).toHaveBeenCalledWith('appt-1', 'expired', expect.anything());
    expect(events.append).toHaveBeenCalledWith(expect.objectContaining({ kind: 'import_expired', reason: 'not_found' }), expect.anything());
  });

  it('(b) host SEM importação + not_found ≥ 3 h → markWrongAccount e bloqueio wrong_account (comportamento anterior)', async () => {
    const { svc, repo, tokens } = build(false);
    expect(await svc.importOne('appt-1', new Date(ended.getTime() + 4 * HOUR))).toBe('wrong_account');
    expect(tokens.markWrongAccount).toHaveBeenCalledWith('op@enlite.test');
    expect(repo.setState).toHaveBeenCalledWith('appt-1', 'blocked', expect.anything(), { reason: 'wrong_account' });
  });

  it('(c) not_found < 3 h → waiting; nem consulta o histórico nem mexe no vínculo', async () => {
    const { svc, repo, tokens } = build(true);
    expect(await svc.importOne('appt-1', new Date(ended.getTime() + 2 * HOUR))).toBe('waiting');
    expect(tokens.hasImportedSinceLinked).not.toHaveBeenCalled();
    expect(tokens.markWrongAccount).not.toHaveBeenCalled();
    expect(repo.setState).toHaveBeenCalledWith('appt-1', 'waiting', expect.anything(), { countAttempt: true });
  });
});
