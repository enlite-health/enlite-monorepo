import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * F3/T3.7 (spec 026) — cobertura das 3 rotas de simulação de grupo em
 * `AdminAuthzApiService` (`listSimulatableGroups`/`startSimulation`/
 * `endSimulation`), até então só exercitadas indiretamente via mock da
 * store (`adminAuthStore.simulation.test.ts`) — o `fetch` real nunca rodava.
 * Não existia teste algum para este arquivo (nem para `getMyAuthz`); este é
 * o primeiro, com o molde de mock de `fetch`/`FirebaseAuthService` já usado
 * nos demais serviços HTTP do projeto.
 */

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: vi.fn().mockResolvedValue('tok-123'),
  })),
}));

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** 204: sem corpo — `.json()` chamado é o BUG que este molde precisa acusar. */
function noContentResponse(): Response {
  return {
    ok: true,
    status: 204,
    json: () => Promise.reject(new Error('204 não tem corpo — `.json()` nunca deveria ser chamado')),
  } as unknown as Response;
}

describe('AdminAuthzApiService — simulação de grupo (F3/T3.7)', () => {
  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
  });

  it('listSimulatableGroups(): 200 devolve a lista [{id,name}] e manda o Authorization', async () => {
    const { AdminAuthzApiService } = await import('../AdminAuthzApiService');
    const grupos = [
      { id: 'g-recl', name: 'Reclutamiento - AG' },
      { id: 'g-fin', name: 'Finanzas - AG' },
    ];
    fetchMock.mockResolvedValue(jsonResponse(200, grupos));

    const resultado = await AdminAuthzApiService.listSimulatableGroups();

    expect(resultado).toEqual(grupos);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/me/simulation/groups');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-123');
  });

  it('listSimulatableGroups(): 403 not_master_member vira AuthzActionError com o code preservado', async () => {
    const { AdminAuthzApiService, AuthzActionError } = await import('../AdminAuthzApiService');
    fetchMock.mockResolvedValue(jsonResponse(403, { code: 'not_master_member' }));

    await expect(AdminAuthzApiService.listSimulatableGroups()).rejects.toMatchObject({
      code: 'not_master_member',
    });
    await expect(AdminAuthzApiService.listSimulatableGroups()).rejects.toBeInstanceOf(AuthzActionError);
  });

  it('startSimulation(groupId): 201 devolve o snapshot da simulação, com groupId no corpo da request', async () => {
    const { AdminAuthzApiService } = await import('../AdminAuthzApiService');
    const simulacao = {
      id: 's1',
      groupId: 'g-recl',
      groupName: 'Reclutamiento - AG',
      startedAt: '2026-09-23T10:00:00.000Z',
      expiresAt: '2026-09-23T14:00:00.000Z',
    };
    fetchMock.mockResolvedValue(jsonResponse(201, simulacao));

    const resultado = await AdminAuthzApiService.startSimulation('g-recl');

    expect(resultado).toEqual(simulacao);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/me/simulation');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ groupId: 'g-recl' });
  });

  it('startSimulation(groupId): 422 group_not_simulable vira AuthzActionError com o code preservado', async () => {
    const { AdminAuthzApiService } = await import('../AdminAuthzApiService');
    fetchMock.mockResolvedValue(jsonResponse(422, { code: 'group_not_simulable' }));

    await expect(AdminAuthzApiService.startSimulation('g-master')).rejects.toMatchObject({
      code: 'group_not_simulable',
    });
  });

  it('endSimulation(): 204 resolve sem chamar .json() no corpo (a Response não tem corpo)', async () => {
    const { AdminAuthzApiService } = await import('../AdminAuthzApiService');
    fetchMock.mockResolvedValue(noContentResponse());

    await expect(AdminAuthzApiService.endSimulation()).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/me/simulation');
    expect(init.method).toBe('DELETE');
  });

  it('endSimulation(): erro 500 (sem `code` no corpo) vira AuthzActionError com o HTTP status como code', async () => {
    const { AdminAuthzApiService } = await import('../AdminAuthzApiService');
    fetchMock.mockResolvedValue(jsonResponse(500, {}));

    await expect(AdminAuthzApiService.endSimulation()).rejects.toMatchObject({ code: 'HTTP 500' });
  });

  it('sem token (getIdToken devolve null/undefined): a request sai SEM header Authorization', async () => {
    vi.doMock('@infrastructure/services/FirebaseAuthService', () => ({
      FirebaseAuthService: vi.fn().mockImplementation(() => ({
        getIdToken: vi.fn().mockResolvedValue(null),
      })),
    }));
    const { AdminAuthzApiService } = await import('../AdminAuthzApiService');
    fetchMock.mockResolvedValue(jsonResponse(200, []));

    await AdminAuthzApiService.listSimulatableGroups();

    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });
});
