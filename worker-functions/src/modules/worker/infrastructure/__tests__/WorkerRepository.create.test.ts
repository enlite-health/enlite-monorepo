/**
 * WorkerRepository.create.test.ts
 *
 * TD-028: garante que timezone é derivado de country quando ausente.
 * Antes do fix, default 'UTC' levava 100% dos workers AR/BR a terem
 * timezone errado.
 */

import { CreateWorkerDTO } from '../../domain/Worker';

const mockQuery = jest.fn();
const mockEncrypt = jest.fn().mockResolvedValue('encrypted-whatsapp');

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: () => ({ getPool: () => ({ query: mockQuery }) }),
  },
}));

jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ encrypt: mockEncrypt })),
}));

jest.mock('@shared/security/BlindIndexService', () => ({
  BlindIndexService: jest.fn().mockImplementation(() => ({})),
}));

import { WorkerRepository } from '../WorkerRepository';

describe('WorkerRepository.create — TD-028 timezone derivation', () => {
  let repo: WorkerRepository;

  beforeEach(() => {
    mockQuery.mockReset();
    mockEncrypt.mockClear();
    repo = new WorkerRepository();
  });

  function fakeRow(country: string, timezone: string) {
    return {
      id: 'uuid-1',
      authUid: 'auth-1',
      email: 'a@b.com',
      phone: null,
      lgpdConsentAt: null,
      termsAcceptedAt: null,
      privacyAcceptedAt: null,
      country,
      timezone,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  it('AR sem timezone explícito → America/Argentina/Buenos_Aires', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow('AR', 'America/Argentina/Buenos_Aires')] });
    const dto: CreateWorkerDTO = {
      authUid: 'auth-1',
      email: 'a@b.com',
      lgpdOptIn: true,
      country: 'AR',
    };

    await repo.create(dto);

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const passedValues = mockQuery.mock.calls[0][1];
    expect(passedValues[7]).toBe('AR');
    expect(passedValues[8]).toBe('America/Argentina/Buenos_Aires');
  });

  it('BR sem timezone explícito → America/Sao_Paulo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow('BR', 'America/Sao_Paulo')] });
    const dto: CreateWorkerDTO = {
      authUid: 'auth-1',
      email: 'a@b.com',
      lgpdOptIn: true,
      country: 'BR',
    };

    await repo.create(dto);

    const passedValues = mockQuery.mock.calls[0][1];
    expect(passedValues[7]).toBe('BR');
    expect(passedValues[8]).toBe('America/Sao_Paulo');
  });

  it('country não mapeado → UTC (fallback)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow('XX', 'UTC')] });
    const dto: CreateWorkerDTO = {
      authUid: 'auth-1',
      email: 'a@b.com',
      lgpdOptIn: true,
      country: 'XX',
    };

    await repo.create(dto);

    const passedValues = mockQuery.mock.calls[0][1];
    expect(passedValues[7]).toBe('XX');
    expect(passedValues[8]).toBe('UTC');
  });

  it('timezone explícito tem precedência sobre derivação', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow('AR', 'Europe/London')] });
    const dto: CreateWorkerDTO = {
      authUid: 'auth-1',
      email: 'a@b.com',
      lgpdOptIn: true,
      country: 'AR',
      timezone: 'Europe/London',
    };

    await repo.create(dto);

    const passedValues = mockQuery.mock.calls[0][1];
    expect(passedValues[7]).toBe('AR');
    expect(passedValues[8]).toBe('Europe/London');
  });

  it('country ausente → default AR + Buenos_Aires', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow('AR', 'America/Argentina/Buenos_Aires')] });
    const dto: CreateWorkerDTO = {
      authUid: 'auth-1',
      email: 'a@b.com',
      lgpdOptIn: true,
    };

    await repo.create(dto);

    const passedValues = mockQuery.mock.calls[0][1];
    expect(passedValues[7]).toBe('AR');
    expect(passedValues[8]).toBe('America/Argentina/Buenos_Aires');
  });
});
