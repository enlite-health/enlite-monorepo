/**
 * UpdateWorkerProfileFieldsUseCase — transação + carimbo + trilha de fonte (D92).
 *
 * Garante o contrato da change luz-cadastro-assistido-rastreavel:
 *  - toda escrita roda em transação com set_config('app.current_uid') ANTES dos updates
 *  - a trilha (worker_profile_changes_audit) entra na MESMA transação, com a fonte
 *  - erro no meio → ROLLBACK (nem edição nem trilha)
 *  - log profile_edit sai por campo, SEM o valor (Ley 25.326)
 */

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn().mockImplementation(async () => ({
  query: mockClientQuery,
  release: mockRelease,
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({
      getPool: jest.fn().mockReturnValue({
        query: mockPoolQuery,
        connect: mockConnect,
      }),
    }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({
    encrypt: jest.fn().mockResolvedValue('ENC'),
    decrypt: jest.fn().mockResolvedValue(''),
    encryptBatch: jest.fn().mockImplementation(async (fields: Record<string, string>) =>
      Object.fromEntries(Object.keys(fields).map((k) => [k, `ENC(${k})`])),
    ),
  })),
}));

jest.mock('@shared/security/BlindIndexService', () => ({
  BlindIndexService: jest.fn().mockImplementation(() => ({
    generateNameTrigramBidx: jest.fn().mockResolvedValue([]),
    generateValuesBidx: jest.fn().mockResolvedValue([]),
    serializeForPg: jest.fn().mockReturnValue('{}'),
  })),
}));

const mockLogInfo = jest.fn();
jest.mock('@shared/logging', () => ({
  logger: {
    child: jest.fn().mockImplementation(() => ({
      info: mockLogInfo,
      warn: jest.fn(),
      debug: jest.fn(),
    })),
  },
  loggingAls: { getStore: jest.fn().mockReturnValue(undefined) },
  reportError: jest.fn(),
}));

import { UpdateWorkerProfileFieldsUseCase, WorkerNotFoundError } from '../UpdateWorkerProfileFieldsUseCase';

const WORKER_ID = '123e4567-e89b-12d3-a456-426614174000';

