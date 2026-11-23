import { ClaimShellAbsorber } from '../ClaimShellAbsorber';

jest.mock('@shared/logging', () => {
  const shared = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger: { child: () => shared, ...shared }, reportError: jest.fn(), __shared: shared };
});
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mockLogs = (require('@shared/logging') as { __shared: { error: jest.Mock } }).__shared;

// D764: o consentimento do OTP é gravado em X DENTRO da transação da absorção (mesmo client), sem tocar auth_uid.
const X = '0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f';
const IMP = 'a1b2c3d4-1234-4abc-8def-9876543210ab';
const consentAt = new Date('2026-11-21T10:00:00Z');

function harness(failConsent: 'pg' | 'zero' | null) {
  const calls: string[] = [];
  const client = {
    release: jest.fn(),
    query: jest.fn(async (sql: string) => {
      const s = sql.trim();
      calls.push(s.split(/\s+/)[0] + (s.includes('lgpd_consent_at') ? ':consent' : ''));
      if (s.includes('FROM workers WHERE id = ANY')) {
        return { rowCount: 2, rows: [
          { id: X, phone: null, is_test: false, merged_into_id: null, phone_normalized: null },
          { id: IMP, phone: '+5491155261243', is_test: false, merged_into_id: null, phone_normalized: '+5491155261243' },
        ] };
      }
      if (s.includes('lgpd_consent_at')) {
        if (failConsent === 'pg') throw Object.assign(new Error('boom com dado da linha'), { code: '23505' });
        return { rowCount: failConsent === 'zero' ? 0 : 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    }),
  };
  const pool = { connect: jest.fn().mockResolvedValue(client) };
  const merge = jest.fn(async () => { calls.push('MERGE'); });
  const absorber = new ClaimShellAbsorber(pool as never, { executeSingleMerge: merge } as never);
  return { absorber, client, calls, merge };
}
const args = { existingId: X, importedId: IMP, authUid: 'uid', consentAt };

describe('ClaimShellAbsorber — consentimento na mesma transação (D764)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('grava o consentimento no client da transação, depois do merge e antes do COMMIT, sem tocar auth_uid', async () => {
    const h = harness(null);
    const r = await h.absorber.absorbImportedIntoExisting(args);
    expect(r.isSuccess).toBe(true);
    const i = h.calls.indexOf('MERGE');
    expect(h.calls.indexOf('UPDATE:consent')).toBeGreaterThan(i);
    expect(h.calls.indexOf('COMMIT')).toBeGreaterThan(h.calls.indexOf('UPDATE:consent'));
    const sql = h.client.query.mock.calls.map((c) => String(c[0])).find((q) => q.includes('lgpd_consent_at'))!;
    expect(sql).not.toMatch(/auth_uid/);
    expect(h.client.query).toHaveBeenCalledWith(expect.stringContaining('lgpd_consent_at'), [X, consentAt]);
  });

  it('falha no UPDATE de consentimento: ROLLBACK, sem COMMIT, devolve falha e loga só o pgCode', async () => {
    const h = harness('pg');
    const r = await h.absorber.absorbImportedIntoExisting(args);
    expect(r.isFailure).toBe(true);
    expect(r.error).toBe('CLAIM_ABSORB_FAILED');
    expect(h.calls).toContain('ROLLBACK');
    expect(h.calls).not.toContain('COMMIT');
    expect(mockLogs.error).toHaveBeenCalledWith({ msg: 'claim_shell_absorb_failed', pgCode: '23505' });
    expect(JSON.stringify(mockLogs.error.mock.calls)).not.toMatch(/dado da linha/);
  });

  it('UPDATE de consentimento que não afeta 1 linha: rollback e falha (nunca sucesso com estado antigo)', async () => {
    const h = harness('zero');
    const r = await h.absorber.absorbImportedIntoExisting(args);
    expect(r.isFailure).toBe(true);
    expect(h.calls).toContain('ROLLBACK');
    expect(h.calls).not.toContain('COMMIT');
  });
});
