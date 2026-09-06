/**
 * D286 fase 2 — "Hacer match" (match:execute) e "Enviar convites" (messaging:send) somem sem a
 * célula. A rota já decidia; o botão cru era a dívida da F14 apontada no inventário.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VacancyFunnelView } from './VacancyFunnelView';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@hooks/admin/useVacancyFunnelTable', () => ({
  useVacancyFunnelTable: () => ({ data: { rows: [], counts: { INVITED: 0, POSTULATED: 0, PRE_SELECTED: 0, REJECTED: 0, WITHDREW: 0, ALL: 0 } }, isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock('@hooks/admin/useInvitedPendingCandidates', () => ({
  useInvitedPendingCandidates: () => ({ candidates: [], pendingCount: 2, isLoading: false, refetch: vi.fn() }),
}));
vi.mock('./VacancyFunnelKanban', () => ({ VacancyFunnelKanban: () => <div /> }));
vi.mock('./VacancyFunnelTable', () => ({ VacancyFunnelTable: () => <div /> }));
vi.mock('./VacancyFunnelTabs', () => ({ VacancyFunnelTabs: () => <div /> }));
vi.mock('./VacancyFunnelToggle', () => ({ VacancyFunnelToggle: () => <div /> }));

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}
const vacancy = { id: 'v1' } as never;

beforeEach(() => localStorage.clear());

describe('VacancyFunnelView — portões por célula (D286 fase 2)', () => {
  it('enforcement=on sem match:execute nem messaging:send: os dois botões SOMEM', () => {
    comEnforcement(['funnel:read'], 'on');
    render(<VacancyFunnelView vacancyId="v1" vacancy={vacancy} />);
    expect(screen.queryByRole('button', { name: /Hacer match/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dispatchInvitesButtonCount/ })).not.toBeInTheDocument();
  });

  it('match:execute mostra só "Hacer match"; messaging:send mostra só os convites', () => {
    comEnforcement(['funnel:read', 'match:execute'], 'on');
    const { unmount } = render(<VacancyFunnelView vacancyId="v1" vacancy={vacancy} />);
    expect(screen.getByRole('button', { name: /Hacer match/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dispatchInvitesButtonCount/ })).not.toBeInTheDocument();
    unmount();

    comEnforcement(['funnel:read', 'messaging:send'], 'on');
    render(<VacancyFunnelView vacancyId="v1" vacancy={vacancy} />);
    expect(screen.queryByRole('button', { name: /Hacer match/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dispatchInvitesButtonCount/ })).toBeInTheDocument();
  });

  it('enforcement=off: os dois existem, como antes', () => {
    comEnforcement([], 'off');
    render(<VacancyFunnelView vacancyId="v1" vacancy={vacancy} />);
    expect(screen.getByRole('button', { name: /Hacer match/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dispatchInvitesButtonCount/ })).toBeInTheDocument();
  });
});
