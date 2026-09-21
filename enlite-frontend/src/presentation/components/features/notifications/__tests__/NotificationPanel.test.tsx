/**
 * NotificationPanel — TDD (spec 022, Bloco 4, T412/T413).
 *
 * Cobre: lista notificações (texto montado no CLIENTE, FR-015), clique marca lida E navega para
 * `patients/:patientId` com `DrawerFocusRequest { code: 'conversation' }` (deep-link, T413),
 * botão "marcar todas como lidas".
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { AdminNotificationApiService, type AdminNotification } from '@infrastructure/http/AdminNotificationApiService';
import { NotificationPanel } from '../NotificationPanel';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

// Molde: `sex-both-i18n.test.tsx` — re-inicializa com os recursos REAIS (o setup global usa
// `resources: {}`) para provar que `admin.notifications.mentioned/replied` interpolam a frase
// EXATA do contrato (`contracts/openapi-notifications.md` §Texto da notificação, FR-015),
// nunca a chave crua.
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

vi.mock('@infrastructure/http/AdminNotificationApiService', () => ({
  AdminNotificationApiService: {
    listNotifications: vi.fn(),
    getUnreadCount: vi.fn().mockResolvedValue(0),
    markNotificationRead: vi.fn().mockResolvedValue(undefined),
    markAllNotificationsRead: vi.fn().mockResolvedValue(0),
  },
}));

function notif(overrides: Partial<AdminNotification> = {}): AdminNotification {
  return {
    id: 'n1',
    typeCode: 'CONVERSATION_MENTIONED',
    actorUid: 'staff-a',
    actorDisplayName: 'Ana Staff',
    patientId: 'p1',
    patientDisplayName: 'Fulano Paciente',
    conversationId: 'c1',
    messageId: 'm1',
    createdAt: '2026-09-21T10:00:00.000Z',
    readAt: null,
    ...overrides,
  };
}

describe('NotificationPanel (spec 022, T412/T413)', () => {
  beforeEach(() => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([]);
  });

  afterEach(() => { vi.clearAllMocks(); });

  it('painel aberto: busca e lista as notificações, texto montado no cliente', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([notif()]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Ana Staff mencionó a vos en Fulano Paciente')).toBeInTheDocument();
    });
  });

  it('patientDisplayName null (D-13, ator perdeu a célula): cai no fallback "un paciente"', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([
      notif({ patientDisplayName: null, typeCode: 'CONVERSATION_REPLIED' }),
    ]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Ana Staff respondió en la conversación de un paciente')).toBeInTheDocument();
    });
  });

  it('clique numa notificação: marca lida E navega para patients/:patientId com DrawerFocusRequest code=conversation', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([notif({ id: 'n1', patientId: 'p42' })]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    const item = await screen.findByTestId('notification-item-n1');
    fireEvent.click(item);

    await waitFor(() => {
      expect(AdminNotificationApiService.markNotificationRead).toHaveBeenCalledWith('n1');
    });
    expect(navigate).toHaveBeenCalledWith(
      '/admin/patients/p42',
      expect.objectContaining({
        state: { focusRequest: expect.objectContaining({ code: 'conversation' }) },
      }),
    );
  });

  it('notificação sem patientId (edge case): clique marca lida mas NÃO navega', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications).mockResolvedValue([notif({ id: 'n1', patientId: null })]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    const item = await screen.findByTestId('notification-item-n1');
    fireEvent.click(item);

    await waitFor(() => {
      expect(AdminNotificationApiService.markNotificationRead).toHaveBeenCalledWith('n1');
    });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('botão "marcar todas como lidas" chama a API e re-busca a lista', async () => {
    vi.mocked(AdminNotificationApiService.listNotifications)
      .mockResolvedValueOnce([notif({ id: 'n1' }), notif({ id: 'n2' })])
      .mockResolvedValueOnce([]);
    render(<NotificationPanel isOpen onClose={vi.fn()} />);

    await screen.findByTestId('notification-item-n1');
    fireEvent.click(screen.getByTestId('notification-mark-all-read'));

    await waitFor(() => {
      expect(AdminNotificationApiService.markAllNotificationsRead).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.queryByTestId('notification-item-n1')).not.toBeInTheDocument();
    });
  });

  it('lista vazia: mostra o estado vazio, sem quebrar', async () => {
    render(<NotificationPanel isOpen onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('notification-empty')).toBeInTheDocument();
    });
  });

  it('fechado (isOpen=false): não busca a lista', () => {
    render(<NotificationPanel isOpen={false} onClose={vi.fn()} />);
    expect(AdminNotificationApiService.listNotifications).not.toHaveBeenCalled();
  });
});