/** pool.query: existe worker + snapshot before + enqueue mirror. */
function primePoolQueries(beforeRow: Record<string, unknown> = {}) {
  mockPoolQuery.mockImplementation(async (sql: string) => {
    if (String(sql).includes('SELECT id FROM workers')) return { rows: [{ id: WORKER_ID }] };
    if (String(sql).startsWith('SELECT email')) return { rows: [beforeRow] };
    if (String(sql).includes('domain_events')) return { rows: [{ id: 'evt-1' }] };
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  primePoolQueries({ profession: 'CAREGIVER' });
  mockClientQuery.mockResolvedValue({ rows: [] });
});

describe('UpdateWorkerProfileFieldsUseCase — transação + trilha de fonte', () => {
  it('roda em transação com set_config(app.current_uid) ANTES do update, e audita na mesma transação', async () => {
    const useCase = new UpdateWorkerProfileFieldsUseCase();

    const result = await useCase.execute(
      { workerId: WORKER_ID, profession: 'AT' },
      { source: 'luz_conversation', actorUid: 'luz:profile-update' },
    );

    expect(result.fieldsUpdated).toEqual(['profession']);

    const sqls = mockClientQuery.mock.calls.map(([sql]) => String(sql));
    const iBegin = sqls.findIndex((s) => s === 'BEGIN');
    const iStamp = sqls.findIndex((s) => s.includes('set_config'));
    const iUpdate = sqls.findIndex((s) => s.includes('UPDATE workers'));
    const iAudit = sqls.findIndex((s) => s.includes('worker_profile_changes_audit'));
    const iCommit = sqls.findIndex((s) => s === 'COMMIT');

    // ordem: BEGIN → carimbo → update → trilha → COMMIT (tudo no MESMO client)
    expect(iBegin).toBeGreaterThanOrEqual(0);
    expect(iStamp).toBeGreaterThan(iBegin);
    expect(iUpdate).toBeGreaterThan(iStamp);
    expect(iAudit).toBeGreaterThan(iUpdate);
    expect(iCommit).toBeGreaterThan(iAudit);

    // carimbo com o actorUid recebido
    expect(mockClientQuery.mock.calls[iStamp][1]).toEqual(['luz:profile-update']);

    // trilha: fonte + de→para legível (profession é coluna plaintext, não-PII)
    expect(mockClientQuery.mock.calls[iAudit][1]).toEqual(
      expect.arrayContaining(['profession', 'CAREGIVER', 'AT', 'luz_conversation', 'triage']),
    );

    expect(mockRelease).toHaveBeenCalled();
  });

  it('fonte admin_panel carimba o uid do staff e canal admin', async () => {
    const useCase = new UpdateWorkerProfileFieldsUseCase();

    await useCase.execute(
      { workerId: WORKER_ID, profession: 'AT' },
      { source: 'admin_panel', actorUid: 'staff-uid-1' },
    );

    const stamp = mockClientQuery.mock.calls.find(([sql]) => String(sql).includes('set_config'));
    expect(stamp![1]).toEqual(['staff-uid-1']);
    const audit = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('worker_profile_changes_audit'),
    );
    expect(audit![1]).toEqual(expect.arrayContaining(['admin_panel', 'admin']));
  });

  it('PII fica REDIGIDA na trilha (nome mascarado, doc last-4)', async () => {
    const useCase = new UpdateWorkerProfileFieldsUseCase();

    await useCase.execute(
      { workerId: WORKER_ID, firstName: 'Ana', documentNumber: '99887766' },
      { source: 'luz_conversation', actorUid: 'luz:profile-confirm' },
    );

    const audit = mockClientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('worker_profile_changes_audit'),
    );
    const values = audit![1] as unknown[];
    expect(values).toContain('***');
    expect(values).toContain('***7766');
    expect(values).not.toContain('Ana');
    expect(values).not.toContain('99887766');
  });

  it('erro no update → ROLLBACK e nada de trilha', async () => {
    mockClientQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('UPDATE workers')) throw new Error('db error');
      return { rows: [] };
    });
    const useCase = new UpdateWorkerProfileFieldsUseCase();

    await expect(
      useCase.execute(
        { workerId: WORKER_ID, profession: 'AT' },
        { source: 'luz_conversation', actorUid: 'luz:profile-update' },
      ),
    ).rejects.toThrow('db error');

    const sqls = mockClientQuery.mock.calls.map(([sql]) => String(sql));
    expect(sqls).toContain('ROLLBACK');
    expect(sqls.some((s) => s.includes('worker_profile_changes_audit'))).toBe(false);
    expect(mockRelease).toHaveBeenCalled();
  });

  it('log profile_edit sai por campo SEM o valor (Ley 25.326)', async () => {
    const useCase = new UpdateWorkerProfileFieldsUseCase();

    await useCase.execute(
      { workerId: WORKER_ID, firstName: 'Ana', profession: 'AT' },
      { source: 'luz_conversation', actorUid: 'luz:profile-update' },
    );

    const editLogs = mockLogInfo.mock.calls
      .map(([payload]) => payload as Record<string, unknown>)
      .filter((p) => p?.msg === 'profile_edit');

    expect(editLogs.length).toBe(2);
    for (const p of editLogs) {
      // payload EXATO: msg + field + source — nenhum valor de campo
      expect(Object.keys(p).sort()).toEqual(['field', 'msg', 'source']);
      expect(JSON.stringify(p)).not.toContain('Ana');
    }
    expect(editLogs.map((p) => p.field).sort()).toEqual(['firstName', 'profession']);
  });

  it('worker inexistente → WorkerNotFoundError sem abrir transação', async () => {
    mockPoolQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT id FROM workers')) return { rows: [] };
      return { rows: [] };
    });
    const useCase = new UpdateWorkerProfileFieldsUseCase();

    await expect(
      useCase.execute(
        { workerId: WORKER_ID, profession: 'AT' },
        { source: 'admin_panel', actorUid: 'staff' },
      ),
    ).rejects.toBeInstanceOf(WorkerNotFoundError);
    expect(mockConnect).not.toHaveBeenCalled();
  });
});
