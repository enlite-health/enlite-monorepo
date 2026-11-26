/**
 * AdminPatientsApiService — bloco B (spec 012): POST /status-actions, GET /status-history,
 * GET /catalogs/insurance-providers, PATCH /patients/:id/addresses/:addressId, e a listagem do
 * Kanban carregando `admissionStatus`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('tok') })),
}));

import { AdminPatientsApiService, PatientApiError } from '../AdminPatientsApiService';

function jsonResponse(body: unknown, status = 200): Response {
  return { status, headers: { get: () => 'application/json' }, json: async () => body } as unknown as Response;
}

describe('AdminPatientsApiService — bloco B', () => {
  const fetchMock = vi.fn();
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });

  it('performPatientStatusAction: POST sem destino; 422 vira PatientApiError com code/details', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { id: 'p', action: 'pausar', from: 'ACTIVE', status: 'ON_HOLD' } }));
    await AdminPatientsApiService.performPatientStatusAction('p', { action: 'pausar', onHoldReason: 'SCHOOL', onHoldNote: 'x' });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/admin\/patients\/p\/status-actions$/);
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: 'pausar', onHoldReason: 'SCHOOL', onHoldNote: 'x' });

    fetchMock.mockResolvedValueOnce(jsonResponse({ success: false, error: 'nope', code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED', details: { from: 'ACTIVE', to: 'SEARCHING' } }, 422));
    const err = await AdminPatientsApiService.performPatientStatusAction('p', { action: 'retomar' }).catch((e) => e);
    expect(err).toBeInstanceOf(PatientApiError);
    expect(err).toMatchObject({ status: 422, code: 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED', details: { from: 'ACTIVE', to: 'SEARCHING' } });
    expect(new PatientApiError('m', 1).name).toBe('PatientApiError');
  });

  it('getPatientStatusHistory desembrulha data.history; listInsuranceProviders desembrulha data.providers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { history: [{ from: null, to: 'ACTIVE', source: 'insert', at: '2026-09-01T00:00:00Z' }] } }));
    await expect(AdminPatientsApiService.getPatientStatusHistory('p')).resolves.toEqual([{ from: null, to: 'ACTIVE', source: 'insert', at: '2026-09-01T00:00:00Z' }]);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/admin\/patients\/p\/status-history$/);
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { providers: [{ code: 'OSDE', sortOrder: 15 }] } }));
    await expect(AdminPatientsApiService.listInsuranceProviders()).resolves.toEqual([{ code: 'OSDE', sortOrder: 15 }]);
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/admin\/catalogs\/insurance-providers$/);
  });

  it('updatePatientAddressLogistics → PATCH /patients/:id/addresses/:addressId com só os campos dados', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: { id: 'a1' } }));
    await expect(AdminPatientsApiService.updatePatientAddressLogistics('p', 'a1', { access_notes: null, neighborhood: 'Centro' })).resolves.toEqual({ id: 'a1' });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/admin\/patients\/p\/addresses\/a1$/);
    expect(fetchMock.mock.calls[0][1].method).toBe('PATCH');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ access_notes: null, neighborhood: 'Centro' });
  });

  it('listPatientsForKanban carrega admissionStatus (DONE quando ausente — API antiga)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, data: [{ id: 'a', status: 'ON_HOLD', admissionStatus: 'DONE' }, { id: 'b', status: 'ADMISSION' }], total: 2 }));
    const rows = await AdminPatientsApiService.listPatientsForKanban();
    expect(rows.map((r) => [r.id, r.admissionStatus])).toEqual([['a', 'DONE'], ['b', 'DONE']]);
  });
});
