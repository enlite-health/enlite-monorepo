/**
 * AdminContractedServicesApiService — CRUD do serviço contratado (spec 013, bloco C).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminContractedServicesApiService, ContractedServiceApiError } from '../AdminContractedServicesApiService';

const mockGetIdToken = vi.fn().mockResolvedValue('mock-token');
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: (...a: unknown[]) => mockGetIdToken(...a) })),
}));

function mockFetch(payload: unknown, status = 200, contentType = 'application/json') {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: () => Promise.resolve(payload),
    headers: { get: () => contentType },
  }) as unknown as typeof fetch;
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

const PATIENT_ID = 'p1';
const SERVICE_ID = 's1';
const PROVIDER_ID = 'pr1';

describe('AdminContractedServicesApiService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('listContractedServices: GET, devolve o array services', async () => {
    const f = mockFetch({ success: true, data: { services: [{ id: SERVICE_ID }] } });
    const out = await AdminContractedServicesApiService.listContractedServices(PATIENT_ID);
    expect(out).toEqual([{ id: SERVICE_ID }]);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/admin/patients/${PATIENT_ID}/contracted-services`);
    expect(init.method).toBe('GET');
  });

  it('createContractedService: POST com o corpo, devolve o serviço criado', async () => {
    const f = mockFetch({ success: true, data: { id: SERVICE_ID, serviceCode: 'AT' } });
    const out = await AdminContractedServicesApiService.createContractedService(PATIENT_ID, { serviceCode: 'AT' });
    expect(out).toEqual({ id: SERVICE_ID, serviceCode: 'AT' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/admin/patients/${PATIENT_ID}/contracted-services`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ serviceCode: 'AT' });
  });

  it('updateContractedService: PATCH em /:sid — sem DELETE (lex C-a.4)', async () => {
    const f = mockFetch({ success: true, data: { id: SERVICE_ID, active: false } });
    const out = await AdminContractedServicesApiService.updateContractedService(PATIENT_ID, SERVICE_ID, { active: false });
    expect(out).toEqual({ id: SERVICE_ID, active: false });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/contracted-services/${SERVICE_ID}`);
    expect(init.method).toBe('PATCH');
  });

  it('associateProvider: POST em /:sid/providers', async () => {
    const f = mockFetch({ success: true, data: { id: PROVIDER_ID, workerId: 'w1' } });
    const out = await AdminContractedServicesApiService.associateProvider(PATIENT_ID, SERVICE_ID, { workerId: 'w1' });
    expect(out).toEqual({ id: PROVIDER_ID, workerId: 'w1' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/contracted-services/${SERVICE_ID}/providers`);
    expect(init.method).toBe('POST');
  });

  it('updateProvider: PATCH em /:sid/providers/:pid — sem DELETE (lex C-e.2)', async () => {
    const f = mockFetch({ success: true, data: { id: PROVIDER_ID, active: false } });
    const out = await AdminContractedServicesApiService.updateProvider(PATIENT_ID, SERVICE_ID, PROVIDER_ID, { active: false });
    expect(out).toEqual({ id: PROVIDER_ID, active: false });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/providers/${PROVIDER_ID}`);
    expect(init.method).toBe('PATCH');
  });

  it('activateRecruitment: POST em /:sid/activate-recruitment, sem corpo — 201 com vacancyId/patientStatus/statusChanged', async () => {
    const f = mockFetch({ success: true, data: { vacancyId: 'v1', patientStatus: 'SEARCHING', statusChanged: true } }, 201);
    const out = await AdminContractedServicesApiService.activateRecruitment(PATIENT_ID, SERVICE_ID);
    expect(out).toEqual({ vacancyId: 'v1', patientStatus: 'SEARCHING', statusChanged: true });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/admin/patients/${PATIENT_ID}/contracted-services/${SERVICE_ID}/activate-recruitment`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('activateRecruitment: 409 SERVICE_ALREADY_RECRUITING vira ContractedServiceApiError com o código', async () => {
    mockFetch({ success: false, error: 'já tem vaga', code: 'SERVICE_ALREADY_RECRUITING' }, 409);
    await expect(
      AdminContractedServicesApiService.activateRecruitment(PATIENT_ID, SERVICE_ID),
    ).rejects.toMatchObject({ name: 'ContractedServiceApiError', status: 409, code: 'SERVICE_ALREADY_RECRUITING' });
  });

  it('activateRecruitment: 422 PATIENT_NOT_READY carrega details.missing', async () => {
    mockFetch({ success: false, error: 'falta', code: 'PATIENT_NOT_READY', details: { missing: ['SERVICE_SCHEDULE'] } }, 422);
    await expect(
      AdminContractedServicesApiService.activateRecruitment(PATIENT_ID, SERVICE_ID),
    ).rejects.toMatchObject({ status: 422, code: 'PATIENT_NOT_READY', details: { missing: ['SERVICE_SCHEDULE'] } });
  });

  it('erro do backend (success:false) vira ContractedServiceApiError com status/code/details', async () => {
    mockFetch({ success: false, error: 'Worker already actively allocated to this service', code: 'PROVIDER_ALREADY_ACTIVE' }, 409);
    await expect(
      AdminContractedServicesApiService.associateProvider(PATIENT_ID, SERVICE_ID, { workerId: 'w1' }),
    ).rejects.toMatchObject({
      name: 'ContractedServiceApiError',
      status: 409,
      code: 'PROVIDER_ALREADY_ACTIVE',
    });
  });

  it('resposta sem content-type JSON (erro de conexão) vira ContractedServiceApiError genérico', async () => {
    mockFetch({}, 502, 'text/html');
    await expect(AdminContractedServicesApiService.listContractedServices(PATIENT_ID)).rejects.toBeInstanceOf(ContractedServiceApiError);
  });

  it('sem content-type header nenhum (`get` devolve null) cai no mesmo caminho de erro genérico', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 500, json: () => Promise.resolve({}), headers: { get: () => null },
    }) as unknown as typeof fetch;
    await expect(AdminContractedServicesApiService.listContractedServices(PATIENT_ID)).rejects.toBeInstanceOf(ContractedServiceApiError);
  });

  it('sem token (getIdToken devolve null): request sai sem Authorization', async () => {
    mockGetIdToken.mockResolvedValueOnce(null);
    const f = mockFetch({ success: true, data: { services: [] } });
    await AdminContractedServicesApiService.listContractedServices(PATIENT_ID);
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('erro do backend sem campo `error` cai no fallback "HTTP <status>"', async () => {
    mockFetch({ success: false }, 500);
    await expect(AdminContractedServicesApiService.listContractedServices(PATIENT_ID)).rejects.toMatchObject({ message: 'HTTP 500' });
  });

  it('listKanbanServices: sem país — GET sem query string', async () => {
    const f = mockFetch({ success: true, data: { patients: [] } });
    const out = await AdminContractedServicesApiService.listKanbanServices();
    expect(out).toEqual({ patients: [] });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/admin/patients/kanban/services');
    expect(url).not.toContain('?');
    expect(init.method).toBe('GET');
  });

  it('listKanbanServices: com país — GET com ?country=AR', async () => {
    const f = mockFetch({
      success: true,
      data: { patients: [{ patientId: 'p1', asOf: '2026-09-27', services: [] }] },
    });
    const out = await AdminContractedServicesApiService.listKanbanServices('AR');
    expect(out).toEqual({ patients: [{ patientId: 'p1', asOf: '2026-09-27', services: [] }] });
    const [url] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/admin/patients/kanban/services?country=AR');
  });

  it('listKanbanServices: 403 vira ContractedServiceApiError com status 403', async () => {
    mockFetch({ success: false, error: 'sem célula' }, 403);
    await expect(AdminContractedServicesApiService.listKanbanServices('AR')).rejects.toMatchObject({
      name: 'ContractedServiceApiError',
      status: 403,
    });
  });

  // Quadro C (DX-10.7/10.8): o time é CALCULADO — GET/reject/revert devolvem o mesmo formato
  // `{ serviceId, vacancyId, selected, inService, rejected }`, nunca uma lista própria de membros.
  const TEAM = {
    serviceId: SERVICE_ID,
    vacancyId: 'v1',
    selected: [{ workerId: 'w1', displayName: 'Fulano', vacancyId: 'v1' }],
    inService: [],
    rejected: [],
  };

  it('getServiceTeam: GET em /:sid/team, devolve o time', async () => {
    const f = mockFetch({ success: true, data: TEAM });
    const out = await AdminContractedServicesApiService.getServiceTeam(PATIENT_ID, SERVICE_ID);
    expect(out).toEqual(TEAM);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/api/admin/patients/${PATIENT_ID}/contracted-services/${SERVICE_ID}/team`);
    expect(init.method).toBe('GET');
  });

  it('rejectServiceTeamMember: POST em /:sid/team/reject com { workerId, reasonCategory }, devolve o time recalculado', async () => {
    const rejected = { ...TEAM, selected: [], rejected: [{ workerId: 'w1', displayName: 'Fulano', vacancyId: 'v1', reasonCategory: 'INDISPONIBILIDADE_DE_HORARIO' }] };
    const f = mockFetch({ success: true, data: rejected });
    const out = await AdminContractedServicesApiService.rejectServiceTeamMember(PATIENT_ID, SERVICE_ID, 'w1', 'INDISPONIBILIDADE_DE_HORARIO');
    expect(out).toEqual(rejected);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/contracted-services/${SERVICE_ID}/team/reject`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ workerId: 'w1', reasonCategory: 'INDISPONIBILIDADE_DE_HORARIO' });
  });

  it('revertServiceTeamMember: POST em /:sid/team/revert com { workerId, reasonCategory }, devolve o time recalculado', async () => {
    const f = mockFetch({ success: true, data: TEAM });
    const out = await AdminContractedServicesApiService.revertServiceTeamMember(PATIENT_ID, SERVICE_ID, 'w1', 'REAVALIACAO');
    expect(out).toEqual(TEAM);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/contracted-services/${SERVICE_ID}/team/revert`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ workerId: 'w1', reasonCategory: 'REAVALIACAO' });
  });

  it('rejectServiceTeamMember: 422 SERVICE_TEAM_REASON_REQUIRED vira ContractedServiceApiError com status 422 e o code', async () => {
    mockFetch({ success: false, error: 'falta motivo', code: 'SERVICE_TEAM_REASON_REQUIRED' }, 422);
    await expect(
      AdminContractedServicesApiService.rejectServiceTeamMember(PATIENT_ID, SERVICE_ID, 'w1'),
    ).rejects.toMatchObject({ name: 'ContractedServiceApiError', status: 422, code: 'SERVICE_TEAM_REASON_REQUIRED' });
  });

  it('revertServiceTeamMember: 422 SERVICE_TEAM_REASON_REQUIRED vira ContractedServiceApiError com status 422 e o code', async () => {
    mockFetch({ success: false, error: 'falta motivo', code: 'SERVICE_TEAM_REASON_REQUIRED' }, 422);
    await expect(
      AdminContractedServicesApiService.revertServiceTeamMember(PATIENT_ID, SERVICE_ID, 'w1'),
    ).rejects.toMatchObject({ name: 'ContractedServiceApiError', status: 422, code: 'SERVICE_TEAM_REASON_REQUIRED' });
  });

  it('getServiceTeam: 403 vira ContractedServiceApiError com status 403', async () => {
    mockFetch({ success: false, error: 'sem célula' }, 403);
    await expect(AdminContractedServicesApiService.getServiceTeam(PATIENT_ID, SERVICE_ID)).rejects.toMatchObject({
      name: 'ContractedServiceApiError',
      status: 403,
    });
  });

  // Substituição pontual (Fase 13, DX-13.7/13.8/13.11): 3 ações sobre a ausência, cada uma 1
  // método = 1 chamada; nenhuma delas traz nome/dado do prestador na resposta.
  const ALLOCATION_ID = 'a1';
  const ABSENCE_ID = 'ab1';
  const ABSENCE_OPEN = { absenceId: ABSENCE_ID, allocationId: ALLOCATION_ID, date: '2026-10-05', substituteWorkerId: 'w2', status: 'OPEN' as const };

  it('registerAbsence: POST em /itinerary/allocations/:allocationId/absences com { date, substituteWorkerId }', async () => {
    const f = mockFetch({ success: true, data: ABSENCE_OPEN }, 201);
    const out = await AdminContractedServicesApiService.registerAbsence(PATIENT_ID, SERVICE_ID, ALLOCATION_ID, {
      date: '2026-10-05',
      substituteWorkerId: 'w2',
    });
    expect(out).toEqual(ABSENCE_OPEN);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      `/api/admin/patients/${PATIENT_ID}/contracted-services/${SERVICE_ID}/itinerary/allocations/${ALLOCATION_ID}/absences`,
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ date: '2026-10-05', substituteWorkerId: 'w2' });
  });

  it('registerAbsence: sem substituteWorkerId — corpo sem a chave (dia sem cobertura)', async () => {
    const f = mockFetch({ success: true, data: { ...ABSENCE_OPEN, substituteWorkerId: null } }, 201);
    await AdminContractedServicesApiService.registerAbsence(PATIENT_ID, SERVICE_ID, ALLOCATION_ID, { date: '2026-10-05' });
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ date: '2026-10-05' });
  });

  it('registerAbsence: 422 NOT_SELECTED_FOR_SERVICE vira ContractedServiceApiError com o code', async () => {
    mockFetch({ success: false, error: 'não selecionado', code: 'NOT_SELECTED_FOR_SERVICE' }, 422);
    await expect(
      AdminContractedServicesApiService.registerAbsence(PATIENT_ID, SERVICE_ID, ALLOCATION_ID, { date: '2026-10-05' }),
    ).rejects.toMatchObject({ name: 'ContractedServiceApiError', status: 422, code: 'NOT_SELECTED_FOR_SERVICE' });
  });

  it('registerAbsence: 409 ITINERARY_OVERLAP vira ContractedServiceApiError com o code', async () => {
    mockFetch({ success: false, error: 'conflito', code: 'ITINERARY_OVERLAP' }, 409);
    await expect(
      AdminContractedServicesApiService.registerAbsence(PATIENT_ID, SERVICE_ID, ALLOCATION_ID, { date: '2026-10-05', substituteWorkerId: 'w2' }),
    ).rejects.toMatchObject({ name: 'ContractedServiceApiError', status: 409, code: 'ITINERARY_OVERLAP' });
  });

  it('setAbsenceSubstitute: PATCH em /itinerary/absences/:absenceId/substitute com { substituteWorkerId }', async () => {
    const f = mockFetch({ success: true, data: ABSENCE_OPEN });
    const out = await AdminContractedServicesApiService.setAbsenceSubstitute(PATIENT_ID, SERVICE_ID, ABSENCE_ID, 'w2');
    expect(out).toEqual(ABSENCE_OPEN);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/itinerary/absences/${ABSENCE_ID}/substitute`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ substituteWorkerId: 'w2' });
  });

  it('setAbsenceSubstitute: null TIRA o substituto — o corpo leva a chave com null, nunca omitida', async () => {
    const f = mockFetch({ success: true, data: { ...ABSENCE_OPEN, substituteWorkerId: null } });
    await AdminContractedServicesApiService.setAbsenceSubstitute(PATIENT_ID, SERVICE_ID, ABSENCE_ID, null);
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(init.body as string);
    expect(parsed).toHaveProperty('substituteWorkerId', null);
    expect(Object.keys(parsed)).toEqual(['substituteWorkerId']);
  });

  it('setAbsenceSubstitute: 422 ABSENCE_CANCELLED vira ContractedServiceApiError com o code', async () => {
    mockFetch({ success: false, error: 'ausência cancelada', code: 'ABSENCE_CANCELLED' }, 422);
    await expect(
      AdminContractedServicesApiService.setAbsenceSubstitute(PATIENT_ID, SERVICE_ID, ABSENCE_ID, 'w2'),
    ).rejects.toMatchObject({ name: 'ContractedServiceApiError', status: 422, code: 'ABSENCE_CANCELLED' });
  });

  it('cancelAbsence: POST em /itinerary/absences/:absenceId/cancel, sem corpo', async () => {
    const f = mockFetch({ success: true, data: { ...ABSENCE_OPEN, status: 'CANCELLED' } });
    const out = await AdminContractedServicesApiService.cancelAbsence(PATIENT_ID, SERVICE_ID, ABSENCE_ID);
    expect(out).toEqual({ ...ABSENCE_OPEN, status: 'CANCELLED' });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/itinerary/absences/${ABSENCE_ID}/cancel`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('cancelAbsence: 404 NOT_FOUND vira ContractedServiceApiError com status 404', async () => {
    mockFetch({ success: false, error: 'não encontrada', code: 'NOT_FOUND' }, 404);
    await expect(
      AdminContractedServicesApiService.cancelAbsence(PATIENT_ID, SERVICE_ID, ABSENCE_ID),
    ).rejects.toMatchObject({ name: 'ContractedServiceApiError', status: 404, code: 'NOT_FOUND' });
  });
});
