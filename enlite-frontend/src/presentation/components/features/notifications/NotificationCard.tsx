/**
 * NotificationCard — card de UMA notificação (item 2, change 022-ux-mencao-e-notificacao;
 * `design.md` §2, spec ADDED "Card de notificação mostra avatar, nome do autor, paciente, data e
 * trecho"). Substitui o item de lista antigo do `NotificationPanel`.
 *
 * Reuso, zero duplicação: `MessageAvatar` (mesmo componente do card de mensagem do chat,
 * `getInitials` por dentro) para o avatar; `buildNotificationText` (já existia, FR-015 — o
 * servidor nunca monta a frase) continua sendo a linha principal (nome do autor + nome do
 * paciente, interpolados); `formatMessageDateTime` (mesmo formato do card de mensagem) para a
 * data. O ÚNICO elemento genuinamente NOVO é a linha de trecho (`messageExcerpt`).
 *
 * `messageExcerpt: null` (sem célula `patient_conversation:read`, ou falha de decifra isolada,
 * F7/F8 de `fatos-medidos.md`) — o card renderiza normalmente, só SEM a linha de trecho (nunca um
 * espaço vazio, nunca um crash).
 */
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { AdminNotification } from '@infrastructure/http/AdminNotificationApiService';
import { MessageAvatar } from '@presentation/components/features/admin/PatientDetail/conversation/MessageAvatar';
import { formatMessageDateTime } from '@presentation/components/features/admin/PatientDetail/conversation/messageDateFormat';
import { buildNotificationText } from './notificationText';

export interface NotificationCardProps {
  notification: AdminNotification;
  onClick: () => void;
}

export function NotificationCard({ notification, onClick }: NotificationCardProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const connector = t(
    'admin.patients.detail.conversation.thread.dateConnector',
    i18n.language.toLowerCase().startsWith('pt') ? 'às' : 'a las',
  );
  const dateLabel = formatMessageDateTime(notification.createdAt, i18n.language, connector);
  const authorName = notification.actorDisplayName ?? notification.actorUid;

  return (
    <button
      type="button"
      data-testid={`notification-item-${notification.id}`}
      onClick={onClick}
      // 🔒 Mesma régua de contraste do gate A9 (`NotificationPanel`, achado 21/09): a distinção
      // lido/não-lido é só de FUNDO (`bg-gray-200`) + marcador próprio (ponto) — texto sempre
      // 100% opaco, nunca via `opacity-*` no elemento inteiro.
      className={`w-full flex flex-col gap-1.5 text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
        notification.readAt ? 'bg-gray-200' : ''
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <MessageAvatar uid={notification.actorUid} name={authorName} size={28} />
        {!notification.readAt && (
          <span
            data-testid={`notification-unread-dot-${notification.id}`}
            role="img"
            aria-label={t('admin.notifications.unreadItem')}
            className="w-2 h-2 rounded-full bg-primary flex-shrink-0"
          />
        )}
        <Text
          as="span"
          size="sm"
          weight={notification.readAt ? 'normal' : 'semibold'}
          className="truncate min-w-0"
        >
          {buildNotificationText(notification, t)}
        </Text>
        <Text as="span" size="xs" className="ml-auto flex-shrink-0 whitespace-nowrap">
          {dateLabel}
        </Text>
      </div>
      {notification.messageExcerpt && (
        <Text
          as="p"
          size="xs"
          color="secondary"
          data-testid={`notification-excerpt-${notification.id}`}
          className="pl-9 truncate"
        >
          {notification.messageExcerpt}
        </Text>
      )}
    </button>
  );
}
