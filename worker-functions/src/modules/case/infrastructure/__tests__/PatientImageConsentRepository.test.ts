const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));

import type { PoolClient } from 'pg';
import {
  PatientImageConsentRepository,
  isVigenteUniqueViolation,
  isForeignKeyViolation,
  isCheckViolation,
} from '../PatientImageConsentRepository';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CID = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';

interface FakeClient { query: jest.Mock }
function fakeClient(rows: unknown[] = []): FakeClient {
  return { query: jest.fn(async () => ({ rows })) };
}
function asPoolClient(c: FakeClient): PoolClient {
  return c as unknown as PoolClient;
}

describe('PatientImageConsentRepository (426, spec 018 PR-4, D335)', () => {
  let repo: PatientImageConsentRepository;
  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
    repo = new PatientImageConsentRepository();
  });

  it('register — documentId OPCIONAL, grava com todos os campos', async () => {
    const client = fakeClient([{ id: CID }]);
    const result = await repo.register(
      PID,
      { consenterKind: 'PATIENT', textVersion: 'img-2026-09-v1', consentedAt: '2026-09-14T10:00:00Z' },
      'uid-1',
      asPoolClient(client),
    );
    expect(result).toEqual({ id: CID });
    const [sql, params] = (client.query as jest.Mock).mock.calls[0];
    expect(sql).toContain('INSERT INTO patient_image_consents');
    expect(params).toEqual([PID, 'PATIENT', null, null, 'img-2026-09-v1', '2026-09-14T10:00:00Z', 'uid-1', null, null]);
  });

  it('register — REPRESENTATIVE com responsibleId e representationBasis', async () => {
    const client = fakeClient([{ id: CID }]);
    await repo.register(
      PID,
      {
        consenterKind: 'REPRESENTATIVE',
        responsibleId: 'resp-1',
        documentId: 'doc-1',
        textVersion: 'v1',
        consentedAt: '2026-09-14T10:00:00Z',
        representationBasis: 'PARENTAL_RESPONSIBILITY',
        representationVerifiedBy: 'uid-2',
      },
      'uid-1',
      asPoolClient(client),
    );
    const [, params] = (client.query as jest.Mock).mock.calls[0];
    expect(params).toEqual([PID, 'REPRESENTATIVE', 'resp-1', 'doc-1', 'v1', '2026-09-14T10:00:00Z', 'uid-1', 'PARENTAL_RESPONSIBILITY', 'uid-2']);
  });

  it('findVigente — devolve a linha sem revoked_at, ou null', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: CID, patient_id: PID }] });
    await expect(repo.findVigente(PID)).resolves.toEqual({ id: CID, patient_id: PID });

    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(repo.findVigente(PID)).resolves.toBeNull();
  });

  it('revoke — grava revoked_at/by/channel/document, devolve id; null se não encontrar', async () => {
    const client = fakeClient([{ id: CID }]);
    const result = await repo.revoke(PID, CID, { revocationChannel: 'EMAIL', revocationDocumentId: 'rdoc-1' }, 'uid-3', asPoolClient(client));
    expect(result).toEqual({ id: CID });
    const [sql, params] = (client.query as jest.Mock).mock.calls[0];
    expect(sql).toContain('UPDATE patient_image_consents');
    expect(params).toEqual([PID, CID, 'uid-3', 'EMAIL', 'rdoc-1']);

    const clientEmpty = fakeClient([]);
    await expect(repo.revoke(PID, CID, { revocationChannel: 'PHONE' }, 'uid-3', asPoolClient(clientEmpty))).resolves.toBeNull();
  });

  describe('classificadores de erro do Postgres', () => {
    it('isVigenteUniqueViolation — 23505 na constraint certa', () => {
      expect(isVigenteUniqueViolation({ code: '23505', constraint: 'uq_patient_image_consents_vigente' })).toBe(true);
      expect(isVigenteUniqueViolation({ code: '23505', constraint: 'outra' })).toBe(false);
      expect(isVigenteUniqueViolation({ code: '23503' })).toBe(false);
      expect(isVigenteUniqueViolation(new Error('x'))).toBe(false);
    });
    it('isForeignKeyViolation — 23503', () => {
      expect(isForeignKeyViolation({ code: '23503' })).toBe(true);
      expect(isForeignKeyViolation({ code: '23505' })).toBe(false);
    });
    it('isCheckViolation — 23514', () => {
      expect(isCheckViolation({ code: '23514' })).toBe(true);
      expect(isCheckViolation({ code: '23503' })).toBe(false);
    });
  });
});
