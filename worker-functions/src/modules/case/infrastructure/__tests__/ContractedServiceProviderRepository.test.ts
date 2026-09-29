/**
 * ContractedServiceProviderRepository — prestador(es) alocado(s) num serviço contratado
 * (migration 319, spec 013, lex C-e). Molde: InsuranceProviderRepository.test.ts.
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }) },
}));

import { ContractedServiceProviderRepository } from '../ContractedServiceProviderRepository';
import type { KMSEncryptionService } from '@shared/security/KMSEncryptionService';

function fakeEnc(): KMSEncryptionService {
  const decrypt = jest.fn(async (v: string | null) => (v ? `dec(${v})` : null));
  return { decrypt, encrypt: jest.fn() } as unknown as KMSEncryptionService;
}

const ROW = {
  id: 'prov-1',
  service_id: 'svc-1',
  worker_id: 'w-1',
  weekly_hours: '10',
  active: true,
  ended_at: null,
  country: 'BR',
  created_at: '2026-09-03T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
  first_name_encrypted: 'enc-first',
  last_name_encrypted: 'enc-last',
};

describe('ContractedServiceProviderRepository', () => {
  beforeEach(() => jest.clearAllMocks());

  it('listForService: decripta o nome via KMS, weeklyHours vira Number', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ROW] });
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    const out = await repo.listForService('svc-1');
    expect(out).toEqual([{
      id: 'prov-1', serviceId: 'svc-1', workerId: 'w-1', workerName: 'dec(enc-first) dec(enc-last)',
      weeklyHours: 10, active: true, endedAt: null, country: 'BR',
      createdAt: '2026-09-03T00:00:00Z', updatedAt: '2026-09-03T00:00:00Z',
    }]);
  });

  it('listForService: nome ausente (first/last null) → workerName null', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...ROW, first_name_encrypted: null, last_name_encrypted: null }] });
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    const out = await repo.listForService('svc-1');
    expect(out[0].workerName).toBeNull();
  });

  it('listForService: weeklyHours null passa como null (não 0)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ ...ROW, weekly_hours: null }] });
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    const out = await repo.listForService('svc-1');
    expect(out[0].weeklyHours).toBeNull();
  });
});
