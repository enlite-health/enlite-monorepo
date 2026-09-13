/**
 * AdminPatientContactRowsApiService — spec 018, PR-1, ADR-1: escrita POR LINHA de responsáveis e de
 * contatos de emergência da cobertura. Régua do arquivo tocado é 100% (definição de pronto): os 6
 * métodos públicos, verbo/rota corretos, corpo enviado, e os ramos de erro do `writeJson` privado
 * (não-JSON, `success:false` com/sem mensagem, header Authorization presente/ausente).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let token: string | null = 'tok';
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn(async () => token) })),
}));

import { AdminPatientContactRowsApiService } from '../AdminPatientContactRowsApiService';
import { PatientApiError } from '../AdminPatientsApiService';

const json = (body: unknown, status = 200, contentType = 'application/json'): Response =>
  ({ status, headers: { get: () => contentType }, json: async () => body } as unknown as Response);

describe('AdminPatientContactRowsApiService', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { token = 'tok'; fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });

  it('createResponsible: POST na rota certa, corpo enviado, Authorization com token', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { id: 'r1' } }, 201));
    const result = await AdminPatientContactRowsApiService.createResponsible('p1', { firstName: 'Ana', lastName: 'Sintética' });
    expect(result).toEqual({ id: 'r1' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/admin\/patients\/p1\/responsibles$/);
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body)).toEqual({ firstName: 'Ana', lastName: 'Sintética' });
  });

  it('updateResponsible: PATCH em /responsibles/:id, corpo = patch', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { id: 'r1' } }));
    await AdminPatientContactRowsApiService.updateResponsible('p1', 'r1', { phone: '+54 11 5555-0000' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/admin\/patients\/p1\/responsibles\/r1$/);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ phone: '+54 11 5555-0000' });
  });

  it('deactivateResponsible: POST em /responsibles/:id/deactivate, sem corpo', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { id: 'r1', active: false } }));
    const result = await AdminPatientContactRowsApiService.deactivateResponsible('p1', 'r1');
    expect(result).toEqual({ id: 'r1', active: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/admin\/patients\/p1\/responsibles\/r1\/deactivate$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('createCoverageEmergencyContact: POST em /coverage-emergency-contacts, corpo = input', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { id: 'c1' } }, 201));
    await AdminPatientContactRowsApiService.createCoverageEmergencyContact('p1', { kind: 'coverage', name: 'Cobertura X' } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/admin\/patients\/p1\/coverage-emergency-contacts$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ kind: 'coverage', name: 'Cobertura X' });
  });

  it('updateCoverageEmergencyContact: PATCH em /coverage-emergency-contacts/:id, corpo = patch', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { id: 'c1' } }));
    await AdminPatientContactRowsApiService.updateCoverageEmergencyContact('p1', 'c1', { name: 'Novo Nome' } as never);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/admin\/patients\/p1\/coverage-emergency-contacts\/c1$/);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ name: 'Novo Nome' });
  });

  it('deactivateCoverageEmergencyContact: POST em /coverage-emergency-contacts/:id/deactivate, sem corpo', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { id: 'c1', active: false } }));
    const result = await AdminPatientContactRowsApiService.deactivateCoverageEmergencyContact('p1', 'c1');
    expect(result).toEqual({ id: 'c1', active: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/admin\/patients\/p1\/coverage-emergency-contacts\/c1\/deactivate$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('createProfessional: POST em /professionals, corpo = input (spec 018 PR-5)', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { id: 'pr1' } }, 201));
    await AdminPatientContactRowsApiService.createProfessional('p1', { name: 'Dr. X', phone: '+54', email: null, specialty: 'PHYSICIAN' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/admin\/patients\/p1\/professionals$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ name: 'Dr. X', phone: '+54', email: null, specialty: 'PHYSICIAN' });
  });

  it('updateProfessional: PATCH em /professionals/:id, corpo = patch', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { id: 'pr1' } }));
    await AdminPatientContactRowsApiService.updateProfessional('p1', 'pr1', { specialty: 'NURSE' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/admin\/patients\/p1\/professionals\/pr1$/);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ specialty: 'NURSE' });
  });

  it('deactivateProfessional: POST em /professionals/:id/deactivate, sem corpo (C8 — nunca DELETE)', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { id: 'pr1', active: false } }));
    const result = await AdminPatientContactRowsApiService.deactivateProfessional('p1', 'pr1');
    expect(result).toEqual({ id: 'pr1', active: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/admin\/patients\/p1\/professionals\/pr1\/deactivate$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('sem token: getAuthHeaders não manda Authorization', async () => {
    token = null;
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { id: 'r2' } }, 201));
    await AdminPatientContactRowsApiService.createResponsible('p1', { firstName: 'Beatriz', lastName: 'Sintética' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('resposta não-JSON (content-type diferente) → PatientApiError com HTTP status', async () => {
    fetchMock.mockResolvedValueOnce(json('<html>erro</html>', 502, 'text/html'));
    await expect(AdminPatientContactRowsApiService.createResponsible('p1', { firstName: 'A', lastName: 'B' }))
      .rejects.toMatchObject({ status: 502 });
    fetchMock.mockResolvedValueOnce(json('<html>erro</html>', 502, 'text/html'));
    await expect(AdminPatientContactRowsApiService.createResponsible('p1', { firstName: 'A', lastName: 'B' }))
      .rejects.toBeInstanceOf(PatientApiError);
  });

  it('resposta sem content-type (headers.get → null) é tratada como não-JSON', async () => {
    fetchMock.mockResolvedValueOnce({ status: 500, headers: { get: () => null }, json: async () => ({}) } as unknown as Response);
    await expect(AdminPatientContactRowsApiService.updateResponsible('p1', 'r1', {})).rejects.toThrow('HTTP 500');
  });

  it('success:false com mensagem do backend → PatientApiError com essa mensagem', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: false, error: 'Já existe um responsável primário ativo', code: 'PRIMARY_ALREADY_SET' }, 409));
    await expect(AdminPatientContactRowsApiService.updateResponsible('p1', 'r1', { isPrimary: true }))
      .rejects.toMatchObject({ status: 409, message: 'Já existe um responsável primário ativo' });
  });

  it('success:false sem mensagem → fallback "HTTP <status>"', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: false }, 404));
    await expect(AdminPatientContactRowsApiService.deactivateResponsible('p1', 'r1')).rejects.toThrow('HTTP 404');
  });

});
