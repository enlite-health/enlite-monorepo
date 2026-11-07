import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { InviteEntryButton } from './InviteEntryButton';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) => (opts?.count !== undefined ? `${key}:${opts.count}` : key),
  }),
}));
const mockGet = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: { getMatchResults: (...a: unknown[]) => mockGet(...a) },
}));

function Where() {
  const loc = useLocation();
  return <div data-testid="where" data-path={loc.pathname} data-from={(loc.state as { from?: string } | null)?.from ?? ''} />;
}
const renderAt = (url = '/admin/vacancies/v1?tab=encuadres') =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/admin/vacancies/:id" element={<InviteEntryButton vacancyId="v1" />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  localStorage.clear();
  mockGet.mockReset();
  useAdminAuthStore.setState({ authzStatus: 'ready', authz: null });
});

describe('InviteEntryButton (089 T030 — F0)', () => {
  it('contador 3: bolinha com 3, 1ª linha e 2ª linha; o GET é só a meta (limit=0)', async () => {
    mockGet.mockResolvedValue({ pendingInVacancyCount: 3 });
    renderAt();
    expect(await screen.findByTestId('invite-entry-count')).toHaveTextContent('3');
    expect(screen.getByTestId('invite-entry-pending-line')).toHaveTextContent('inviteEntry.pending:3');
    expect(screen.getByText('admin.vacancyDetail.funnelView.inviteEntry.optional')).toBeInTheDocument();
    expect(mockGet).toHaveBeenCalledWith('v1', 0);
  });

  it('contador 0: sem bolinha e sem a 1ª linha; a 2ª linha fica', async () => {
    mockGet.mockResolvedValue({ pendingInVacancyCount: 0 });
    renderAt();
    await vi.waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.queryByTestId('invite-entry-count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('invite-entry-pending-line')).not.toBeInTheDocument();
    expect(screen.getByText('admin.vacancyDetail.funnelView.inviteEntry.optional')).toBeInTheDocument();
  });

  it('falha do GET: sem bolinha, o botão segue', async () => {
    mockGet.mockRejectedValue(new Error('500'));
    renderAt();
    await vi.waitFor(() => expect(mockGet).toHaveBeenCalled());
    expect(screen.queryByTestId('invite-entry-count')).not.toBeInTheDocument();
    expect(screen.getByTestId('invite-entry-button')).toBeInTheDocument();
  });

  it('clique navega para /admin/vacancies/:id/match com state.from = pathname + search (DF-13)', async () => {
    mockGet.mockResolvedValue({ pendingInVacancyCount: 1 });
    renderAt('/admin/vacancies/v1?tab=encuadres');
    await userEvent.click(screen.getByTestId('invite-entry-button'));
    const where = await screen.findByTestId('where');
    expect(where).toHaveAttribute('data-path', '/admin/vacancies/v1/match');
    expect(where).toHaveAttribute('data-from', '/admin/vacancies/v1?tab=encuadres');
  });

  it('sem messaging:send (enforcement on): nada é renderizado nem pedido ao servidor', () => {
    useAdminAuthStore.setState({
      authzStatus: 'ready',
      authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions: ['match:execute'], countries: [], groups: [], features: {}, enforcement: 'on' } as AuthzContract,
    });
    renderAt();
    expect(screen.queryByTestId('invite-entry')).not.toBeInTheDocument();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('o número do contador usa #180149 sobre branco com borda #F227AF (⚑8)', async () => {
    mockGet.mockResolvedValue({ pendingInVacancyCount: 3 });
    renderAt();
    const pill = await screen.findByTestId('invite-entry-count');
    expect(pill.className).toContain('bg-white');
    expect(pill.className).toContain('text-primary');
    expect(pill.className).toContain('border-[#F227AF]');
  });

  it('o aviso temporário aparece abaixo do botão (⚑1)', async () => {
    mockGet.mockResolvedValue({ pendingInVacancyCount: 0 });
    renderAt();
    expect(await screen.findByTestId('invite-merge-notice')).toBeInTheDocument();
  });
});
