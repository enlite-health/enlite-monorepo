/**
 * worker-merge-snapshot.test.ts
 *
 * Testes unitários do WorkerMergeSnapshotService.
 * Usa mock de PoolClient — sem banco real.
 *
 * Cobertos:
 *   captureSnapshot  → serializa worker_row + fk_rows, persiste, retorna snapshotId
 *                    → tabela FK inexistente (drift) não interrompe o snapshot
 *   restoreSnapshot  → restaura worker_row, linhas FK, marca undone_at
 *                    → idempotência: undone_at já preenchido retorna alreadyUndone=true
 *                    → lança erro se snapshot não encontrado
 */

jest.mock('@shared/logging', () => ({
  logger:      { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls:  { run: jest.fn() },
}));

import type { PoolClient } from 'pg';
import { captureSnapshot, restoreSnapshot } from '../WorkerMergeSnapshotService';
import type { FkTableInfo } from '../WorkerPhoneMergeFkDiscovery';

// ── Helpers de mock ────────────────────────────────────────────────────────

type QueryFn = (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;

function makeClient(responses: Array<{ rows: unknown[] }>, failOnTable?: string): PoolClient {
  let idx = 0;
  return {
    query: jest.fn().mockImplementation((sql: string, _params?: unknown[]) => {
      if (failOnTable && sql.includes(failOnTable)) {
        return Promise.reject(new Error(`relation "${failOnTable}" does not exist`));
      }
      const resp = responses[idx++] ?? { rows: [] };
      return Promise.resolve(resp);
    }),
  } as unknown as PoolClient;
}

const SAMPLE_FK_INFO: FkTableInfo[] = [
  { table: 'worker_job_applications', fk_column: 'worker_id', strategy: 'upsert_delete', unique_cols: ['worker_id', 'job_posting_id'] },
  { table: 'worker_documents',         fk_column: 'worker_id', strategy: 'upsert_delete', unique_cols: ['worker_id'] },
];

// ── captureSnapshot ────────────────────────────────────────────────────────

describe('captureSnapshot', () => {
  it('serializa worker_row + fk_rows e persiste no banco', async () => {
    const workerRow = { id: 'absorbed-id', email: 'test@example.com', status: 'INCOMPLETE_REGISTER' };
    const wjaRows  = [{ worker_id: 'absorbed-id', job_posting_id: 'jp-1' }];
    const docsRows = [{ worker_id: 'absorbed-id', curriculum_url: 'http://cv.pdf' }];

    const client = makeClient([
      { rows: [workerRow] },       // SELECT * FROM workers
      { rows: wjaRows },            // SELECT * FROM worker_job_applications
      { rows: docsRows },           // SELECT * FROM worker_documents
      { rows: [{ id: 'snap-uuid-1' }] }, // INSERT INTO worker_merge_snapshots
    ]);

    const snapshotId = await captureSnapshot(client, {
      mergeAuditId: 10n,
      absorbedId: 'absorbed-id',
      discoveredFks: SAMPLE_FK_INFO,
    });

    expect(snapshotId).toBe('snap-uuid-1');

    // Verifica que o INSERT foi chamado com payload JSON correto
    const calls = (client.query as jest.Mock).mock.calls;
    const insertCall = calls.find((c: [string, unknown[]]) => c[0].includes('INSERT INTO worker_merge_snapshots'));
    expect(insertCall).toBeDefined();

    const payload = JSON.parse(insertCall[1][2] as string);
    expect(payload.worker_row).toMatchObject(workerRow);
    expect(payload.fk_rows['worker_job_applications:worker_id']).toHaveLength(1);
    expect(payload.fk_rows['worker_documents:worker_id']).toHaveLength(1);
  });

  it('tabela FK inexistente (drift) não interrompe o snapshot', async () => {
    const workerRow = { id: 'abs', email: 'x@x.com', status: 'INCOMPLETE_REGISTER' };
    const wjaRows   = [{ worker_id: 'abs', job_posting_id: 'jp-2' }];

    const client = makeClient([
      { rows: [workerRow] },
      { rows: wjaRows },
      // worker_documents vai falhar (drift)
      { rows: [{ id: 'snap-uuid-2' }] },
    ], 'worker_documents');

    const snapshotId = await captureSnapshot(client, {
      mergeAuditId: 11,
      absorbedId: 'abs',
      discoveredFks: SAMPLE_FK_INFO,
    });

    expect(snapshotId).toBe('snap-uuid-2');
  });

  it('usa {} quando workers query retorna 0 linhas (branch ?? {} linha 59)', async () => {
    // workers retorna 0 linhas → workerRow = rows[0] ?? {} = {}
    const client = makeClient([
      { rows: [] },              // SELECT * FROM workers → 0 rows
      { rows: [] },              // worker_job_applications: 0 linhas
      { rows: [] },              // worker_documents: 0 linhas
      { rows: [{ id: 'snap-0-rows' }] },
    ]);

    const snapshotId = await captureSnapshot(client, {
      mergeAuditId: 20,
      absorbedId: 'abs-not-found',
      discoveredFks: SAMPLE_FK_INFO,
    });

    expect(snapshotId).toBe('snap-0-rows');

    // Payload deve ter worker_row vazio
    const calls = (client.query as jest.Mock).mock.calls;
    const insertCall = calls.find((c: [string, unknown[]]) => c[0].includes('INSERT INTO worker_merge_snapshots'));
    const payload = JSON.parse(insertCall[1][2] as string);
    expect(payload.worker_row).toEqual({});
  });

  it('wraps non-Error em Error no catch de FK (branch ?? new Error, linha 75)', async () => {
    const workerRow = { id: 'abs-wrap', email: 'x@y.com' };

    // Simula FK query lançando string (não Error)
    let callIdx = 0;
    const clientNonError = {
      query: jest.fn().mockImplementation((sql: string) => {
        callIdx++;
        if (callIdx === 1) return Promise.resolve({ rows: [workerRow] });   // SELECT workers
        if (sql.includes('worker_job_applications')) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject('string error not Error instance');
        }
        if (sql.includes('worker_documents')) return Promise.resolve({ rows: [] });
        return Promise.resolve({ rows: [{ id: 'snap-non-err' }] });         // INSERT snapshot
      }),
    } as unknown as import('pg').PoolClient;

    const snapshotId = await captureSnapshot(clientNonError, {
      mergeAuditId: 21,
      absorbedId: 'abs-wrap',
      discoveredFks: SAMPLE_FK_INFO,
    });

    // Deve ter concluído sem lançar, retornando o snapshotId
    expect(snapshotId).toBe('snap-non-err');
  });

  it('não inclui tabelas FK com 0 linhas no payload', async () => {
    const workerRow = { id: 'abs-2', status: 'COMPLETE_REGISTER' };

    const client = makeClient([
      { rows: [workerRow] },
      { rows: [] },              // worker_job_applications: 0 linhas
      { rows: [] },              // worker_documents: 0 linhas
      { rows: [{ id: 'snap-uuid-3' }] },
    ]);

    await captureSnapshot(client, {
      mergeAuditId: 12,
      absorbedId: 'abs-2',
      discoveredFks: SAMPLE_FK_INFO,
    });

    const calls = (client.query as jest.Mock).mock.calls;
    const insertCall = calls.find((c: [string, unknown[]]) => c[0].includes('INSERT INTO worker_merge_snapshots'));
    const payload = JSON.parse(insertCall[1][2] as string);

    // fk_rows deve estar vazio (sem tabelas com linhas)
    expect(Object.keys(payload.fk_rows)).toHaveLength(0);
  });
});

// ── restoreSnapshot ────────────────────────────────────────────────────────

describe('restoreSnapshot', () => {
  const snapshotPayload = {
    worker_row: {
      id: 'absorbed-uuid',
      email: 'old@example.com',
      status: 'INCOMPLETE_REGISTER',
      merged_into_id: null,
    },
    fk_rows: {
      'worker_job_applications:worker_id': [
        { worker_id: 'absorbed-uuid', job_posting_id: 'jp-deleted', created_at: '2026-01-01' },
      ],
    },
  };

  it('restaura worker_row, fk_rows e marca undone_at (com id na row → usa id no DELETE)', async () => {
    // Snapshot com row que tem 'id' → DELETE usa apenas id (evita comparação de timestamps)
    const snapshotWithId = {
      worker_row: {
        id: 'absorbed-uuid',
        email: 'old@example.com',
        status: 'INCOMPLETE_REGISTER',
        merged_into_id: null,
      },
      fk_rows: {
        'worker_job_applications:worker_id': [
          { id: 'wja-uuid-1', worker_id: 'absorbed-uuid', job_posting_id: 'jp-deleted', created_at: '2026-01-01T00:00:00Z' },
        ],
      },
    };

    const client = makeClient([
      // SELECT snapshot
      { rows: [{ id: 'snap-1', payload: snapshotWithId, undone_at: null }] },
      // UPDATE workers (reativa merged_into_id = NULL)
      { rows: [] },
      // UPDATE workers (restoreWorkerRow)
      { rows: [] },
      // SELECT information_schema.columns (worker_job_applications) — inclui 'id'
      { rows: [{ column_name: 'id' }, { column_name: 'worker_id' }, { column_name: 'job_posting_id' }, { column_name: 'created_at' }] },
      // DELETE por id (não por todos os campos)
      { rows: [] },
      // INSERT linha original do absorvido
      { rows: [] },
      // UPDATE worker_merge_snapshots SET undone_at
      { rows: [] },
    ]);

    const result = await restoreSnapshot(client, {
      mergeAuditId: 10,
      survivorId: 'survivor-uuid',
      absorbedId: 'absorbed-uuid',
    });

    expect(result.alreadyUndone).toBe(false);

    // Verifica que undone_at foi marcado
    const calls = (client.query as jest.Mock).mock.calls;
    const undoneCall = calls.find((c: [string, unknown[]]) =>
      c[0].includes('UPDATE worker_merge_snapshots SET undone_at'),
    );
    expect(undoneCall).toBeDefined();
  });

  it('retorna alreadyUndone=true quando undone_at já está preenchido', async () => {
    const client = makeClient([
      { rows: [{ id: 'snap-2', payload: snapshotPayload, undone_at: new Date() }] },
    ]);

    const result = await restoreSnapshot(client, {
      mergeAuditId: 10,
      survivorId: 'survivor-uuid',
      absorbedId: 'absorbed-uuid',
    });

    expect(result.alreadyUndone).toBe(true);
    // Não deve ter chamado nenhuma operação de escrita
    const calls = (client.query as jest.Mock).mock.calls;
    expect(calls).toHaveLength(1); // apenas o SELECT do snapshot
  });

  it('skip quando tableKey não tem ":" separador (branch linha 173)', async () => {
    // fk_rows com chave sem ":" → tableName ou fkColumn serão undefined → continue
    const snapshotBadKey = {
      worker_row: { id: 'abs-bad', email: 'b@b.com', merged_into_id: null },
      fk_rows: {
        'no_separator_key': [{ worker_id: 'abs-bad' }],  // sem ":"
        'valid_table:worker_id': [],                       // sem rows → não processado
      },
    };

    let callIdx = 0;
    const clientBadKey = {
      query: jest.fn().mockImplementation((_sql: string) => {
        callIdx++;
        if (callIdx === 1) return Promise.resolve({ rows: [{ id: 'snap-bk', payload: snapshotBadKey, undone_at: null }] });
        if (callIdx === 2) return Promise.resolve({ rows: [] }); // merged_into_id = NULL
        if (callIdx === 3) return Promise.resolve({ rows: [] }); // restoreWorkerRow: todas SKIP ou vazio
        // undone_at update
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as import('pg').PoolClient;

    const result = await restoreSnapshot(clientBadKey, {
      mergeAuditId: 15,
      survivorId: 'sv',
      absorbedId: 'abs-bad',
    });

    expect(result.alreadyUndone).toBe(false);
  });

  it('restoreWorkerRow com workerRow contendo APENAS colunas SKIP_COLS (branch setClauses.length === 0, linha 226)', async () => {
    // worker_row tem apenas id, phone_normalized, created_at → setClauses = [] → early return sem UPDATE
    const snapshotSkipOnly = {
      worker_row: { id: 'abs-skip', phone_normalized: '549100', created_at: new Date() },
      fk_rows: {},
    };

    let callIdx = 0;
    const clientSkipCols = {
      query: jest.fn().mockImplementation((_sql: string) => {
        callIdx++;
        if (callIdx === 1) return Promise.resolve({ rows: [{ id: 'snap-sc', payload: snapshotSkipOnly, undone_at: null }] });
        if (callIdx === 2) return Promise.resolve({ rows: [] }); // merged_into_id = NULL
        // callIdx 3 seria restoreWorkerRow mas como setClauses.length===0, não há chamada de UPDATE
        // undone_at update
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as import('pg').PoolClient;

    const result = await restoreSnapshot(clientSkipCols, {
      mergeAuditId: 16,
      survivorId: 'sv',
      absorbedId: 'abs-skip',
    });

    expect(result.alreadyUndone).toBe(false);

    // Apenas 3 chamadas: SELECT snapshot, UPDATE merged_into_id=NULL, UPDATE undone_at
    expect((clientSkipCols.query as jest.Mock)).toHaveBeenCalledTimes(3);
  });

  it('skip quando information_schema falha ao buscar colunas da tabela FK (branch 270-271)', async () => {
    // Testa o branch: query de information_schema lança → warn + return
    const snapshotWithFkRows = {
      worker_row: { id: 'absorbed-uuid', email: 'old@example.com', status: 'INCOMPLETE_REGISTER', merged_into_id: null },
      fk_rows: {
        'worker_job_applications:worker_id': [
          { worker_id: 'absorbed-uuid', job_posting_id: 'jp-1' },
        ],
      },
    };

    let callIdx = 0;
    const clientWithSchemaError = {
      query: jest.fn().mockImplementation((sql: string) => {
        callIdx++;
        if (callIdx === 1) {
          return Promise.resolve({ rows: [{ id: 'snap-x', payload: snapshotWithFkRows, undone_at: null }] });
        }
        if (callIdx === 2) {
          // UPDATE workers SET merged_into_id = NULL
          return Promise.resolve({ rows: [] });
        }
        if (callIdx === 3) {
          // UPDATE workers (restoreWorkerRow)
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('information_schema.columns')) {
          // Simula erro ao buscar colunas → branch catch (linhas 270-271)
          return Promise.reject(new Error('relation does not exist'));
        }
        // UPDATE worker_merge_snapshots SET undone_at
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as import('pg').PoolClient;

    const result = await restoreSnapshot(clientWithSchemaError, {
      mergeAuditId: 11,
      survivorId: 'survivor-uuid',
      absorbedId: 'absorbed-uuid',
    });

    // Não deve lançar; undo concluído (alreadyUndone=false)
    expect(result.alreadyUndone).toBe(false);
  });

  it('continua (sem lançar) quando INSERT de linha FK falha com Error (branch 307 true)', async () => {
    // Testa o branch: INSERT lança Error → reportError + continua
    const snapshotWithFkRows = {
      worker_row: { id: 'absorbed-uuid', email: 'old@example.com', status: 'INCOMPLETE_REGISTER', merged_into_id: null },
      fk_rows: {
        'worker_job_applications:worker_id': [
          { worker_id: 'absorbed-uuid', job_posting_id: 'jp-fail' },
        ],
      },
    };

    let callIdx = 0;
    const clientWithInsertError = {
      query: jest.fn().mockImplementation((sql: string) => {
        callIdx++;
        if (callIdx === 1) {
          return Promise.resolve({ rows: [{ id: 'snap-y', payload: snapshotWithFkRows, undone_at: null }] });
        }
        if (callIdx === 2) {
          return Promise.resolve({ rows: [] }); // merged_into_id = NULL
        }
        if (callIdx === 3) {
          return Promise.resolve({ rows: [] }); // restoreWorkerRow UPDATE
        }
        if (sql.includes('information_schema.columns')) {
          return Promise.resolve({ rows: [{ column_name: 'worker_id' }, { column_name: 'job_posting_id' }] });
        }
        if (sql.includes('DELETE FROM')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('INSERT INTO worker_job_applications')) {
          // Simula falha no INSERT com Error (branch true de instanceof Error)
          return Promise.reject(new Error('unique constraint violated'));
        }
        // UPDATE worker_merge_snapshots SET undone_at
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as import('pg').PoolClient;

    // Não deve lançar — reportError é chamado internamente e continua
    const result = await restoreSnapshot(clientWithInsertError, {
      mergeAuditId: 12,
      survivorId: 'survivor-uuid',
      absorbedId: 'absorbed-uuid',
    });

    expect(result.alreadyUndone).toBe(false);
  });

  it('continua quando INSERT lança não-Error (branch 307 false: new Error(String(err)))', async () => {
    // Testa o branch false: err não é instância de Error → new Error(String(err))
    const snapshotWithFkRows = {
      worker_row: { id: 'absorbed-uuid', email: 'old@example.com', merged_into_id: null },
      fk_rows: {
        'worker_job_applications:worker_id': [
          { worker_id: 'absorbed-uuid', job_posting_id: 'jp-non-err' },
        ],
      },
    };

    let callIdx = 0;
    const clientWithNonError = {
      query: jest.fn().mockImplementation((sql: string) => {
        callIdx++;
        if (callIdx === 1) {
          return Promise.resolve({ rows: [{ id: 'snap-ne', payload: snapshotWithFkRows, undone_at: null }] });
        }
        if (callIdx === 2) {
          return Promise.resolve({ rows: [] }); // merged_into_id = NULL
        }
        if (callIdx === 3) {
          return Promise.resolve({ rows: [] }); // restoreWorkerRow UPDATE
        }
        if (sql.includes('information_schema.columns')) {
          return Promise.resolve({ rows: [{ column_name: 'worker_id' }, { column_name: 'job_posting_id' }] });
        }
        if (sql.includes('DELETE FROM')) {
          return Promise.resolve({ rows: [] });
        }
        if (sql.includes('INSERT INTO worker_job_applications')) {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
          return Promise.reject('non-error string thrown');
        }
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as import('pg').PoolClient;

    const result = await restoreSnapshot(clientWithNonError, {
      mergeAuditId: 17,
      survivorId: 'survivor-uuid',
      absorbedId: 'absorbed-uuid',
    });

    expect(result.alreadyUndone).toBe(false);
  });

  it('restoreFkRows com otherCols vazio (fkColumn único campo) — skip do DELETE', async () => {
    // Snapshot onde a única coluna da linha FK é o próprio fkColumn
    // → otherCols.length === 0 → skip do DELETE
    const snapshotMinimalFk = {
      worker_row: { id: 'absorbed-uuid', email: 'x@e.com', merged_into_id: null },
      fk_rows: {
        'some_table:worker_id': [
          // row com SOMENTE o worker_id → otherCols = [] → sem DELETE
          { worker_id: 'absorbed-uuid' },
        ],
      },
    };

    let callIdx = 0;
    const clientMinimal = {
      query: jest.fn().mockImplementation((sql: string) => {
        callIdx++;
        if (callIdx === 1) {
          return Promise.resolve({ rows: [{ id: 'snap-z', payload: snapshotMinimalFk, undone_at: null }] });
        }
        if (callIdx === 2) {
          return Promise.resolve({ rows: [] }); // merged_into_id = NULL
        }
        if (callIdx === 3) {
          return Promise.resolve({ rows: [] }); // restoreWorkerRow UPDATE
        }
        if (sql.includes('information_schema.columns')) {
          // apenas worker_id disponível
          return Promise.resolve({ rows: [{ column_name: 'worker_id' }] });
        }
        // INSERT (sem DELETE pois otherCols vazio)
        return Promise.resolve({ rows: [] });
      }),
    } as unknown as import('pg').PoolClient;

    const result = await restoreSnapshot(clientMinimal, {
      mergeAuditId: 13,
      survivorId: 'survivor-uuid',
      absorbedId: 'absorbed-uuid',
    });

    expect(result.alreadyUndone).toBe(false);

    // Não deve ter chamado DELETE
    const calls = (clientMinimal.query as jest.Mock).mock.calls;
    const deleteCall = calls.find((c: [string, unknown[]]) => c[0].includes('DELETE FROM some_table'));
    expect(deleteCall).toBeUndefined();
  });

  it('lança erro quando snapshot não encontrado', async () => {
    const client = makeClient([
      { rows: [] }, // snapshot não existe
    ]);

    await expect(restoreSnapshot(client, {
      mergeAuditId: 999,
      survivorId: 'sv',
      absorbedId: 'ab',
    })).rejects.toThrow('Snapshot não encontrado');
  });
});
