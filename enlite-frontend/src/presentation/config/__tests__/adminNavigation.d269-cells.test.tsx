/**
 * adminNavigation.d269-cells.test.tsx
 *
 * D269 (Gabriel) + D268: os 4 itens admin-only (Tags/Dedup/Roles de
 * grupos/Postulaciones bloqueadas) eram derivados de `role === ADMIN`
 * (dívida nomeada na D268: "nunca derivado de role"). Prova que agora
 * derivam da CÉLULA DE LEITURA da rota que cada tela chama:
 *   Tags        → worker:read
 *   Dedup       → dedup:read
 *   Roles grupo → patient:read
 *   Bloqueados  → recruitment:read
 *
 * ... com o MESMO freio de rollout do resto da B1 (`enforcement === 'on'`):
 * enquanto `'off'`, o comportamento atual por `role` continua — não é uma
 * segunda régua, é a mesma da `useFeature`/`ActionButton`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminNavItems } from '../adminNavigation';
import { EnliteRole } from '@domain/entities/EnliteRole';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: vi.fn(),
}));

import { useAdminAuth } from '@presentation/hooks/useAdminAuth';

const HREFS = {
  tags: '/admin/tags',
  dedup: '/admin/dedup',
  patientChatRoles: '/admin/patient-chat-roles',
  blockedAttempts: '/admin/recruitment/blocked-attempts',
};

const contrato = (permissions: string[], enforcement: AuthzContract['enforcement']): AuthzContract => ({
  uid: 'u',
  tenantId: 't',
  status: 'ACTIVE',
  permissions,
  countries: [],
  groups: [],
  features: {},
  enforcement,
});

afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

describe('D269 — enforcement ON: célula manda, role não', () => {
  it('ADMIN SEM nenhuma das 4 células → os 4 itens somem, mesmo sendo ADMIN', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.ADMIN },
    } as ReturnType<typeof useAdminAuth>);
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'on') });

    const hrefs = renderHook(() => useAdminNavItems()).result.current.map((i) => i.href);
    expect(hrefs).not.toContain(HREFS.tags);
    expect(hrefs).not.toContain(HREFS.dedup);
    expect(hrefs).not.toContain(HREFS.patientChatRoles);
    expect(hrefs).not.toContain(HREFS.blockedAttempts);
  });

  it('RECRUITER (não-admin) COM as 4 células → os 4 itens aparecem — a célula, não o role, decide', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.RECRUITER },
    } as ReturnType<typeof useAdminAuth>);
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato(['worker:read', 'dedup:read', 'patient:read', 'recruitment:read'], 'on'),
    });

    const hrefs = renderHook(() => useAdminNavItems()).result.current.map((i) => i.href);
    expect(hrefs).toContain(HREFS.tags);
    expect(hrefs).toContain(HREFS.dedup);
    expect(hrefs).toContain(HREFS.patientChatRoles);
    expect(hrefs).toContain(HREFS.blockedAttempts);
  });

  it('RECRUITER com SÓ dedup:read → só Dedup aparece, os outros 3 continuam fora', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.RECRUITER },
    } as ReturnType<typeof useAdminAuth>);
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['dedup:read'], 'on') });

    const hrefs = renderHook(() => useAdminNavItems()).result.current.map((i) => i.href);
    expect(hrefs).toContain(HREFS.dedup);
    expect(hrefs).not.toContain(HREFS.tags);
    expect(hrefs).not.toContain(HREFS.patientChatRoles);
    expect(hrefs).not.toContain(HREFS.blockedAttempts);
  });

  it('sectionStart cai no primeiro item que sobrevive ao filtro de célula (não fixo em Tags)', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.RECRUITER },
    } as ReturnType<typeof useAdminAuth>);
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['dedup:read'], 'on') });

    const items = renderHook(() => useAdminNavItems()).result.current;
    const dedupItem = items.find((i) => i.href === HREFS.dedup);
    expect(dedupItem?.sectionStart).toBeTruthy();
  });
});

describe('D269 — enforcement OFF (ou contrato ausente): comportamento atual por role continua', () => {
  it('ADMIN sem contrato nenhum (authz null) → os 4 itens aparecem (fallback de role, não trava a stage)', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.ADMIN },
    } as ReturnType<typeof useAdminAuth>);
    // authzStatus 'idle', authz null — default do describe acima via afterEach.

    const hrefs = renderHook(() => useAdminNavItems()).result.current.map((i) => i.href);
    expect(hrefs).toContain(HREFS.tags);
    expect(hrefs).toContain(HREFS.dedup);
    expect(hrefs).toContain(HREFS.patientChatRoles);
    expect(hrefs).toContain(HREFS.blockedAttempts);
  });

  it('RECRUITER com as 4 células concedidas MAS enforcement "off" → os 4 itens NÃO aparecem (role decide, não a célula)', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.RECRUITER },
    } as ReturnType<typeof useAdminAuth>);
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: contrato(['worker:read', 'dedup:read', 'patient:read', 'recruitment:read'], 'off'),
    });

    const hrefs = renderHook(() => useAdminNavItems()).result.current.map((i) => i.href);
    expect(hrefs).not.toContain(HREFS.tags);
    expect(hrefs).not.toContain(HREFS.dedup);
    expect(hrefs).not.toContain(HREFS.patientChatRoles);
    expect(hrefs).not.toContain(HREFS.blockedAttempts);
  });
});
