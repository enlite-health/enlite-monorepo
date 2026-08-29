/**
 * AdminWorkersPage.presentation.test.tsx — o convite à reunión de presentación na LISTA (REQ-09/REQ-04):
 * botão por linha; clique → serviço com origem 'workers_list'; queued/skipped/error refletidos na linha.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, f?: string) => (typeof f === 'string' ? f : k), i18n: { language: 'es' } }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@presentation/hooks/useAdminAuth', () => ({ useAdminAuth: () => ({ adminProfile: { role: 'admin' }, isAuthenticated: true, isLoading: false }) }));
vi.mock('@hooks/admin/useCaseOptions', () => ({ useCaseOptions: () => ({ options: [], isLoading: false }) }));
vi.mock('@hooks/admin/useWorkersData', () => ({
  useWorkersData: () => ({
    workers: [
      { id: 'w-ok', name: 'Ok', email: 'ok@x', casesCount: 0, documentsComplete: false, documentsStatus: 'pending', platform: '', createdAt: '2026-08-29T00:00:00Z' },
      { id: 'w-skip', name: 'Skip', email: 'skip@x', casesCount: 0, documentsComplete: false, documentsStatus: 'pending', platform: '', createdAt: '2026-08-29T00:00:00Z' },
      { id: 'w-err', name: 'Err', email: 'err@x', casesCount: 0, documentsComplete: false, documentsStatus: 'pending', platform: '', createdAt: '2026-08-29T00:00:00Z' },
    ],
    total: 3, stats: null, isLoading: false, error: null, refetch: vi.fn(),
  }),
}));
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: new Proxy({}, { get: () => vi.fn().mockResolvedValue([]) }),
}));
vi.mock('@presentation/components/features/admin/WorkerFilters', () => ({ WorkerFilters: () => null }));
vi.mock('@presentation/components/features/admin/WorkerStatsCards', () => ({ WorkerStatsCards: () => null }));
vi.mock('@presentation/components/features/admin/WorkerExport/WorkerExportModal', () => ({ WorkerExportModal: () => null }));
const invite = vi.fn();
vi.mock('@infrastructure/http/AdminPresentationInviteApiService', () => ({
  AdminPresentationInviteApiService: { invite: (...a: unknown[]) => invite(...a) },
}));

import { AdminWorkersPage } from '../AdminWorkersPage';

const rowOf = (name: string) => screen.getByText(name).closest('tr')!;

describe('AdminWorkersPage — convite à reunión de presentación por linha', () => {
  beforeEach(() => { invite.mockReset(); });

  it('cada linha tem o botão; clique → invite(id, "workers_list"); queued / skipped / erro aparecem na linha', async () => {
    invite.mockImplementation(async (id: string) =>
      id === 'w-ok' ? { status: 'queued', outboxId: 'o1' } : id === 'w-skip' ? { status: 'skipped', skipReason: 'SIN_VINCULO' } : Promise.reject(new Error('boom')));
    render(<AdminWorkersPage />);
    await waitFor(() => expect(screen.getAllByTestId('presentation-invite-button')).toHaveLength(3));
    for (const n of ['Ok', 'Skip', 'Err']) fireEvent.click(rowOf(n).querySelector('[data-testid="presentation-invite-button"]')!);
    expect(invite).toHaveBeenCalledWith('w-ok', 'workers_list');
    await waitFor(() => expect(rowOf('Ok').querySelector('[data-testid="presentation-invite-feedback"]')).toHaveTextContent('admin.presentationInvite.queued'));
    expect(rowOf('Ok').querySelector('[data-testid="presentation-invite-last"]')).toHaveTextContent('admin.presentationInvite.lastAt');
    await waitFor(() => expect(rowOf('Skip').querySelector('[data-testid="presentation-invite-feedback"]')).toHaveTextContent('SIN_VINCULO'));
    await waitFor(() => expect(rowOf('Err').querySelector('[data-testid="presentation-invite-feedback"]')).toHaveTextContent('boom'));
  });

  it('erro não-Error cai no texto padrão', async () => {
    invite.mockRejectedValue('x');
    render(<AdminWorkersPage />);
    await waitFor(() => expect(screen.getAllByTestId('presentation-invite-button').length).toBeGreaterThan(0));
    fireEvent.click(rowOf('Ok').querySelector('[data-testid="presentation-invite-button"]')!);
    await waitFor(() => expect(rowOf('Ok').querySelector('[data-testid="presentation-invite-feedback"]')).toHaveTextContent('admin.presentationInvite.error'));
  });
});
