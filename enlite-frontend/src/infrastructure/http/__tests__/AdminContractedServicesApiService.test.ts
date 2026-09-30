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
    mockFetch({ success: false, error: 'conflito', code: 'SERVICE_CONFLICT' }, 409);
    await expect(
      AdminContractedServicesApiService.updateContractedService(PATIENT_ID, SERVICE_ID, { active: false }),
    ).rejects.toMatchObject({
      name: 'ContractedServiceApiError',
      status: 409,
      code: 'SERVICE_CONFLICT',
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
      reasonCategory: 'OTHER',
    });
    expect(out).toEqual(ABSENCE_OPEN);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(
      `/api/admin/patients/${PATIENT_ID}/contracted-services/${SERVICE_ID}/itinerary/allocations/${ALLOCATION_ID}/absences`,
    );
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ date: '2026-10-05', substituteWorkerId: 'w2', reasonCategory: 'OTHER' });
  });

  it('registerAbsence: sem substituteWorkerId — corpo sem a chave (dia sem cobertura)', async () => {
    const f = mockFetch({ success: true, data: { ...ABSENCE_OPEN, substituteWorkerId: null } }, 201);
    await AdminContractedServicesApiService.registerAbsence(PATIENT_ID, SERVICE_ID, ALLOCATION_ID, { date: '2026-10-05', reasonCategory: 'OTHER' });
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ date: '2026-10-05', reasonCategory: 'OTHER' });
  });

  it('registerAbsence: 422 NOT_SELECTED_FOR_SERVICE vira ContractedServiceApiError com o code', async () => {
    mockFetch({ success: false, error: 'não selecionado', code: 'NOT_SELECTED_FOR_SERVICE' }, 422);
    await expect(
      AdminContractedServicesApiService.registerAbsence(PATIENT_ID, SERVICE_ID, ALLOCATION_ID, { date: '2026-10-05', reasonCategory: 'OTHER' }),
    ).rejects.toMatchObject({ name: 'ContractedServiceApiError', status: 422, code: 'NOT_SELECTED_FOR_SERVICE' });
  });

  it('registerAbsence: 409 ITINERARY_OVERLAP vira ContractedServiceApiError com o code', async () => {
    mockFetch({ success: false, error: 'conflito', code: 'ITINERARY_OVERLAP' }, 409);
    await expect(
      AdminContractedServicesApiService.registerAbsence(PATIENT_ID, SERVICE_ID, ALLOCATION_ID, { date: '2026-10-05', substituteWorkerId: 'w2', reasonCategory: 'OTHER' }),
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

  describe('itinerário (Fase 12, DX-12.6)', () => {
    const SLOT_ID = 'sl1';
    const WORKER_ID = 'w1';
    const OVERLAP_BODY = {
      success: false,
      error: 'conflito de horário',
      code: 'ITINERARY_OVERLAP',
      existing: { serviceId: 's9', weekday: 1, startTime: '08:00', endTime: '12:00' },
      requested: { serviceId: SERVICE_ID, weekday: 1, startTime: '10:00', endTime: '14:00' },
      sameAddress: false,
      minGapMinutes: 45,
    };

    it('getItinerary: GET em /patients/:id/itinerary, devolve o itinerário', async () => {
      const data = { patientId: PATIENT_ID, asOf: '2026-10-07', services: [], alerts: [] };
      const f = mockFetch({ success: true, data });
      const out = await AdminContractedServicesApiService.getItinerary(PATIENT_ID);
      expect(out).toEqual(data);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(new RegExp(`/api/admin/patients/${PATIENT_ID}/itinerary$`));
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
    });

    it('assembleItinerary: POST em /patients/:id/itinerary/assemble sem corpo; 422 vira ContractedServiceApiError com code', async () => {
      const data = { patientId: PATIENT_ID, assembledAt: '2026-09-30T18:00:00.000Z' };
      const f = mockFetch({ success: true, data }, 201);
      const out = await AdminContractedServicesApiService.assembleItinerary(PATIENT_ID);
      expect(out).toEqual(data);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(new RegExp(`/api/admin/patients/${PATIENT_ID}/itinerary/assemble$`));
      expect(init.method).toBe('POST');
      expect(init.body).toBeUndefined();

      mockFetch({ success: false, code: 'SERVICE_WITHOUT_SLOT', services: [] }, 422);
      await expect(AdminContractedServicesApiService.assembleItinerary(PATIENT_ID)).rejects.toMatchObject({ status: 422, code: 'SERVICE_WITHOUT_SLOT' });
    });

    it('getAllocationOptions: GET em /:sid/allocation-options, devolve { serviceId, vacancyId, options }', async () => {
      const data = { serviceId: SERVICE_ID, vacancyId: 'v1', options: [{ workerId: WORKER_ID, displayName: null, vacancyId: 'v1' }] };
      const f = mockFetch({ success: true, data });
      const out = await AdminContractedServicesApiService.getAllocationOptions(PATIENT_ID, SERVICE_ID);
      expect(out).toEqual(data);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(new RegExp(`/api/admin/patients/${PATIENT_ID}/contracted-services/${SERVICE_ID}/allocation-options$`));
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
    });

    it('allocate: POST em /itinerary/slots/:slotId/allocations com { workerId }', async () => {
      const data = { allocationId: 'al1', slotId: SLOT_ID, workerId: WORKER_ID, applicationId: 'a1', validFrom: '2026-10-07', status: 'ACTIVE' };
      const f = mockFetch({ success: true, data }, 201);
      const out = await AdminContractedServicesApiService.allocate(PATIENT_ID, SERVICE_ID, SLOT_ID, WORKER_ID);
      expect(out).toEqual(data);
      const [url, init] = f.mock.calls[0] as [string, RequestInit];
      expect(url).toMatch(
        new RegExp(`/api/admin/patients/${PATIENT_ID}/contracted-services/${SERVICE_ID}/itinerary/slots/${SLOT_ID}/allocations$`),
      );
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body as string)).toEqual({ workerId: WORKER_ID });
    });

    it('allocate: 409 ITINERARY_OVERLAP com existing/requested → err.overlap preenchido com os 4 campos da API', async () => {
      mockFetch(OVERLAP_BODY, 409);
      const err = await AdminContractedServicesApiService.allocate(PATIENT_ID, SERVICE_ID, SLOT_ID, WORKER_ID).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ContractedServiceApiError);
      const apiErr = err as ContractedServiceApiError;
      expect(apiErr.status).toBe(409);
      expect(apiErr.code).toBe('ITINERARY_OVERLAP');
      expect(apiErr.overlap).toEqual({
        existing: OVERLAP_BODY.existing,
        requested: OVERLAP_BODY.requested,
        sameAddress: false,
        minGapMinutes: 45,
      });
    });

    it('allocate: 409 com minGapMinutes null (mesmo endereço) → overlap.minGapMinutes null', async () => {
      mockFetch({ ...OVERLAP_BODY, sameAddress: true, minGapMinutes: null }, 409);
      const err = (await AdminContractedServicesApiService.allocate(PATIENT_ID, SERVICE_ID, SLOT_ID, WORKER_ID).catch((e: unknown) => e)) as ContractedServiceApiError;
      expect(err.overlap).toMatchObject({ sameAddress: true, minGapMinutes: null });
    });

    it('allocate: 422 sem existing/requested → err.overlap undefined, err.code preenchido', async () => {
      mockFetch({ success: false, error: 'já alocado', code: 'ALREADY_ALLOCATED_IN_SLOT' }, 422);
      const err = (await AdminContractedServicesApiService.allocate(PATIENT_ID, SERVICE_ID, SLOT_ID, WORKER_ID).catch((e: unknown) => e)) as ContractedServiceApiError;
      expect(err).toBeInstanceOf(ContractedServiceApiError);
      expect(err.status).toBe(422);
      expect(err.code).toBe('ALREADY_ALLOCATED_IN_SLOT');
      expect(err.overlap).toBeUndefined();
    });

    it('ContractedServiceApiError sem os campos de conflito (só code/details) → overlap undefined', () => {
      const err = new ContractedServiceApiError('x', 422, { code: 'C', details: { slotId: 'sl1' } });
      expect(err.code).toBe('C');
      expect(err.details).toEqual({ slotId: 'sl1' });
      expect(err.overlap).toBeUndefined();
    });
  });
});
