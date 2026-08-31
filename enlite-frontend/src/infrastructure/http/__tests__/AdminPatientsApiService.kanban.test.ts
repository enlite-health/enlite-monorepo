/**
 * AdminPatientsApiService.listPatientsForKanban — o mapper por onde o contato
 * do lead entra no front.
 *
 * O gate de 31/08 apontou este arquivo com 77% de cobertura. As linhas DESTE PR
 * são as duas do contato mascarado; o resto do arquivo é anterior. Aqui se cobre
 * o método inteiro, incluindo o ramo de campo ausente — que é o que acontece
 * enquanto o backend novo não está deployado e o front já está.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminPatientsApiService } from '../AdminPatientsApiService';

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('mock-token'),
  })),
}));

function mockJson(body: unknown, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    status,
    json: async () => body,
    headers: { get: (n: string) => (n === 'content-type' ? 'application/json' : null) },
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('listPatientsForKanban', () => {
  it('repassa o contato mascarado e a marca de responsável', async () => {
    mockJson({ success: true, total: 1, data: [{
      id: 'p1', firstName: 'Solicitante', lastName: null, caseNumber: null,
      dependencyLevel: null, status: 'SOLICITANTE', stageEnteredAt: '2026-08-28T10:00:00Z',
      hoursInStage: 51, slaBreached: true, slaThresholdHours: 24,
      leadContactEmailMasked: 'joa•••@gmail.com', leadContactIsResponsible: true,
    }] });

    const [item] = await AdminPatientsApiService.listPatientsForKanban('AR');

    expect(item.leadContactEmailMasked).toBe('joa•••@gmail.com');
    expect(item.leadContactIsResponsible).toBe(true);
    expect(item.slaBreached).toBe(true);
    expect(item.hoursInStage).toBe(51);
  });

  it('backend SEM os campos novos: cai em null/false, não em undefined', async () => {
    // É o estado real entre o deploy do front e o do backend.
    mockJson({ success: true, total: 1, data: [{ id: 'p2', status: 'ACTIVE' }] });

    const [item] = await AdminPatientsApiService.listPatientsForKanban();

    expect(item.leadContactEmailMasked).toBeNull();
    expect(item.leadContactIsResponsible).toBe(false);
    expect(item.firstName).toBeNull();
    expect(item.caseNumber).toBeNull();
    expect(item.slaBreached).toBe(false);
  });

  it('resposta sem `data` devolve lista vazia em vez de estourar', async () => {
    mockJson({ success: true, total: 0 });
    await expect(AdminPatientsApiService.listPatientsForKanban()).resolves.toEqual([]);
  });

  it('pede 500 por página e repassa o país', async () => {
    mockJson({ success: true, total: 0, data: [] });
    await AdminPatientsApiService.listPatientsForKanban('BR');
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toContain('limit=500');
    expect(url).toContain('country=BR');
  });
});
