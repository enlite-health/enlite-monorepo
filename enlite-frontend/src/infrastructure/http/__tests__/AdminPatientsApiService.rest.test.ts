/**
 * AdminPatientsApiService — o resto dos métodos e ramos (a régua do arquivo tocado é 100%, spec 012):
 * GETs simples, POST de criação, PATCH de seção, catálogo de papéis de chat (CRUD), activate,
 * stats/funnel com e sem parâmetros, respostas não-JSON, `success:false`, token ausente.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let token: string | null = 'tok';
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn(async () => token) })),
}));

import { AdminPatientsApiService, PatientApiError } from '../AdminPatientsApiService';

const json = (body: unknown, status = 200, contentType = 'application/json'): Response =>
  ({ status, headers: { get: () => contentType }, json: async () => body } as unknown as Response);

describe('AdminPatientsApiService — resto', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { token = 'tok'; fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });

  it('GETs simples: getPatientById, getPatientVacancies, getPatientStats (com e sem país), getPatientFunnel (com e sem params); sem token não manda Authorization', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { id: 'p' } }));
    await expect(AdminPatientsApiService.getPatientById('p')).resolves.toEqual({ id: 'p' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    await AdminPatientsApiService.getPatientVacancies('p');
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/patients\/p\/vacancies$/);
    await AdminPatientsApiService.getPatientStats({ country: 'AR' });
    expect(fetchMock.mock.calls[2][0]).toMatch(/stats\?country=AR$/);
    await AdminPatientsApiService.getPatientStats();
    expect(fetchMock.mock.calls[3][0]).toMatch(/stats$/);
    await AdminPatientsApiService.getPatientFunnel({ country: 'BR', from: '', to: undefined });
    expect(fetchMock.mock.calls[4][0]).toMatch(/funnel\?country=BR$/);
    await AdminPatientsApiService.getPatientFunnel();
    expect(fetchMock.mock.calls[5][0]).toMatch(/funnel$/);
    token = null;
    await AdminPatientsApiService.getPatientById('p');
    expect(fetchMock.mock.calls[6][1].headers.Authorization).toBeUndefined();
    fetchMock.mockResolvedValueOnce(json({ success: false, error: '' }, 500));
    await expect(AdminPatientsApiService.getPatientById('p')).rejects.toThrow('HTTP 500');
  });

  it('listPatients: filtros limpos, não-JSON → erro de conexão, success:false → erro, data ausente → []', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: [{ id: 'a' }], total: 1 }));
    await expect(AdminPatientsApiService.listPatients({ search: 'x', country: '', limit: undefined })).resolves.toEqual({ data: [{ id: 'a' }], total: 1 });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/admin\/patients\?search=x$/);
    fetchMock.mockResolvedValueOnce(json('<html>', 502, 'text/html'));
    await expect(AdminPatientsApiService.listPatients()).rejects.toThrow('HTTP 502');
    fetchMock.mockResolvedValueOnce(json({ success: false }, 500));
    await expect(AdminPatientsApiService.listPatients()).rejects.toThrow('HTTP 500');
    fetchMock.mockResolvedValueOnce(json({ success: true }));
    await expect(AdminPatientsApiService.listPatients()).resolves.toEqual({ data: [], total: 0 });
    fetchMock.mockResolvedValueOnce(json({ success: true, data: [{ id: 'k' }] }));
    const rows = await AdminPatientsApiService.listPatientsForKanban();
    expect(rows[0]).toMatchObject({ id: 'k', firstName: null, status: null, admissionStatus: 'DONE', slaBreached: false, leadContactIsResponsible: false });
    fetchMock.mockResolvedValueOnce(json({ success: true, data: undefined }));
    await expect(AdminPatientsApiService.listPatientsForKanban()).resolves.toEqual([]);
  });

  it('createPatient: 201 → id; não-JSON → erro de conexão; success:false → mensagem do backend (e fallback HTTP)', async () => {
    fetchMock.mockResolvedValueOnce(json({ success: true, data: { id: 'n1' } }, 201));
    await expect(AdminPatientsApiService.createPatient({ firstName: 'A', birthDate: '2015-06-20', country: 'AR' })).resolves.toEqual({ id: 'n1' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ firstName: 'A', birthDate: '2015-06-20', country: 'AR' });
    fetchMock.mockResolvedValueOnce(json('', 502, 'text/plain'));
    await expect(AdminPatientsApiService.createPatient({ firstName: 'A', country: 'AR' })).rejects.toThrow('HTTP 502');
    fetchMock.mockResolvedValueOnce(json({ success: false, error: 'Validação de contato' }, 400));
    await expect(AdminPatientsApiService.createPatient({ firstName: 'A', country: 'AR' })).rejects.toThrow('Validação de contato');
    fetchMock.mockResolvedValueOnce(json({ success: false }, 400));
    await expect(AdminPatientsApiService.createPatient({ firstName: 'A', country: 'AR' })).rejects.toThrow('HTTP 400');
  });

  it('writeJson: updatePatientSection, activatePatient, chat groups/candidates/ids, papéis de chat; não-JSON e success:false sem mensagem', async () => {
    fetchMock.mockResolvedValue(json({ success: true, data: { id: 'p' } }));
    await AdminPatientsApiService.updatePatientSection('p', 'coverage', { affiliateId: 'x' });
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    await AdminPatientsApiService.activatePatient('p');
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/patients\/p\/activate$/);
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
    await AdminPatientsApiService.getPatientChatCandidates('p', 5);
    expect(fetchMock.mock.calls[2][0]).toMatch(/chat-candidates\?limit=5$/);
    await AdminPatientsApiService.getPatientChatCandidates('p');
    expect(fetchMock.mock.calls[3][0]).toMatch(/chat-candidates$/);
    await AdminPatientsApiService.updatePatientChatIds('p', { chatIds: { FAMILY: null } });
    expect(fetchMock.mock.calls[4][1].method).toBe('PUT');
    await AdminPatientsApiService.listChatGroups({ search: 'flia', limit: 10, offset: 20 });
    expect(fetchMock.mock.calls[5][0]).toMatch(/chat-groups\?search=flia&limit=10&offset=20$/);
    await AdminPatientsApiService.listChatGroups();
    expect(fetchMock.mock.calls[6][0]).toMatch(/chat-groups$/);
    await AdminPatientsApiService.listPatientChatRoles(true);
    expect(fetchMock.mock.calls[7][0]).toMatch(/patient-chat-roles\?includeInactive=true$/);
    await AdminPatientsApiService.listPatientChatRoles();
    expect(fetchMock.mock.calls[8][0]).toMatch(/patient-chat-roles$/);
    await AdminPatientsApiService.createPatientChatRole({ code: 'X', labelEs: 'x', labelPtBr: 'x', isExclusive: true, displayOrder: 1, matchKeywords: [] });
    expect(fetchMock.mock.calls[9][1].method).toBe('POST');
    await AdminPatientsApiService.updatePatientChatRole('X Y', { isActive: false });
    expect(fetchMock.mock.calls[10][0]).toMatch(/patient-chat-roles\/X%20Y$/);
    fetchMock.mockResolvedValueOnce(json('', 503, 'text/html'));
    await expect(AdminPatientsApiService.activatePatient('p')).rejects.toBeInstanceOf(PatientApiError);
    fetchMock.mockResolvedValueOnce(json({ success: false }, 500));
    await expect(AdminPatientsApiService.activatePatient('p')).rejects.toThrow('HTTP 500');
  });

  it('deletePatientChatRole: 204 sem corpo; erro JSON com code; erro não-JSON', async () => {
    fetchMock.mockResolvedValueOnce({ status: 204, headers: { get: () => null } } as unknown as Response);
    await expect(AdminPatientsApiService.deletePatientChatRole('X')).resolves.toBeUndefined();
    fetchMock.mockResolvedValueOnce(json({ success: false, error: 'in use', code: 'CHAT_ROLE_IN_USE', details: { patientCount: 3 } }, 409));
    await expect(AdminPatientsApiService.deletePatientChatRole('X')).rejects.toMatchObject({ status: 409, code: 'CHAT_ROLE_IN_USE' });
    fetchMock.mockResolvedValueOnce(json({ success: false }, 409));
    await expect(AdminPatientsApiService.deletePatientChatRole('X')).rejects.toThrow('HTTP 409');
    fetchMock.mockResolvedValueOnce(json('', 502, 'text/html'));
    await expect(AdminPatientsApiService.deletePatientChatRole('X')).rejects.toThrow('HTTP 502');
  });

  it('resposta sem content-type (headers.get → null) é tratada como não-JSON em listPatients, createPatient, writeJson e delete', async () => {
    const semTipo = () => ({ status: 500, headers: { get: () => null }, json: async () => ({}) } as unknown as Response);
    fetchMock.mockResolvedValueOnce(semTipo());
    await expect(AdminPatientsApiService.listPatients()).rejects.toThrow('HTTP 500');
    fetchMock.mockResolvedValueOnce(semTipo());
    await expect(AdminPatientsApiService.createPatient({ firstName: 'A', country: 'AR' })).rejects.toThrow('HTTP 500');
    fetchMock.mockResolvedValueOnce(semTipo());
    await expect(AdminPatientsApiService.activatePatient('p')).rejects.toBeInstanceOf(PatientApiError);
    fetchMock.mockResolvedValueOnce(semTipo());
    await expect(AdminPatientsApiService.deletePatientChatRole('X')).rejects.toBeInstanceOf(PatientApiError);
  });
});
