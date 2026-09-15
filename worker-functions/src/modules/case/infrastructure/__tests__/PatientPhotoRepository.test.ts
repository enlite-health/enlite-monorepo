const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockPoolQuery }) }) },
}));

import type { PoolClient } from 'pg';
import { PatientPhotoRepository } from '../PatientPhotoRepository';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

interface FakeClient { query: jest.Mock }
function fakeClient(rows: unknown[] = []): FakeClient {
  return { query: jest.fn(async () => ({ rows })) };
}
function asPoolClient(c: FakeClient): PoolClient {
  return c as unknown as PoolClient;
}

describe('PatientPhotoRepository (426, spec 018 PR-4)', () => {
  let repo: PatientPhotoRepository;
  beforeEach(() => {
    mockPoolQuery.mockReset().mockResolvedValue({ rows: [] });
    repo = new PatientPhotoRepository();
  });

  it('findOne — devolve a linha ou null', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'p1', patient_id: PID }] });
    await expect(repo.findOne(PID)).resolves.toEqual({ id: 'p1', patient_id: PID });
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(repo.findOne(PID)).resolves.toBeNull();
  });

  it('insert — grava com consentId opcional', async () => {
    const client = fakeClient([{ id: 'p1' }]);
    const result = await repo.insert(PID, { objectPathEncrypted: 'enc(x)', consentId: 'c1' }, 'uid-1', asPoolClient(client));
    expect(result).toEqual({ id: 'p1' });
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain('INSERT INTO patient_photos');
    expect(params).toEqual([PID, 'c1', 'enc(x)', 'uid-1']);
  });

  it('insert — consentId ausente vira null', async () => {
    const client = fakeClient([{ id: 'p1' }]);
    await repo.insert(PID, { objectPathEncrypted: 'enc(x)' }, 'uid-1', asPoolClient(client));
    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual([PID, null, 'enc(x)', 'uid-1']);
  });

  it('deleteRow — devolve a linha apagada, ou null se não havia foto', async () => {
    const client = fakeClient([{ id: 'p1', object_path_encrypted: 'enc(x)' }]);
    await expect(repo.deleteRow(PID, asPoolClient(client))).resolves.toEqual({ id: 'p1', object_path_encrypted: 'enc(x)' });

    const clientEmpty = fakeClient([]);
    await expect(repo.deleteRow(PID, asPoolClient(clientEmpty))).resolves.toBeNull();
  });
});
