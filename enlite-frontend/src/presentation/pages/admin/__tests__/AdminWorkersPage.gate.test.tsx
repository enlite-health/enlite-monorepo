/**
 * D286 fase 2 — exportar (worker:export) e sincronizar Talentum (talentum:write) por CÉLULA:
 * papel não entra na conta. Com o engine desligado os dois botões aparecem, como sempre apareceram.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminWorkersPage } from '../AdminWorkersPage';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    syncTalentumWorkers: vi.fn(),
    listWorkers: vi.fn().mockResolvedValue({ data: [], total: 0 }),
    getWorkerDateStats: vi.fn().mockResolvedValue({ today: 0, yesterday: 0, sevenDaysAgo: 0 }),
    listWorkerTags: vi.fn().mockResolvedValue([]),
    getWorkerFilterOptions: vi.fn().mockResolvedValue({ states: [], cities: [], experienceTypes: [], preferredTypes: [] }),
    listCaseOptions: vi.fn().mockResolvedValue([]),
  },
}));
vi.mock('@hooks/admin/useWorkersData', () => ({
  useWorkersData: () => ({ workers: [], total: 0, stats: { today: 0, yesterday: 0, sevenDaysAgo: 0 }, isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock('@hooks/admin/useCaseOptions', () => ({ useCaseOptions: () => ({ options: [], isLoading: false }) }));
vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: () => ({ adminProfile: {}, isAuthenticated: true, isLoading: false }),
}));

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}
const renderPage = () => render(<MemoryRouter><AdminWorkersPage /></MemoryRouter>);
const botaoSync = () => screen.queryAllByRole('button').find((b) => b.textContent?.includes('admin.workers.syncTalentum'));

describe('AdminWorkersPage — exportar e sincronizar por célula (D286 fase 2)', () => {
  it('enforcement=on só com worker:read: nem exportar nem sincronizar', () => {
    comEnforcement(['worker:read'], 'on');
    renderPage();
    expect(screen.queryByTestId('worker-export-btn')).not.toBeInTheDocument();
    expect(botaoSync()).toBeUndefined();
  });

  it('worker:export mostra exportar; talentum:write mostra sincronizar', () => {
    comEnforcement(['worker:read', 'worker:export'], 'on');
    const { unmount } = renderPage();
    expect(screen.getByTestId('worker-export-btn')).toBeInTheDocument();
    expect(botaoSync()).toBeUndefined();
    unmount();

    comEnforcement(['worker:read', 'talentum:write'], 'on');
    renderPage();
    expect(screen.queryByTestId('worker-export-btn')).not.toBeInTheDocument();
    expect(botaoSync()).toBeDefined();
  });

  it('enforcement=off: os dois existem para o admin, como antes', () => {
    comEnforcement([], 'off');
    renderPage();
    expect(screen.getByTestId('worker-export-btn')).toBeInTheDocument();
    expect(botaoSync()).toBeDefined();
  });
});
