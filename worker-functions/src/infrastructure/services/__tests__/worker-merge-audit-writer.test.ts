/**
 * worker-merge-audit-writer.test.ts
 *
 * Garante que o rastro COMPLETO (quem/de onde/como) é de fato gravado em
 * worker_merge_audit — peça central da exigência de auditoria minuciosa.
 */

import type { PoolClient } from 'pg';
import { insertMergeAuditRow, recordUndoAudit } from '../WorkerMergeAuditWriter';

function makeClient(responses: Array<{ rows: unknown[] }>): {
  client: PoolClient;
  query: jest.Mock;
} {
  let i = 0;
  const query = jest.fn().mockImplementation(() => Promise.resolve(responses[i++] ?? { rows: [] }));
  return { client: { query } as unknown as PoolClient, query };
}

const SURV = 'aaaaaaaa-0000-0000-0000-000000000001';
const ABS = 'aaaaaaaa-0000-0000-0000-000000000002';

describe('insertMergeAuditRow — persiste ator/contexto/overrides', () => {
  it('grava executed_by, email, source, confirmed, ip, ua, request_id, overrides e emails das contas', async () => {
    const { client, query } = makeClient([
      // emails das duas contas
      { rows: [{ id: SURV, email: 'surv@x.com' }, { id: ABS, email: 'abs@x.com' }] },
      // INSERT RETURNING id
      { rows: [{ id: '777' }] },
    ]);

    const auditId = await insertMergeAuditRow(client, {
      survivorId: SURV,
      absorbedId: ABS,
      phoneNormalized: '5491100000001',
      category: 'firebase',
      legalFieldExceptions: [],
      audit: {
        executedBy: 'uid-1',
        executedByEmail: 'admin@enlite.health',
        source: 'manual',
        confirmedSamePerson: true,
        ipAddress: '203.0.113.9',
        userAgent: 'agent/1',
        requestId: 'req-xyz',
        fieldChoices: { first_name_encrypted: ABS },
        appliedOverrides: [{ field: 'first_name_encrypted', from_account_id: ABS }],
      },
    });

    expect(auditId).toBe(BigInt(777));

    const insertCall = query.mock.calls.find(c => String(c[0]).includes('INSERT INTO worker_merge_audit'));
    expect(insertCall).toBeTruthy();
    const sql = String(insertCall![0]);
    const params = insertCall![1] as unknown[];

    // Colunas-chave presentes no INSERT
    for (const col of [
      'executed_by', 'executed_by_email', 'source', 'confirmed_same_person',
      'ip_address', 'user_agent', 'request_id', 'field_choices', 'applied_overrides',
      'survivor_email', 'absorbed_email',
    ]) {
      expect(sql).toContain(col);
    }

    // Valores propagados
    expect(params).toContain('uid-1');
    expect(params).toContain('admin@enlite.health');
    expect(params).toContain('manual');
    expect(params).toContain(true);
    expect(params).toContain('203.0.113.9');
    expect(params).toContain('req-xyz');
    expect(params).toContain('surv@x.com');
    expect(params).toContain('abs@x.com');
    expect(params).toContain(JSON.stringify([{ field: 'first_name_encrypted', from_account_id: ABS }]));
  });

  it('defaults para merge automático em lote (sem ator): executed_by=system, source=auto_batch', async () => {
    const { client, query } = makeClient([
      { rows: [] },              // emails (vazio)
      { rows: [{ id: '5' }] },   // INSERT
    ]);

    await insertMergeAuditRow(client, {
      survivorId: SURV,
      absorbedId: ABS,
      phoneNormalized: '549110',
      category: 'ghost',
      legalFieldExceptions: [],
      audit: {},
    });

    const insertCall = query.mock.calls.find(c => String(c[0]).includes('INSERT INTO worker_merge_audit'));
    const params = insertCall![1] as unknown[];
    expect(params).toContain('system');
    expect(params).toContain('auto_batch');
  });
});

describe('recordUndoAudit — carimba quem desfez', () => {
  it('faz UPDATE com undone_by/email/at/ip/ua/request_id', async () => {
    const { client, query } = makeClient([{ rows: [] }]);

    await recordUndoAudit(client, 42, {
      undoneBy: 'uid-undo',
      undoneByEmail: 'undo@enlite.health',
      ipAddress: '198.51.100.2',
      userAgent: 'agent/2',
      requestId: 'req-undo',
    });

    const sql = String(query.mock.calls[0][0]);
    const params = query.mock.calls[0][1] as unknown[];
    expect(sql).toContain('UPDATE worker_merge_audit');
    expect(sql).toContain('undone_by');
    expect(sql).toContain('undone_at = NOW()');
    expect(params).toEqual([42, 'uid-undo', 'undo@enlite.health', '198.51.100.2', 'agent/2', 'req-undo']);
  });

  it('default undone_by=system quando ator ausente', async () => {
    const { client, query } = makeClient([{ rows: [] }]);
    await recordUndoAudit(client, 7, {});
    const params = query.mock.calls[0][1] as unknown[];
    expect(params[1]).toBe('system');
  });
});
