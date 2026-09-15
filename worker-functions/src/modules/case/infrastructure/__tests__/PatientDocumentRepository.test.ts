const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));

import type { PoolClient } from 'pg';
import { PatientDocumentRepository } from '../PatientDocumentRepository';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const DID = 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee';

interface FakeClient { query: jest.Mock }
function fakeClient(rows: unknown[] = []): FakeClient {
  return { query: jest.fn(async () => ({ rows })) };
}
function asPoolClient(c: FakeClient): PoolClient {
  return c as unknown as PoolClient;
}

describe('PatientDocumentRepository (426, spec 018 PR-4, D329) — append-only', () => {
  let repo: PatientDocumentRepository;
  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
    repo = new PatientDocumentRepository();
  });

  it('insert — grava todos os campos da prova', async () => {
    const client = fakeClient([{ id: DID }]);
    const result = await repo.insert(
      PID,
      { documentType: 'image_consent', objectPathEncrypted: 'enc(doc)', contentType: 'application/pdf', sizeBytes: 1234, sha256: 'abc' },
      'uid-1',
      asPoolClient(client),
    );
    expect(result).toEqual({ id: DID });
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO patient_documents');
    expect(params).toEqual([PID, 'image_consent', 'enc(doc)', 'application/pdf', 1234, 'abc', 'uid-1']);
  });

  it('findOne — filtro composto (id, patient_id); null quando não encontra', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: DID, patient_id: PID }] });
    await expect(repo.findOne(PID, DID)).resolves.toEqual({ id: DID, patient_id: PID });
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([PID, DID]);

    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(repo.findOne(PID, DID)).resolves.toBeNull();
  });

  it('listForPatient — todos os documentos do paciente (purga)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: DID }, { id: 'other' }] });
    await expect(repo.listForPatient(PID)).resolves.toHaveLength(2);
    expect(mockPoolQuery.mock.calls[0][1]).toEqual([PID]);
  });
});
