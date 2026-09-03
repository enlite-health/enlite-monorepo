/**
 * ContractedServiceProviderRepository — prestador(es) alocado(s) num serviço contratado
 * (migration 319, spec 013, lex C-e). Molde: InsuranceProviderRepository.test.ts.
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }) },
}));

import { ContractedServiceProviderRepository, ProviderAlreadyActiveError } from '../ContractedServiceProviderRepository';
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

  it('associate: INSERT + relê decorado', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'prov-1' }] }) // INSERT
      .mockResolvedValueOnce({ rows: [ROW] }); // relê
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    const out = await repo.associate({ serviceId: 'svc-1', workerId: 'w-1', weeklyHours: 10, country: 'BR', actorUid: 'uid-1' });
    expect(out.id).toBe('prov-1');
    const insCall = mockPoolQuery.mock.calls[0];
    expect(insCall[0]).toContain('INSERT INTO contracted_service_providers');
    expect(insCall[1]).toEqual(['svc-1', 'w-1', 10, 'BR', 'uid-1']);
  });

  it('associate: par ATIVO duplicado (23505) → ProviderAlreadyActiveError', async () => {
    const err = Object.assign(new Error('dup'), { code: '23505' });
    mockPoolQuery.mockRejectedValueOnce(err);
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    await expect(repo.associate({ serviceId: 'svc-1', workerId: 'w-1', actorUid: 'uid-1' })).rejects.toBeInstanceOf(ProviderAlreadyActiveError);
  });

  it('associate: erro genérico propaga sem virar ProviderAlreadyActiveError', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('boom'));
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    await expect(repo.associate({ serviceId: 'svc-1', workerId: 'w-1', actorUid: 'uid-1' })).rejects.toThrow('boom');
  });

  it('update: weeklyHours — SET só weekly_hours + updated_by/updated_at', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'prov-1' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [ROW] }); // relê
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    const out = await repo.update('prov-1', { weeklyHours: 15, actorUid: 'uid-2' });
    expect(out?.id).toBe('prov-1');
    const updCall = mockPoolQuery.mock.calls[0];
    expect(updCall[0]).toContain('weekly_hours');
    expect(updCall[0]).not.toContain('ended_at');
  });

  it('update: active:false — grava ended_at = NOW() (baixa)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'prov-1' }] }).mockResolvedValueOnce({ rows: [{ ...ROW, active: false, ended_at: '2026-09-03T01:00:00Z' }] });
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    const out = await repo.update('prov-1', { active: false, actorUid: 'uid-2' });
    expect(out?.active).toBe(false);
    const updCall = mockPoolQuery.mock.calls[0];
    expect(updCall[0]).toContain('ended_at = NOW()');
  });

  it('update: active:true — grava ended_at = NULL', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'prov-1' }] }).mockResolvedValueOnce({ rows: [ROW] });
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    await repo.update('prov-1', { active: true, actorUid: 'uid-2' });
    const updCall = mockPoolQuery.mock.calls[0];
    expect(updCall[0]).toContain('ended_at = NULL');
  });

  it('update: rowCount 0 (id inexistente) → null', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    expect(await repo.update('nope', { weeklyHours: 1, actorUid: 'uid-2' })).toBeNull();
  });

  it('update: nada além de actorUid → nenhum UPDATE, só relê a linha atual (ou null se sumiu)', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [ROW] });
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    const out = await repo.update('prov-1', { actorUid: 'uid-2' });
    expect(out?.id).toBe('prov-1');
    expect(mockPoolQuery.mock.calls[0][0]).not.toContain('UPDATE');
  });

  it('update: nada além de actorUid, linha sumiu → null', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    expect(await repo.update('nope', { actorUid: 'uid-2' })).toBeNull();
  });

  it('update: UPDATE afeta 1 linha mas a releitura não encontra nada (corrida) → null, não undefined', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ id: 'prov-1' }] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // releitura vazia
    const repo = new ContractedServiceProviderRepository(fakeEnc());
    expect(await repo.update('prov-1', { weeklyHours: 1, actorUid: 'uid-2' })).toBeNull();
  });
});
