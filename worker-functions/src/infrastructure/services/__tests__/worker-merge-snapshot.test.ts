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

  it('restaura worker_row, fk_rows e marca undone_at', async () => {
    const client = makeClient([
      // SELECT snapshot
      { rows: [{ id: 'snap-1', payload: snapshotPayload, undone_at: null }] },
      // UPDATE workers (reativa merged_into_id = NULL)
      { rows: [] },
      // UPDATE workers (restoreWorkerRow)
      { rows: [] },
      // SELECT information_schema.columns (worker_job_applications)
      { rows: [{ column_name: 'worker_id' }, { column_name: 'job_posting_id' }, { column_name: 'created_at' }] },
      // DELETE conflitos no survivor
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
