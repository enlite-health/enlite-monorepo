import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue('tok') })),
}));

import { AdminPermissionsApiService } from '../AdminPermissionsApiService';
import { AdminAuthzApiService } from '../AdminAuthzApiService';
import { ApiError } from '../ApiError';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function resposta(status: number, body: unknown) {
  return { ok: status < 400, status, json: async () => body };
}

describe('AdminPermissionsApiService — envelope × corpo nu', () => {
  beforeEach(() => fetchMock.mockReset());

  it('leitura devolve o corpo NU e manda o Bearer', async () => {
    fetchMock.mockResolvedValue(resposta(200, { groups: [{ id: 'g1' }] }));
    const groups = await AdminPermissionsApiService.listGroups(true);
    expect(groups).toEqual([{ id: 'g1' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/admin/permission-groups?includeArchived=true');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok' });
  });

  it('escrita desembrulha `{success, data}`', async () => {
    fetchMock.mockResolvedValue(resposta(201, { success: true, data: { groupId: 'g2' } }));
    await expect(AdminPermissionsApiService.createGroup({ name: 'x' })).resolves.toEqual({ groupId: 'g2' });
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('🔴 409 com `code` vira ApiError com o código ESTÁVEL — o que a tela discrimina', async () => {
    fetchMock.mockResolvedValue(resposta(409, { success: false, error: 'frase', code: 'last_manager' }));
    const err = await AdminPermissionsApiService.removeMember('g', 'u').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('last_manager');
    expect(err.status).toBe(409);
  });

  it('erro sem envelope (corpo nu com status ≥ 400) também é ApiError', async () => {
    fetchMock.mockResolvedValue(resposta(502, {}));
    await expect(AdminPermissionsApiService.getCatalog()).rejects.toBeInstanceOf(ApiError);
  });

  it('a trilha só manda os filtros preenchidos', async () => {
    fetchMock.mockResolvedValue(resposta(200, { entries: [] }));
    await AdminPermissionsApiService.queryAudit({ resource: 'worker', userId: '', limit: 50 });
    expect(fetchMock.mock.calls[0][0]).toMatch(/permission-audit\?resource=worker&limit=50$/);
  });

  it('🔴 `userId` preenchido: a trilha vai por POST, com o uid no CORPO (C6)', async () => {
    fetchMock.mockResolvedValue(resposta(200, { entries: [] }));
    await AdminPermissionsApiService.queryAudit({ userId: 'u-1', resource: 'worker', limit: 50 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url).replace(/^https?:\/\/[^/]+/, '')).toBe('/api/admin/permission-audit/query');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ userId: 'u-1', resource: 'worker', limit: 50 });
  });

  it('🔴 removeMember: userId vai no CORPO do DELETE, não no path (C6)', async () => {
    fetchMock.mockResolvedValue(resposta(200, { success: true, data: {} }));
    await AdminPermissionsApiService.removeMember('g', 'u-1');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url).replace(/^https?:\/\/[^/]+/, '')).toBe('/api/admin/permission-groups/g/members');
    expect((init as RequestInit).method).toBe('DELETE');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ userId: 'u-1' });
  });

  it('cada escrita bate na rota certa', async () => {
    fetchMock.mockResolvedValue(resposta(200, { success: true, data: {} }));
    await AdminPermissionsApiService.updateGroup('g', { name: 'n' });
    await AdminPermissionsApiService.archiveGroup('g');
    await AdminPermissionsApiService.setGroupPermissions('g', ['a:b']);
    await AdminPermissionsApiService.grantCountry('g', 'AR', 'r');
    await AdminPermissionsApiService.revokeCountry('g', 'AR');
    await AdminPermissionsApiService.addMember('g', 'u');
    await AdminPermissionsApiService.removeMember('g', 'u');
    await AdminPermissionsApiService.setCountryFeature('AR', 'screen:x', { enabled: true, reason: 'r' });
    await AdminPermissionsApiService.getGroup('g');
    await AdminPermissionsApiService.listMembers('g');
    await AdminPermissionsApiService.listCountryFeatures('AR');
    const chamadas = fetchMock.mock.calls.map(([u, i]) => `${(i as RequestInit).method ?? 'GET'} ${String(u).replace(/^https?:\/\/[^/]+/, '')}`);
    expect(chamadas).toEqual([
      'PATCH /api/admin/permission-groups/g',
      'DELETE /api/admin/permission-groups/g',
      'PUT /api/admin/permission-groups/g/permissions',
      'POST /api/admin/permission-groups/g/countries',
      'DELETE /api/admin/permission-groups/g/countries/AR',
      'POST /api/admin/permission-groups/g/members',
      'DELETE /api/admin/permission-groups/g/members',
      'PUT /api/admin/country-features/AR/screen%3Ax',
      'GET /api/admin/permission-groups/g',
      'GET /api/admin/permission-groups/g/members',
      'GET /api/admin/country-features?country=AR',
    ]);
  });
});

