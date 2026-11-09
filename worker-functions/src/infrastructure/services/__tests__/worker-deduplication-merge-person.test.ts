/**
 * worker-deduplication-merge-person.test.ts — T130 (spec acesso-do-cliente, D648).
 *
 * `mergeWorkers` (dedup por LLM) tem de chamar `iam.merge_person(absorvido, sobrevivente, NULL)` no MESMO client da
 * transação de merge, DEPOIS do UPDATE de workers.merged_into_id (o gate da função confere esse ponteiro) e ANTES do
 * COMMIT. Client dublê registra as queries na ordem; nenhum banco, nenhum LLM.
 */
jest.mock('@shared/database/DatabaseConnection');
jest.mock('../../repositories/AnalyticsRepository');
jest.mock('@shared/security/KMSEncryptionService');
jest.mock('@shared/security/BlindIndexService');

import { WorkerDeduplicationService } from '../WorkerDeduplicationService';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { KMSEncryptionService } from '@shared/security/KMSEncryptionService';
import { BlindIndexService } from '@shared/security/BlindIndexService';

describe('mergeWorkers — gancho iam.merge_person (T130)', () => {
  const resolved = { phone: null, email: 'x@enlite.test', firstName: null, lastName: null, cuit: null };

  it('iam.merge_person sai depois do UPDATE de merged_into_id e antes do COMMIT, no mesmo client, com auditId NULL', async () => {
    const log: Array<{ client: string; sql: string; params?: unknown[] }> = [];
    const mkClient = (name: string) => ({
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        log.push({ client: name, sql: String(sql), params });
        return { rows: [], rowCount: 0 };
      }),
      release: jest.fn(),
    });
    const client = mkClient('tx');
    const pool = { query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }), connect: jest.fn().mockResolvedValue(client) };
    (DatabaseConnection.getInstance as jest.Mock).mockReturnValue({ getPool: () => pool });
    (KMSEncryptionService as jest.Mock).mockImplementation(() => ({ encrypt: jest.fn(), decrypt: jest.fn() }));
    (BlindIndexService as jest.Mock).mockImplementation(() => ({
      generateNameTrigramBidx: jest.fn().mockResolvedValue([]),
      serializeForPg: jest.fn().mockReturnValue('{}'),
    }));

    await new WorkerDeduplicationService().mergeWorkers('canonical-id', 'duplicate-id', resolved);

    const sqls = log.map((l) => l.sql);
    const iUpdate = sqls.findIndex((s) => /UPDATE workers SET merged_into_id/.test(s));
    const iHook = sqls.findIndex((s) => /iam\.merge_person/.test(s));
    const iCommit = sqls.findIndex((s) => s === 'COMMIT');
    expect(iUpdate).toBeGreaterThan(-1);
    expect(iHook).toBeGreaterThan(iUpdate);
    expect(iCommit).toBeGreaterThan(iHook);
    expect(log.every((l) => l.client === 'tx')).toBe(true);
    expect(pool.query).not.toHaveBeenCalledWith(expect.stringMatching(/iam\.merge_person/), expect.anything());
    // absorvido = duplicata, sobrevivente = canônico; sem audit (SQL literal NULL, params só os dois ids)
    expect(log[iHook].params).toEqual(['duplicate-id', 'canonical-id']);
    expect(log[iHook].sql).toMatch(/merge_person\(a\.auth_uid, s\.auth_uid, NULL\)/);
  });
});
