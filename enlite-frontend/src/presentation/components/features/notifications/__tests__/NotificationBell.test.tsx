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

  it('poll pausa com a aba oculta (D-10) — mesmo mecanismo de usePolling', async () => {
    vi.mocked(AdminNotificationApiService.getUnreadCount).mockResolvedValue(1);
    render(<MemoryRouter><NotificationBell /></MemoryRouter>);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    });

    // Pausado: nenhuma chamada aconteceu além da que talvez já estivesse em voo.
    expect(AdminNotificationApiService.getUnreadCount).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('clique abre o NotificationPanel (SlideOverPanel translate-x-0)', async () => {
    render(<MemoryRouter><NotificationBell /></MemoryRouter>);
    const panel = screen.getByTestId('notification-panel');
    expect(panel.className).toContain('translate-x-full');

    fireEvent.click(screen.getByTestId('notification-bell-btn'));

    expect(panel.className).toContain('translate-x-0');
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