describe('AdminAuthzApiService', () => {
  beforeEach(() => fetchMock.mockReset());

  it('devolve o contrato nu do /v1/me/authz', async () => {
    fetchMock.mockResolvedValue(resposta(200, { uid: 'u', permissions: ['a:read'] }));
    await expect(AdminAuthzApiService.getMyAuthz()).resolves.toMatchObject({ uid: 'u' });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/v1\/me\/authz$/);
  });

  it('🔴 500 LANÇA — nunca vira contrato vazio', async () => {
    fetchMock.mockResolvedValue(resposta(500, { success: false, error: 'boom' }));
    await expect(AdminAuthzApiService.getMyAuthz()).rejects.toThrow('boom');
  });
});

describe('AdminPermissionsApiService — query strings e ausência de token', () => {
  beforeEach(() => fetchMock.mockReset());

  it('includeDeprecated / includeArchived / country viram query string', async () => {
    fetchMock.mockResolvedValue(resposta(200, { categories: [], groups: [], features: [] }));
    await AdminPermissionsApiService.getCatalog(true);
    await AdminPermissionsApiService.listGroups(false);
    await AdminPermissionsApiService.listCountryFeatures();
    const urls = fetchMock.mock.calls.map(([u]) => String(u).replace(/^https?:\/\/[^/]+/, ''));
    expect(urls).toEqual(['/api/admin/permissions/catalog?includeDeprecated=true', '/api/admin/permission-groups', '/api/admin/country-features']);
  });
});

describe('sem token do Firebase', () => {
  it('os dois clientes chamam sem Authorization — o backend responde 401, não o front', async () => {
    vi.resetModules();
    vi.doMock('@infrastructure/services/FirebaseAuthService', () => ({
      FirebaseAuthService: vi.fn().mockImplementation(() => ({ getIdToken: vi.fn().mockResolvedValue(null) })),
    }));
    const { AdminPermissionsApiService: P } = await import('../AdminPermissionsApiService');
    const { AdminAuthzApiService: A } = await import('../AdminAuthzApiService');
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(resposta(200, { groups: [] })).mockResolvedValueOnce(resposta(401, {}));
    await P.listGroups();
    await expect(A.getMyAuthz()).rejects.toThrow('HTTP 401');
    for (const [, init] of fetchMock.mock.calls) expect((init as RequestInit).headers).not.toHaveProperty('Authorization');
  });
});

describe('queryAudit sem filtros', () => {
  it('não põe `?` na URL', async () => {
    fetchMock.mockReset().mockResolvedValue(resposta(200, { entries: [] }));
    await AdminPermissionsApiService.queryAudit();
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/api\/admin\/permission-audit$/);
  });

  it('🔒 grantCountry manda `reason: null` quando não recebe motivo', async () => {
    // a mig 412 tornou o motivo opcional; o contrato manda `null` explícito em
    // vez de omitir a chave, para o zod da rota não ver `undefined` e o banco
    // não receber string vazia (um terceiro estado sem significado).
    fetchMock.mockResolvedValue(resposta(200, { success: true, data: { scopeId: 's' } }));
    await AdminPermissionsApiService.grantCountry('g1', 'BR');
    // procura a chamada pelo CAMINHO, não por índice: contar posição quebra
    // quando outro teste do arquivo deixa chamada na frente.
    const corpos = (): unknown[] => fetchMock.mock.calls
      .filter((c) => String(c[0]).endsWith('/countries'))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(corpos()).toEqual([{ country: 'BR', reason: null }]);

    await AdminPermissionsApiService.grantCountry('g1', 'AR', 'quando vier, vai');
    expect(corpos()).toEqual([
      { country: 'BR', reason: null },
      { country: 'AR', reason: 'quando vier, vai' },
    ]);
  });
});
