/**
 * NotificationPanel — conteúdo do painel do sino (Spec 022, Bloco 4, T412/T413).
 *
 * Lista as notificações do requester, monta o texto no CLIENTE (`notificationText.ts`, FR-015),
 * marca como lida ao clicar E navega para `patients/:patientId` com um `DrawerFocusRequest
 * { code: 'conversation' }` (mesmo mecanismo de deep-link do checklist, `useAutoOpenDrawer`) —
 * `PatientConversationHandle` (T413) escuta esse código e abre o painel de conversa sozinho.
 *
 * Notificação sem `patientId` (defesa — hoje o backend sempre associa um paciente, mas o schema
 * permite `NULL`, D-08): marca como lida, mas NÃO navega — não há para onde ir.
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { AdminNotificationApiService, type AdminNotification } from '@infrastructure/http/AdminNotificationApiService';
import { buildNotificationText } from './notificationText';

interface NotificationPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Chamado depois de marcar 1 ou todas como lidas — o `NotificationBell` usa isto para
   * re-sincronizar o badge sem esperar o próximo poll de 45s. */
  onNotificationsChanged?: () => void;
}

export function NotificationPanel({ isOpen, onClose, onNotificationsChanged }: NotificationPanelProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<AdminNotification[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [markAllError, setMarkAllError] = useState(false);

  const fetchList = useCallback(async () => {
    setIsLoading(true);
    try {
      const list = await AdminNotificationApiService.listNotifications({ limit: 20 });
      setNotifications(list);
      setLoadError(false);
    } catch {
      // 🔒 Achado do gate revisao-pr (B4): um 403 (sem `own_notifications:read`) ou 500 caía aqui
      // e o estado ficava indistinguível de "0 notificações de verdade" — a operadora via
      // `notification-empty` nos dois casos, sem nunca saber que o painel estava QUEBRADO. Erro
      // agora tem estado PRÓPRIO, visível (i18n ES/PT) — nunca vira silêncio nem "vazio" falso.
      setLoadError(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    void fetchList();
  }, [isOpen, fetchList]);

  const handleClick = async (notification: AdminNotification): Promise<void> => {
    try {
      await AdminNotificationApiService.markNotificationRead(notification.id);
      onNotificationsChanged?.();
    } catch {
      // Best-effort: mesmo se o marcar-lida falhar, a navegação (se houver paciente) segue —
      // a operadora não pode ficar presa por um POST que falhou.
    }
    if (notification.patientId) {
      navigate(`/admin/patients/${notification.patientId}`, {
        state: { focusRequest: { code: 'conversation', token: Date.now() } },
      });
      onClose();
    }
  };

  const handleMarkAllRead = async (): Promise<void> => {
    try {
      await AdminNotificationApiService.markAllNotificationsRead();
      setMarkAllError(false);
      onNotificationsChanged?.();
      await fetchList();
    } catch {
      // 🔒 Achado do gate revisao-pr (B4): falha aqui (403/500) era engolida em silêncio — a
      // operadora clicava "marcar todas como lidas", nada acontecia na tela, e nada dizia por
      // quê. Erro visível (i18n ES/PT), mesma régua do `loadError` acima.
      setMarkAllError(true);
    }
  };

  return (
    <div className="flex flex-col h-full" data-testid="notification-panel-content">
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <Text as="span" size="base" weight="semibold">
          {t('admin.notifications.panelTitle')}
        </Text>
        <button
          type="button"
          data-testid="notification-mark-all-read"
          onClick={() => void handleMarkAllRead()}
          className="text-primary hover:underline"
        >
          <Text as="span" size="xs" weight="medium" color="inherit">
            {t('admin.notifications.markAllRead')}
          </Text>
        </button>
      </div>

      {markAllError && (
        <div data-testid="notification-mark-all-error" className="px-4 py-2 border-b border-gray-100">
          <Text as="span" size="xs" role="alert" className="text-red-600">
            {t('admin.notifications.markAllReadError')}
          </Text>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {loadError && (
          <div data-testid="notification-load-error" className="px-4 py-8 text-center">
            <Text as="span" size="sm" role="alert" className="text-red-600">
              {t('admin.notifications.loadError')}
            </Text>
          </div>
        )}
        {!loadError && !isLoading && notifications.length === 0 && (
          <div data-testid="notification-empty" className="px-4 py-8 text-center">
            <Text as="span" size="sm" color="secondary">
              {t('admin.notifications.empty')}
            </Text>
          </div>
        )}
        {!loadError && notifications.map((n) => (
          <button
            key={n.id}
            type="button"
            data-testid={`notification-item-${n.id}`}
            onClick={() => void handleClick(n)}
            className={`w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
              n.readAt ? 'opacity-60' : ''
            }`}
          >
            <Text as="span" size="sm">
              {buildNotificationText(n, t)}
            </Text>
          </button>
        ))}
      </div>
    </div>
  );
}
