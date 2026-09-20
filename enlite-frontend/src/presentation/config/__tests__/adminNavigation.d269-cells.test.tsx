/**
 * adminNavigation.d269-cells.test.tsx
 *
 * D269 + D268: os itens da seção Administración (Tags/Dedup/Roles de grupos/
 * Postulaciones bloqueadas/Mensajería) derivam da CÉLULA DE LEITURA da rota
 * que cada tela chama:
 *   Tags        → worker:read
 *   Dedup       → dedup:read
 *   Roles grupo → patient:read
 *   Bloqueados  → recruitment:read
 *   Mensajería  → messaging:read
 *
 * ... com o MESMO freio de rollout do resto da B1 (`enforcement === 'on'`):
 * enquanto `'off'`, o item aparece como sempre apareceu — não é uma segunda
 * régua, é a mesma da `useFeature`/`ActionButton`. Papel não entra na conta.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminNavItems } from '../adminNavigation';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const HREFS = {
  tags: '/admin/tags',
  dedup: '/admin/dedup',
  patientChatRoles: '/admin/patient-chat-roles',
  blockedAttempts: '/admin/recruitment/blocked-attempts',
  funnelStageMessages: '/admin/mensajes-por-etapa',
};

const TODAS = ['worker:read', 'dedup:read', 'patient:read', 'recruitment:read', 'messaging:read'];

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

const hrefs = () => renderHook(() => useAdminNavItems()).result.current.map((i) => i.href);

afterEach(() => useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' }));

describe('D269 — enforcement ON: a célula manda', () => {
  it('SEM nenhuma das células → os itens somem', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'on') });

    const atuais = hrefs();
    expect(atuais).not.toContain(HREFS.tags);
    expect(atuais).not.toContain(HREFS.dedup);
    expect(atuais).not.toContain(HREFS.patientChatRoles);
    expect(atuais).not.toContain(HREFS.blockedAttempts);
    expect(atuais).not.toContain(HREFS.funnelStageMessages);
  });

  it('COM todas as células → todos os itens aparecem', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(TODAS, 'on') });

    const atuais = hrefs();
    expect(atuais).toContain(HREFS.tags);
    expect(atuais).toContain(HREFS.dedup);
    expect(atuais).toContain(HREFS.patientChatRoles);
    expect(atuais).toContain(HREFS.blockedAttempts);
    expect(atuais).toContain(HREFS.funnelStageMessages);
  });

  it('SÓ dedup:read → só Dedup aparece, os outros continuam fora', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['dedup:read'], 'on') });

    const atuais = hrefs();
    expect(atuais).toContain(HREFS.dedup);
    expect(atuais).not.toContain(HREFS.tags);
    expect(atuais).not.toContain(HREFS.patientChatRoles);
    expect(atuais).not.toContain(HREFS.blockedAttempts);
    expect(atuais).not.toContain(HREFS.funnelStageMessages);
  });

  it('sectionStart cai no primeiro item que sobrevive ao filtro de célula (não fixo em Tags)', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato(['dedup:read'], 'on') });

    const items = renderHook(() => useAdminNavItems()).result.current;
    expect(items.find((i) => i.href === HREFS.dedup)?.sectionStart).toBeTruthy();
  });
});

describe('D269 — enforcement OFF (ou contrato ausente): os itens aparecem como sempre apareceram', () => {
  it('sem contrato nenhum (authz null) → os itens aparecem — não trava a stage nem o main', () => {
    // authzStatus 'idle', authz null — o estado que o `afterEach` restaura.
    const atuais = hrefs();
    expect(atuais).toContain(HREFS.tags);
    expect(atuais).toContain(HREFS.dedup);
    expect(atuais).toContain(HREFS.patientChatRoles);
    expect(atuais).toContain(HREFS.blockedAttempts);
    expect(atuais).toContain(HREFS.funnelStageMessages);
  });

  it('enforcement "off" SEM célula nenhuma → os itens continuam aparecendo (a célula não é freio com o engine desligado)', () => {
    useAdminAuthStore.setState({ authzStatus: 'ready', authz: contrato([], 'off') });

    const atuais = hrefs();
    expect(atuais).toContain(HREFS.tags);
    expect(atuais).toContain(HREFS.dedup);
    expect(atuais).toContain(HREFS.patientChatRoles);
    expect(atuais).toContain(HREFS.blockedAttempts);
    expect(atuais).toContain(HREFS.funnelStageMessages);
  });
});
