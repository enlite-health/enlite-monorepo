/**
 * 089 T030 — o botão único "Invitar prestadores" é gateado por `messaging:send` (⚑2) e SOME sem a
 * célula (ActionButton hide, só com enforcement=on), nas duas visões.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { VacancyFunnelView } from './VacancyFunnelView';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@hooks/admin/useVacancyFunnelTable', () => ({
  useVacancyFunnelTable: () => ({ data: { rows: [], counts: { INVITED: 0, POSTULATED: 0, PRE_SELECTED: 0, REJECTED: 0, WITHDREW: 0, ALL: 0, columns: {} } }, isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { getMatchResults: vi.fn().mockResolvedValue({ pendingInVacancyCount: 2 }) },
}));
vi.mock('./VacancyFunnelKanban', () => ({ VacancyFunnelKanban: () => <div /> }));
vi.mock('./VacancyFunnelTable', () => ({ VacancyFunnelTable: () => <div /> }));
vi.mock('./VacancyFunnelToggle', () => ({ VacancyFunnelToggle: () => <div /> }));

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}
const renderView = () => render(<MemoryRouter><VacancyFunnelView vacancyId="v1" /></MemoryRouter>);
const BTN = { name: /inviteEntry\.button/ };
const VIEW_KEY = 'vacancy-funnel-view-v2-v1';

// O Toggle é mockado (<div/>), então a visão é forçada pela chave v2.
describe.each(['kanban', 'list'] as const)('visão %s', (view) => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(VIEW_KEY, view);
  });

  describe('VacancyFunnelView — portão messaging:send', () => {
    it('enforcement=on sem messaging:send: o botão e as linhas SOMEM (match:execute sozinha não basta)', () => {
      comEnforcement(['funnel:read', 'match:execute'], 'on');
      renderView();
      expect(screen.queryByRole('button', BTN)).not.toBeInTheDocument();
      expect(screen.queryByTestId('invite-entry')).not.toBeInTheDocument();
    });

    it('enforcement=on com messaging:send: um botão visível', () => {
      comEnforcement(['funnel:read', 'messaging:send'], 'on');
      renderView();
      expect(screen.getAllByRole('button', BTN)).toHaveLength(1);
    });

    it('enforcement=off: o botão existe, como antes', () => {
      comEnforcement([], 'off');
      renderView();
      expect(screen.getByRole('button', BTN)).toBeInTheDocument();
    });
  });
});
