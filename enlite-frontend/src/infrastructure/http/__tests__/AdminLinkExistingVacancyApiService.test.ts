/**
 * AdminLinkExistingVacancyApiService — vínculo de vaga existente (spec 079).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AdminLinkExistingVacancyApiService } from '../AdminLinkExistingVacancyApiService';

const mockGetIdToken = vi.fn().mockResolvedValue('mock-token');
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: (...a: unknown[]) => mockGetIdToken(...a) })),
}));

function mockFetch(payload: unknown, status = 200) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status < 400,
    status,
    json: () => Promise.resolve(payload),
    headers: { get: () => 'application/json' },
  }) as unknown as typeof fetch;
  return global.fetch as unknown as ReturnType<typeof vi.fn>;
}

const PATIENT_ID = 'p1';
const SERVICE_ID = 's1';

describe('AdminLinkExistingVacancyApiService', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const BASE = `/api/admin/patients/${PATIENT_ID}/contracted-services/${SERVICE_ID}/link-existing-vacancy`;
  const PREVIEW = { candidates: [], preview: null };

  it('preview sem vacancyId: POST em /preview com corpo vazio (sem a chave)', async () => {
    const f = mockFetch({ success: true, data: PREVIEW });
    const out = await AdminLinkExistingVacancyApiService.preview(PATIENT_ID, SERVICE_ID);
    expect(out).toEqual(PREVIEW);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${BASE}/preview`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({});
    expect('vacancyId' in body).toBe(false);
  });

  it('preview com vacancyId: manda { vacancyId }', async () => {
    const f = mockFetch({ success: true, data: PREVIEW });
    await AdminLinkExistingVacancyApiService.preview(PATIENT_ID, SERVICE_ID, 'v1');
    const [, init] = f.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ vacancyId: 'v1' });
  });

  it('link: POST em /link-existing-vacancy com { vacancyId } e devolve fedFields', async () => {
    const data = { vacancyId: 'v1', serviceId: SERVICE_ID, fedFields: ['schedule'] };
    const f = mockFetch({ success: true, data });
    const out = await AdminLinkExistingVacancyApiService.link(PATIENT_ID, SERVICE_ID, 'v1');
    expect(out).toEqual(data);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url.endsWith(BASE)).toBe(true);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ vacancyId: 'v1' });
  });

  it('409 SERVICE_ALREADY_RECRUITING expõe code e vacancyId', async () => {
    mockFetch({ success: false, error: 'x', code: 'SERVICE_ALREADY_RECRUITING', vacancyId: 'v9' }, 409);
    await expect(AdminLinkExistingVacancyApiService.link(PATIENT_ID, SERVICE_ID, 'v1'))
      .rejects.toMatchObject({ name: 'ContractedServiceApiError', status: 409, code: 'SERVICE_ALREADY_RECRUITING', vacancyId: 'v9' });
  });

  it('409 VACANCY_NOT_LINKABLE expõe code e reason', async () => {
    mockFetch({ success: false, error: 'x', code: 'VACANCY_NOT_LINKABLE', reason: 'ALREADY_LINKED' }, 409);
    await expect(AdminLinkExistingVacancyApiService.preview(PATIENT_ID, SERVICE_ID, 'v1'))
      .rejects.toMatchObject({ status: 409, code: 'VACANCY_NOT_LINKABLE', reason: 'ALREADY_LINKED' });
  });

  it('422 LINK_BLOCKED expõe code e blockers', async () => {
    mockFetch({ success: false, error: 'x', code: 'LINK_BLOCKED', blockers: ['ADDRESS_MISMATCH'] }, 422);
    await expect(AdminLinkExistingVacancyApiService.link(PATIENT_ID, SERVICE_ID, 'v1'))
      .rejects.toMatchObject({ status: 422, code: 'LINK_BLOCKED', blockers: ['ADDRESS_MISMATCH'] });
  });

  it('422 ADDRESS_NOT_OF_PATIENT expõe o code', async () => {
    mockFetch({ success: false, error: 'x', code: 'ADDRESS_NOT_OF_PATIENT' }, 422);
    await expect(AdminLinkExistingVacancyApiService.link(PATIENT_ID, SERVICE_ID, 'v1'))
      .rejects.toMatchObject({ status: 422, code: 'ADDRESS_NOT_OF_PATIENT' });
  });
});
