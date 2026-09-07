import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    signInWithEmail: vi.fn().mockResolvedValue({ user: { id: 'u1', email: 'a@enlite.health' } }),
    signInWithGoogle: vi.fn().mockImplementation(async () => ({ user: { id: 'u1', email: emailGoogle } })),
    logout: vi.fn().mockResolvedValue(undefined),
    onAuthStateChanged: vi.fn(),
    getIdToken: vi.fn().mockResolvedValue('tok'),
    forceRefreshToken: vi.fn().mockImplementation(async () => { ordem.push('refresh'); }),
  })),
}));
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { getProfile: vi.fn().mockResolvedValue({ firebaseUid: 'u1' }) },
}));
const ordem: string[] = [];
let emailGoogle = 'a@enlite.health';
const getMyAuthz = vi.fn().mockImplementation(async () => { ordem.push('authz'); return CONTRATO; });
vi.mock('@infrastructure/http/AdminAuthzApiService', () => ({
  AdminAuthzApiService: { getMyAuthz: (...a: unknown[]) => getMyAuthz(...a) },
}));

import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import { AdminApiService } from '@infrastructure/http/AdminApiService';

const CONTRATO: Record<string, unknown> = { uid: 'u1', tenantId: 't', status: 'ACTIVE', permissions: ['permission_management:read'], countries: ['AR'], groups: [], features: {} };

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

  it('fetchAuthz sozinho SEM contrato prévio passa por `loading`', async () => {
    let resolver: (v: unknown) => void = () => {};
    getMyAuthz.mockReturnValue(new Promise((r) => { resolver = r; }));
    const p = useAdminAuthStore.getState().fetchAuthz();
    expect(useAdminAuthStore.getState().authzStatus).toBe('loading');
    resolver(CONTRATO);
    await p;
    expect(useAdminAuthStore.getState().authzStatus).toBe('ready');
  });

  it('🔴 fetchAuthz COM contrato prévio: stale-while-revalidate — NUNCA passa por `loading`, o contrato velho fica até o novo chegar', async () => {
    const antigo = { ...CONTRATO, permissions: ['worker:read'] };
    useAdminAuthStore.setState({ authz: antigo as never, authzStatus: 'ready' });
    let resolver: (v: unknown) => void = () => {};
    getMyAuthz.mockReturnValue(new Promise((r) => { resolver = r; }));
    const p = useAdminAuthStore.getState().fetchAuthz();
    // durante o refetch: ainda `ready`, ainda com o contrato ANTIGO — nunca `loading`/vazio.
    expect(useAdminAuthStore.getState().authzStatus).toBe('ready');
    expect(useAdminAuthStore.getState().authz).toEqual(antigo);
    resolver(CONTRATO);
    await p;
    expect(useAdminAuthStore.getState()).toMatchObject({ authzStatus: 'ready', authz: CONTRATO });
  });

  it('fetchAuthz COM contrato prévio, se a busca nova FALHA: mantém o contrato antigo (nunca vira `error`/null no meio do uso)', async () => {
    const antigo = { ...CONTRATO, permissions: ['worker:read'] };
    useAdminAuthStore.setState({ authz: antigo as never, authzStatus: 'ready' });
    getMyAuthz.mockRejectedValue(new Error('500'));
    await useAdminAuthStore.getState().fetchAuthz();
    expect(useAdminAuthStore.getState()).toMatchObject({ authzStatus: 'ready', authz: antigo });
  });

  it('logout apaga o contrato — a próxima pessoa não herda células', async () => {
    useAdminAuthStore.setState({ authz: CONTRATO as never, authzStatus: 'ready' });
    await useAdminAuthStore.getState().logout();
    expect(useAdminAuthStore.getState()).toMatchObject({ authz: null, authzStatus: 'idle' });
  });

  it('🔴 login Google: o contrato só é buscado DEPOIS do refresh do token (claims do auto-provisioning)', async () => {
    ordem.length = 0;
    getMyAuthz.mockImplementation(async () => { ordem.push('authz'); return CONTRATO; });
    await useAdminAuthStore.getState().loginWithGoogle();
    expect(ordem).toEqual(['refresh', 'authz']);
    expect(useAdminAuthStore.getState().authzStatus).toBe('ready');
  });

  it('login Google com perfil falhando: adminProfile fica nulo, o contrato NÃO é buscado, e o trace registra a falha', async () => {
    (AdminApiService.getProfile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('404'));
    getMyAuthz.mockClear();
    const trace = { step: vi.fn(), fail: vi.fn() };
    await useAdminAuthStore.getState().loginWithGoogle(trace as never);
    expect(useAdminAuthStore.getState().adminProfile).toBeNull();
    expect(getMyAuthz).not.toHaveBeenCalled();
    expect(trace.fail).toHaveBeenCalledWith('backend-profile-or-refresh', expect.any(Error));
  });

  it('login por senha com perfil falhando E trace: o trace recebe a falha do perfil', async () => {
    (AdminApiService.getProfile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('404'));
    const trace = { step: vi.fn(), fail: vi.fn() };
    await useAdminAuthStore.getState().login('a@enlite.health', 'x', trace as never);
    expect(trace.fail).toHaveBeenCalledWith('backend-profile', expect.any(Error));
    expect(useAdminAuthStore.getState().adminProfile).toBeNull();
  });

  it('login Google fora do domínio, com trace: registra a rejeição e não busca perfil nem contrato', async () => {
    emailGoogle = 'x@gmail.com';
    const trace = { step: vi.fn(), fail: vi.fn() };
    getMyAuthz.mockClear();
    await expect(useAdminAuthStore.getState().loginWithGoogle(trace as never)).rejects.toThrow('admin.login.unauthorizedDomain');
    expect(trace.step).toHaveBeenCalledWith('domain-check:rejected', { email: 'x@gmail.com' });
    expect(getMyAuthz).not.toHaveBeenCalled();
    emailGoogle = 'a@enlite.health';
  });

  it('login por senha com perfil falhando e SEM trace: nada explode, perfil nulo', async () => {
    (AdminApiService.getProfile as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('404'));
    await expect(useAdminAuthStore.getState().login('a@enlite.health', 'x')).resolves.toBeUndefined();
    expect(useAdminAuthStore.getState().adminProfile).toBeNull();
  });

  it('login por senha COM trace e perfil ok: o trace vê o perfil e o contrato carrega', async () => {
    getMyAuthz.mockResolvedValue(CONTRATO);
    const trace = { step: vi.fn(), fail: vi.fn() };
    await useAdminAuthStore.getState().login('a@enlite.health', 'x', trace as never);
    expect(trace.step).toHaveBeenCalledWith('backend-profile:ok');
    expect(useAdminAuthStore.getState().authzStatus).toBe('ready');
  });
});
