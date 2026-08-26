import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    signInWithEmail: vi.fn().mockResolvedValue({ user: { id: 'u1', email: 'a@enlite.health' } }),
    signInWithGoogle: vi.fn(),
    logout: vi.fn().mockResolvedValue(undefined),
    onAuthStateChanged: vi.fn(),
    getIdToken: vi.fn().mockResolvedValue('tok'),
    forceRefreshToken: vi.fn(),
  })),
}));
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { getProfile: vi.fn().mockResolvedValue({ firebaseUid: 'u1', role: 'admin' }) },
}));
const getMyAuthz = vi.fn();
vi.mock('@infrastructure/http/AdminAuthzApiService', () => ({
  AdminAuthzApiService: { getMyAuthz: (...a: unknown[]) => getMyAuthz(...a) },
}));

import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';

const CONTRATO = { uid: 'u1', tenantId: 't', status: 'ACTIVE', permissions: ['permission_management:read'], countries: ['AR'], groups: [], features: {} };

describe('adminAuthStore — o contrato de authz', () => {
  beforeEach(() => {
    getMyAuthz.mockReset();
    useAdminAuthStore.setState({ user: null, adminProfile: null, isAuthenticated: false, authz: null, authzStatus: 'idle' });
  });

  it('login carrega o contrato DEPOIS do perfil, e fica `ready`', async () => {
    getMyAuthz.mockResolvedValue(CONTRATO);
    await useAdminAuthStore.getState().login('a@enlite.health', 'x');
    const s = useAdminAuthStore.getState();
    expect(s.authzStatus).toBe('ready');
    expect(s.authz?.permissions).toEqual(['permission_management:read']);
  });

  it('🔴 falha ao carregar vira `error` com authz nulo — nunca contrato vazio, nunca exceção no login', async () => {
    getMyAuthz.mockRejectedValue(new Error('500'));
    await expect(useAdminAuthStore.getState().login('a@enlite.health', 'x')).resolves.toBeUndefined();
    const s = useAdminAuthStore.getState();
    expect(s.authzStatus).toBe('error');
    expect(s.authz).toBeNull();
    // o perfil sobreviveu: o erro é do contrato, não do login
    expect(s.adminProfile).not.toBeNull();
  });

  it('fetchAuthz sozinho passa por `loading`', async () => {
    let resolver: (v: unknown) => void = () => {};
    getMyAuthz.mockReturnValue(new Promise((r) => { resolver = r; }));
    const p = useAdminAuthStore.getState().fetchAuthz();
    expect(useAdminAuthStore.getState().authzStatus).toBe('loading');
    resolver(CONTRATO);
    await p;
    expect(useAdminAuthStore.getState().authzStatus).toBe('ready');
  });

  it('logout apaga o contrato — a próxima pessoa não herda células', async () => {
    useAdminAuthStore.setState({ authz: CONTRATO as never, authzStatus: 'ready' });
    await useAdminAuthStore.getState().logout();
    expect(useAdminAuthStore.getState()).toMatchObject({ authz: null, authzStatus: 'idle' });
  });
});
