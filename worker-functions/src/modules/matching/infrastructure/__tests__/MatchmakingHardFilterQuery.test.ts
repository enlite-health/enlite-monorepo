import { DataRealm } from '@shared/domain/DataRealm';
import { runHardFilter } from '../MatchmakingHardFilterQuery';
import { JobPosting } from '../MatchmakingTypes';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

const IS_TEST_CLAUSE = /w\.is_test = \$(\d+)::boolean/;

function makeWorkerRow(workerId: string, isTest: boolean) {
  return {
    worker_id: workerId,
    phone: '+5491100000000',
    occupation: 'AT',
    worker_status: 'REGISTERED',
    is_test: isTest,
    diagnostic_preferences: [],
    sex_encrypted: null,
    first_name_encrypted: null,
    last_name_encrypted: null,
    work_zone: 'Palermo',
    worker_address: null,
    interest_zone: null,
    worker_lat: null,
    worker_lng: null,
    active_cases: [],
    already_applied: false,
    rejection_history: {},
    avg_quality_rating: null,
  };
}

function makeJob(realm: DataRealm): JobPosting {
  return {
    id: 'job-1',
    workerProfileSought: null,
    scheduleDaysHours: null,
    diagnosis: null,
    patientZone: null,
    serviceLat: null,
    serviceLng: null,
    requiredSex: null,
    requiredProfessions: null,
    pathologyTypes: null,
    realm,
  };
}

function makeFakeDb(fixtureRows: ReturnType<typeof makeWorkerRow>[]) {
  return {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      const match = sql.match(IS_TEST_CLAUSE);
      if (!match) throw new Error('SameRealmSpecification clause not found in hardFilter SQL');
      const boundIsTest = params[Number(match[1]) - 1];
      return { rows: fixtureRows.filter(row => row.is_test === boundIsTest) };
    }),
  };
}

const kms = { decrypt: jest.fn() } as unknown as KMSEncryptionService;

describe('runHardFilter — segregação por realm', () => {
  const liveWorker = makeWorkerRow('worker-live-1', false);
  const testWorker = makeWorkerRow('worker-test-1', true);

  it('vaga LIVE + worker TEST elegível (mesma zona/profissão) → NÃO casa; worker LIVE elegível → casa', async () => {
    const db = makeFakeDb([liveWorker, testWorker]);
    const job = makeJob(DataRealm.LIVE);

    const candidates = await runHardFilter(db as never, kms, job, null, false, false);

    expect(candidates.map(c => c.workerId)).toEqual(['worker-live-1']);
    expect(candidates.map(c => c.workerId)).not.toContain('worker-test-1');
  });

  it('vaga TEST + worker LIVE elegível → NÃO casa; worker TEST elegível → casa', async () => {
    const db = makeFakeDb([liveWorker, testWorker]);
    const job = makeJob(DataRealm.TEST);

    const candidates = await runHardFilter(db as never, kms, job, null, false, false);

    expect(candidates.map(c => c.workerId)).toEqual(['worker-test-1']);
    expect(candidates.map(c => c.workerId)).not.toContain('worker-live-1');
  });

  it('candidatos retornados carregam o próprio realm derivado de is_test', async () => {
    const db = makeFakeDb([liveWorker]);
    const job = makeJob(DataRealm.LIVE);

    const [candidate] = await runHardFilter(db as never, kms, job, null, false, false);

    expect(candidate.realm.equals(DataRealm.LIVE)).toBe(true);
  });

  it('binda o realm da vaga (não um valor fixo) no clause de segregação', async () => {
    const db = makeFakeDb([liveWorker, testWorker]);

    await runHardFilter(db as never, kms, makeJob(DataRealm.TEST), null, false, false);

    const [sql, params] = (db.query as jest.Mock).mock.calls[0];
    const match = (sql as string).match(IS_TEST_CLAUSE);
    expect(match).not.toBeNull();
    expect(params[Number(match![1]) - 1]).toBe(true);
  });
});
