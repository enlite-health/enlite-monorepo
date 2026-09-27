/**
 * VacancyLaunchHook — invariante 7 (D434): o LANÇAMENTO da vaga (envio à Talentum) tira o
 * paciente do funil de Admissão (funil → SEARCHING) e dispara o match SEM convite. Nunca lança
 * (DX-6.2): cada metade (mover/casar) tem try/catch próprio — uma falhar não impede a outra, e a
 * função sempre RESOLVE.
 */
let queryImpl: (sql: string, params?: unknown[]) => Promise<unknown> = async () => ({ rows: [], rowCount: 0 });
const mockClient = {
  query: jest.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params)),
  release: jest.fn(),
};
const mockGetClient = jest.fn().mockResolvedValue(mockClient);
// A transação sai de `withActorContext(getPool(), …)`: o pool mockado precisa saber `connect()`
// (mesmo molde de `PatientService.moveStatus.v2.test.ts`).
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn(() => ({ getPool: jest.fn(() => ({ connect: mockGetClient })), getClient: mockGetClient })) },
}));
jest.mock('firebase-functions', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
// Só `reportError` é espiado — `loggingAls`/`logger` reais seguem para não quebrar
// `actorContext`/`requestDbSession`, que também importam de `@shared/logging`.
jest.mock('@shared/logging', () => ({
  ...jest.requireActual('@shared/logging'),
  reportError: jest.fn(),
}));

import * as functions from 'firebase-functions';
import { reportError } from '@shared/logging';
import {
  onVacancyLaunched,
  readLaunchTarget,
  LAUNCH_MATCH_RADIUS_KM,
  LAUNCH_MATCH_TOP_N,
} from '../VacancyLaunchHook';
import { PatientStatusNotReadyError } from '../PatientStatusWriter';
import type { MatchResult } from '../../../matching/infrastructure/MatchmakingService';

const JOB_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PID = '11111111-1111-4111-8111-111111111111';

const calls = (): Array<{ sql: string; params?: unknown[] }> =>
  mockClient.query.mock.calls.map(([sql, params]) => ({ sql: String(sql), params }));

type TargetRow = { patient_id: string | null; status: string | null; lat: string | null; lng: string | null };

/** Banco de mentira: só a query do alvo do lançamento importa aqui. */
function dbTarget(row: TargetRow | null) {
  queryImpl = async (sql) => {
    if (/FROM job_postings jp/.test(sql)) {
      return row ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
}

function matchResult(n: number): MatchResult {
  return {
    jobPostingId: JOB_ID,
    radiusKm: LAUNCH_MATCH_RADIUS_KM,
    matchSummary: { hardFilteredCount: n, llmScoredCount: 0 },
    candidates: Array.from({ length: n }, (_, i) => ({ workerId: `w${i}` })) as MatchResult['candidates'],
  };
}

describe('VacancyLaunchHook.onVacancyLaunched', () => {
  let moveStatus: jest.Mock;
  let runMatch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    moveStatus = jest.fn().mockResolvedValue({ id: PID, status: 'SEARCHING' });
    runMatch = jest.fn().mockResolvedValue(matchResult(3));
  });

  const deps = () => ({ moveStatus, runMatch, readLaunchTarget });

  it.each(['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION'] as const)(
    'funil (%s) → 1 moveStatus(SEARCHING, { changeSource: vacancy_launch }), patient: moved',
    async (status) => {
      dbTarget({ patient_id: PID, status, lat: '-34.6', lng: '-58.4' });
      const outcome = await onVacancyLaunched(JOB_ID, deps());
      expect(moveStatus).toHaveBeenCalledTimes(1);
      expect(moveStatus).toHaveBeenCalledWith(PID, 'SEARCHING', { changeSource: 'vacancy_launch' });
      expect(outcome.patient).toBe('moved');
    },
  );

  it.each(['ACTIVE', 'SEARCHING'] as const)(
    'fora do funil (%s) → 0 chamadas a moveStatus, patient: unchanged; o match roda igual',
    async (status) => {
      dbTarget({ patient_id: PID, status, lat: '-34.6', lng: '-58.4' });
      const outcome = await onVacancyLaunched(JOB_ID, deps());
      expect(moveStatus).not.toHaveBeenCalled();
      expect(outcome.patient).toBe('unchanged');
      expect(runMatch).toHaveBeenCalledTimes(1);
    },
  );

  it('vaga sem patient_id → patient: no_patient, moveStatus 0×', async () => {
    dbTarget({ patient_id: null, status: null, lat: '-34.6', lng: '-58.4' });
    const outcome = await onVacancyLaunched(JOB_ID, deps());
    expect(moveStatus).not.toHaveBeenCalled();
    expect(outcome.patient).toBe('no_patient');
  });

  it('vaga COM patient_id mas o LEFT JOIN em patients voltou vazio (RLS escondeu/registro sumiu) → patient: patient_not_visible, moveStatus 0×, warn com jobPostingId+patientId (achado A5)', async () => {
    dbTarget({ patient_id: PID, status: null, lat: '-34.6', lng: '-58.4' });
    const outcome = await onVacancyLaunched(JOB_ID, deps());
    expect(moveStatus).not.toHaveBeenCalled();
    expect(outcome.patient).toBe('patient_not_visible');
    expect(functions.logger.warn).toHaveBeenCalledWith(
      'vacancy_launch.patient_not_visible',
      { jobPostingId: JOB_ID, patientId: PID },
    );
    expect(runMatch).toHaveBeenCalledTimes(1);
  });

  it('vaga inexistente/rascunho (0 linhas) → no_target, match: skipped_no_target, nenhuma chamada', async () => {
    dbTarget(null);
    const outcome = await onVacancyLaunched(JOB_ID, deps());
    expect(outcome).toEqual({ jobPostingId: JOB_ID, patient: 'no_target', match: 'skipped_no_target' });
    expect(moveStatus).not.toHaveBeenCalled();
    expect(runMatch).not.toHaveBeenCalled();
  });

  it('runMatch é chamado com o objeto exato {radiusKm:50, topN:200, includeIncompleteRegister:false, excludeWithActiveCases:false}', async () => {
    dbTarget({ patient_id: PID, status: 'ADMISSION', lat: '-34.6', lng: '-58.4' });
    await onVacancyLaunched(JOB_ID, deps());
    expect(runMatch).toHaveBeenCalledWith(JOB_ID, {
      radiusKm: 50,
      topN: 200,
      includeIncompleteRegister: false,
      excludeWithActiveCases: false,
    });
    expect(LAUNCH_MATCH_RADIUS_KM).toBe(50);
    expect(LAUNCH_MATCH_TOP_N).toBe(200);
  });

  it('sem lat/lng → runMatch 0×, match: skipped_no_location', async () => {
    dbTarget({ patient_id: PID, status: 'ADMISSION', lat: null, lng: null });
    const outcome = await onVacancyLaunched(JOB_ID, deps());
    expect(runMatch).not.toHaveBeenCalled();
    expect(outcome.match).toBe('skipped_no_location');
  });

  it('moveStatus lança PatientStatusNotReadyError → patient: not_ready, e o match roda IGUAL (1×)', async () => {
    dbTarget({ patient_id: PID, status: 'ADMISSION', lat: '-34.6', lng: '-58.4' });
    moveStatus.mockRejectedValue(new PatientStatusNotReadyError('SEARCHING', ['SERVICE_SCHEDULE']));
    const outcome = await onVacancyLaunched(JOB_ID, deps());
    expect(outcome.patient).toBe('not_ready');
    expect(runMatch).toHaveBeenCalledTimes(1);
    expect(functions.logger.warn).toHaveBeenCalledWith(
      'vacancy_launch.patient_not_moved',
      expect.objectContaining({
        jobPostingId: JOB_ID,
        patientId: PID,
        code: 'PATIENT_STATUS_NOT_READY',
        missing: ['SERVICE_SCHEDULE'],
      }),
    );
  });

  it('moveStatus lança Error genérico → patient: failed, runMatch 1×, a função RESOLVE (nunca lança)', async () => {
    dbTarget({ patient_id: PID, status: 'ADMISSION', lat: '-34.6', lng: '-58.4' });
    moveStatus.mockRejectedValue(new Error('boom-move'));
    await expect(onVacancyLaunched(JOB_ID, deps())).resolves.toMatchObject({ patient: 'failed' });
    expect(runMatch).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'VacancyLaunchHook:move' });
  });

  it('runMatch lança → match: failed, a função RESOLVE (nunca lança)', async () => {
    dbTarget({ patient_id: PID, status: 'ADMISSION', lat: '-34.6', lng: '-58.4' });
    runMatch.mockRejectedValue(new Error('boom-match'));
    await expect(onVacancyLaunched(JOB_ID, deps())).resolves.toMatchObject({ patient: 'moved', match: 'failed' });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), { source: 'VacancyLaunchHook:match' });
  });

  it('a leitura roda dentro do inPatientTransaction (BEGIN…COMMIT) e a SQL tem jp.is_draft = false', async () => {
    dbTarget({ patient_id: PID, status: 'ADMISSION', lat: '-34.6', lng: '-58.4' });
    await onVacancyLaunched(JOB_ID, deps());
    const c = calls();
    expect(c[0].sql).toBe('BEGIN');
    expect(c.some((x) => /jp\.is_draft = false/.test(x.sql))).toBe(true);
    expect(c[c.length - 1].sql).toBe('COMMIT');
  });

  it('nenhum argumento de log contém nome/telefone — só ids e código de erro', async () => {
    dbTarget({ patient_id: PID, status: 'ADMISSION', lat: '-34.6', lng: '-58.4' });
    moveStatus.mockRejectedValue(new Error('boom'));
    runMatch.mockRejectedValue(new Error('boom2'));
    await onVacancyLaunched(JOB_ID, deps());
    const loggedInfo = JSON.stringify((functions.logger.info as jest.Mock).mock.calls);
    const loggedWarn = JSON.stringify((functions.logger.warn as jest.Mock).mock.calls);
    const loggedError = JSON.stringify((functions.logger.error as jest.Mock).mock.calls);
    for (const logged of [loggedInfo, loggedWarn, loggedError]) {
      expect(logged).not.toMatch(/\+54|@|nombre|phone|telefone/i);
    }
  });
});
