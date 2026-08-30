/**
 * PresentationInvitePage.test.tsx — config da reunión de presentación (REQ-09):
 * carga, admin salva (corpo), recruiter só lê, erros, contadores.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PresentationInvitePage } from '../PresentationInvitePage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string | Record<string, unknown>) => (typeof fallback === 'string' ? fallback : key) }),
}));
const mockGet = vi.fn(); const mockPut = vi.fn(); const mockStats = vi.fn();
vi.mock('@infrastructure/http/AdminPresentationInviteApiService', () => ({
  AdminPresentationInviteApiService: { getSettings: (...a: unknown[]) => mockGet(...a), updateSettings: (...a: unknown[]) => mockPut(...a), stats: (...a: unknown[]) => mockStats(...a) },
}));
let role = 'admin';
vi.mock('@presentation/hooks/useAdminAuth', () => ({ useAdminAuth: () => ({ adminProfile: { role }, isAuthenticated: true, isLoading: false }) }));

const MEET = 'https://meet.google.com/abc-defg-hij';
const settings = () => ({
  country: 'AR', templateSlug: null, meetLink: null, scheduleLabel: null, enabled: false, updatedBy: null, updatedAt: null,
  templates: [
    { slug: 'ar_presentacion_invite', name: 'p', category: 'UTILITY', eligible: false, reason: 'INACTIVE', placeholders: ['meet_link'], unsupported: [] },
    { slug: 'ok', name: 'o', category: 'UTILITY', eligible: true, reason: null, placeholders: ['meet_link'], unsupported: [] },
    { slug: 'mkt', name: 'm', category: 'MARKETING', eligible: false, reason: 'CATEGORY', placeholders: [], unsupported: [] },
  ],
});
const stats = () => ({ windowDays: 30, rows: [{ status: 'queued', skipReason: null, source: 'kanban', count: 2 }, { status: 'queued', skipReason: null, source: 'workers_list', count: 1 }, { status: 'skipped', skipReason: 'OPT_OUT', source: 'kanban', count: 4 }], attended: 0 });

describe('PresentationInvitePage', () => {
  beforeEach(() => { vi.clearAllMocks(); role = 'admin'; mockGet.mockResolvedValue(settings()); mockStats.mockResolvedValue(stats()); mockPut.mockResolvedValue({}); });

  it('carrega config + contadores; template inativo é escolhível, MARKETING não; "ativa" só com template+link', async () => {
    render(<PresentationInvitePage />);
    await waitFor(() => expect(screen.getByTestId('pi-form')).toBeInTheDocument());
    const sel = screen.getByTestId('pi-template') as HTMLSelectElement;
    const opts = Array.from(sel.options);
    expect(opts.find((o) => o.value === 'ar_presentacion_invite')?.disabled).toBe(false);
    expect(opts.find((o) => o.value === 'ar_presentacion_invite')?.textContent).toContain('ineligible.INACTIVE');
    expect(opts.find((o) => o.value === 'mkt')?.disabled).toBe(true);
    expect((screen.getByTestId('pi-enabled') as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId('pi-stat-queued')).toHaveTextContent('3');
    expect(screen.getByTestId('pi-stat-skipped')).toHaveTextContent('4');
    expect(screen.getByTestId('pi-stat-attended')).toHaveTextContent('0');
    expect(screen.getByTestId('pi-last-edit')).toHaveTextContent('—');
    expect(screen.queryByTestId('pi-admin-only')).toBeNull();
  });

  it('admin: preenche link, horário, template, liga e salva → PUT com o corpo certo → "salvo" e recarrega', async () => {
    render(<PresentationInvitePage />);
    await waitFor(() => expect(screen.getByTestId('pi-form')).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('pi-meet-link'), { target: { value: MEET } });
    fireEvent.change(screen.getByTestId('pi-schedule-label'), { target: { value: 'Martes 18:00' } });
    fireEvent.change(screen.getByTestId('pi-template'), { target: { value: 'ok' } });
    const enabled = screen.getByTestId('pi-enabled') as HTMLInputElement;
    expect(enabled.disabled).toBe(false);
    fireEvent.click(enabled);
    mockGet.mockResolvedValueOnce({ ...settings(), templateSlug: 'ok', meetLink: MEET, enabled: true, updatedAt: '2026-08-29T12:00:00Z', updatedBy: 'Gabi' });
    fireEvent.click(screen.getByTestId('pi-save'));
    await waitFor(() => expect(mockPut).toHaveBeenCalledWith({ templateSlug: 'ok', meetLink: MEET, scheduleLabel: 'Martes 18:00', enabled: true }));
    await waitFor(() => expect(screen.getByTestId('pi-saved')).toBeInTheDocument());
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('pi-last-edit')).toHaveTextContent('Gabi');
    // limpar o template desliga
    fireEvent.change(screen.getByTestId('pi-template'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('pi-save'));
    await waitFor(() => expect(mockPut).toHaveBeenLastCalledWith({ templateSlug: null, meetLink: MEET, scheduleLabel: null, enabled: false })); // o reload trouxe scheduleLabel null
  });

  it('erro ao salvar (Error e não-Error) fica na tela', async () => {
    mockPut.mockRejectedValueOnce(new Error('Template not eligible'));
    render(<PresentationInvitePage />);
    await waitFor(() => expect(screen.getByTestId('pi-form')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('pi-save'));
    await waitFor(() => expect(screen.getByTestId('pi-error')).toHaveTextContent('Template not eligible'));
    mockPut.mockRejectedValueOnce('x');
    fireEvent.click(screen.getByTestId('pi-save'));
    await waitFor(() => expect(screen.getByTestId('pi-error')).toHaveTextContent('admin.presentationInvite.error'));
  });

  it('recruiter: só lê — inputs desabilitados, sem salvar, aviso visível', async () => {
    role = 'recruiter';
    render(<PresentationInvitePage />);
    await waitFor(() => expect(screen.getByTestId('pi-form')).toBeInTheDocument());
    expect(screen.getByTestId('pi-admin-only')).toBeInTheDocument();
    expect((screen.getByTestId('pi-meet-link') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('pi-save')).toBeNull();
  });

  it('falha ao carregar (Error e não-Error) mostra o erro', async () => {
    mockGet.mockRejectedValueOnce(new Error('boom'));
    render(<PresentationInvitePage />);
    await waitFor(() => expect(screen.getByTestId('pi-load-error')).toHaveTextContent('boom'));
    mockStats.mockRejectedValueOnce('x');
    render(<PresentationInvitePage />);
    await waitFor(() => expect(screen.getAllByTestId('pi-load-error').length).toBeGreaterThan(0));
  });
});
