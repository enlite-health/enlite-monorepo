/**
 * NotificationCard — card de UMA notificação (item 2, change 022-ux-mencao-e-notificacao;
 * `design.md` §2). Substitui o item de lista antigo do `NotificationPanel`.
 *
 * 🔒 DEFEITO 2 (decisão do orquestrador, Rodada 2/R2-F, medido em prd 21-22/09) — 3 LINHAS, cada
 * uma um elemento PRÓPRIO (nunca compartilhando nó nem limite de truncamento):
 *   1. avatar + autor (trunca) + data (NUNCA encolhe, `flex-shrink-0`) — antes, autor+verbo+
 *      paciente viviam NUM SÓ texto truncado; um paciente com nome comprido sumia por trás do
 *      `truncate` da frase inteira, e ninguém sabia de qual paciente era a notificação.
 *   2. "en <paciente>"/"em <paciente>" — elemento PRÓPRIO, com o SEU PRÓPRIO `truncate`: o nome
 *      do paciente fica visível até a largura disponível DESTA linha, nunca competindo por
 *      espaço com a data da linha 1.
 *   3. trecho — `line-clamp-2` (não mais 1 linha só): a citação da mensagem original ganha 2
 *      linhas antes de cortar, em vez de sumir no meio da primeira palavra longa.
 *
 * A frase COMPLETA (FR-015, `buildNotificationText`) continua existindo — como `aria-label` do
 * card inteiro, para quem usa leitor de tela ouvir a notificação por extenso, exatamente como o
 * contrato manda (o servidor nunca monta a frase; o cliente monta e não perde a informação, só
 * reorganiza onde ela aparece NA TELA).
 *
 * Reuso, zero duplicação: `MessageAvatar` (mesmo componente do card de mensagem do chat) para o
 * avatar; `buildNotificationText` (FR-015) para o `aria-label`; `formatMessageDateTime` (mesmo
 * formato do card de mensagem) para a data.
 *
 * `messageExcerpt: null` (sem célula `patient_conversation:read`, ou falha de decifra isolada,
 * F7/F8 de `fatos-medidos.md`) — o card renderiza normalmente, só SEM a linha 3 (nunca um espaço
 * vazio, nunca um crash).
 *
 * Ponto de não lida (achado do gate A9, preservado): distinção lido/não-lido é só de FUNDO
 * (`bg-gray-200`) + marcador próprio (ponto) + peso de fonte do AUTOR — texto sempre 100% opaco,
 * nunca via `opacity-*` no elemento inteiro.
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
  const patientName = notification.patientDisplayName ?? t('admin.notifications.unknownPatient');

  return (
    <button
      type="button"
      data-testid={`notification-item-${notification.id}`}
      onClick={onClick}
      // `aria-label` carrega a frase INTEIRA (FR-015) — a tela reorganiza em 3 linhas, mas quem
      // usa leitor de tela continua ouvindo a notificação completa, de uma vez.
      aria-label={buildNotificationText(notification, t)}
      // Mesma régua de contraste do gate A9: a distinção lido/não-lido é só de FUNDO
      // (`bg-gray-200`) + marcador próprio (ponto) — texto sempre 100% opaco, nunca via
      // `opacity-*` no elemento inteiro.
      className={`w-full flex flex-col gap-1 text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors ${
        notification.readAt ? 'bg-gray-200' : ''
      }`}
    >
      {/* Linha 1: avatar + autor (trunca) + data (NUNCA encolhe). */}
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
          {authorName}
        </Text>
        <Text as="span" size="xs" className="ml-auto flex-shrink-0 whitespace-nowrap">
          {dateLabel}
        </Text>
      </div>

      {/* Linha 2: "en/em <paciente>" — elemento PRÓPRIO, trunca por conta própria (nunca some
          atrás do truncamento da linha 1, nunca disputa espaço com a data). */}
      <Text
        as="p"
        size="xs"
        color="secondary"
        data-testid={`notification-patient-${notification.id}`}
        className="pl-9 truncate"
      >
        {t('admin.notifications.inPatient', { patient: patientName })}
      </Text>

      {/* Linha 3: trecho — até 2 linhas antes de cortar (nunca 1 linha só). */}
      {notification.messageExcerpt && (
        <Text
          as="p"
          size="xs"
          color="secondary"
          data-testid={`notification-excerpt-${notification.id}`}
          className="pl-9 line-clamp-2"
        >
          {notification.messageExcerpt}
        </Text>
      )}
    </button>
  );
}
