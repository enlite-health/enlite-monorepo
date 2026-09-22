/**
 * NotificationBell — TDD (spec 022, Bloco 4, T409/T410).
 *
 * Molde: `PatientConversationHandle.test.tsx` (poll com fake timers, `AdminNotificationApiService`
 * mockado por módulo). Badge de `unread-count` via `usePolling` (45s, pausa em aba oculta),
 * clique abre `NotificationPanel`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminNotificationApiService } from '@infrastructure/http/AdminNotificationApiService';
import { NotificationBell } from '../NotificationBell';

vi.mock('@infrastructure/http/AdminNotificationApiService', () => ({
  AdminNotificationApiService: {
    getUnreadCount: vi.fn(),
    listNotifications: vi.fn().mockResolvedValue([]),
    markNotificationRead: vi.fn().mockResolvedValue(undefined),
    markAllNotificationsRead: vi.fn().mockResolvedValue(0),
  },
}));

const POLL_MS = 45000; // D-10

describe('NotificationBell (spec 022, T409/T410)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(AdminNotificationApiService.getUnreadCount).mockResolvedValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('sem não lidas: sino aparece sem badge', () => {
    render(<MemoryRouter><NotificationBell /></MemoryRouter>);
    expect(screen.getByTestId('notification-bell-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('notification-bell-badge')).not.toBeInTheDocument();
  });

  it('badge mostra o unread-count do servidor após o 1º poll (45s)', async () => {
    vi.mocked(AdminNotificationApiService.getUnreadCount).mockResolvedValue(3);
    render(<MemoryRouter><NotificationBell /></MemoryRouter>);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('3');
  });

  it('🔒 achado do gate revisao-pr (B4, T409): badge mostra o unread-count JÁ NO MONTE — sem esperar os 45s do 1º poll (usePolling immediate:true)', async () => {
    vi.mocked(AdminNotificationApiService.getUnreadCount).mockResolvedValue(2);
    render(<MemoryRouter><NotificationBell /></MemoryRouter>);

    // Só libera as microtasks da chamada JÁ EM VOO desde o monte — nenhum timer avançado.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(AdminNotificationApiService.getUnreadCount).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('2');
  });

  it('poll pausa com a aba oculta (D-10) — mesmo mecanismo de usePolling', async () => {
    vi.mocked(AdminNotificationApiService.getUnreadCount).mockResolvedValue(1);
    render(<MemoryRouter><NotificationBell /></MemoryRouter>);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });

    // Só a chamada IMEDIATA do monte conta — pausado, o intervalo nunca disparou de novo.
    expect(AdminNotificationApiService.getUnreadCount).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('clique abre o NotificationPanel (SlideOverPanel translate-x-0)', async () => {
    render(<MemoryRouter><NotificationBell /></MemoryRouter>);
    const panel = screen.getByTestId('notification-panel');
    expect(panel.className).toContain('translate-x-full');

    fireEvent.click(screen.getByTestId('notification-bell-btn'));

    expect(panel.className).toContain('translate-x-0');
  });

  describe('item 4 (change 022-ux-mencao-e-notificacao) — variante collapsed', () => {
    const LABEL_KEY = 'admin.notifications.bellLabel'; // t() cru neste arquivo (sem i18n real)

    it('expandida (default): mostra o rótulo de texto ao lado do ícone', () => {
      render(<MemoryRouter><NotificationBell /></MemoryRouter>);
      expect(screen.getByText(LABEL_KEY)).toBeInTheDocument();
    });

    it('collapsed: NÃO mostra o rótulo de texto, mas o botão (ícone) continua acessível com title/aria-label', () => {
      render(<MemoryRouter><NotificationBell isCollapsed /></MemoryRouter>);
      expect(screen.queryByText(LABEL_KEY)).not.toBeInTheDocument();
      const btn = screen.getByTestId('notification-bell-btn');
      expect(btn).toHaveAttribute('aria-label', LABEL_KEY);
      expect(btn).toHaveAttribute('title', LABEL_KEY);
    });

    it('collapsed: badge de contagem continua funcionando (poll não depende do modo visual)', async () => {
      vi.mocked(AdminNotificationApiService.getUnreadCount).mockResolvedValue(5);
      render(<MemoryRouter><NotificationBell isCollapsed /></MemoryRouter>);

      await act(async () => { await vi.advanceTimersByTimeAsync(0); });

      expect(screen.getByTestId('notification-bell-badge')).toHaveTextContent('5');
    });
  });

  it('falha silenciosa no poll: não quebra, badge continua ausente', async () => {
    vi.mocked(AdminNotificationApiService.getUnreadCount).mockRejectedValue(new Error('network'));
    render(<MemoryRouter><NotificationBell /></MemoryRouter>);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS);
    });

    expect(screen.getByTestId('notification-bell-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('notification-bell-badge')).not.toBeInTheDocument();
  });
});
