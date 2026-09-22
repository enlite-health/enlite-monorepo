/**
 * NotificationBell — sino de notificações (Spec 022, Bloco 4, T409/T410/D-13).
 *
 * Item 4 (change 022-ux-mencao-e-notificacao, F17/F18): movido para o 1º item da `AppSidebar`
 * (antes: imediatamente acima do bloco do usuário) — SEMPRE montado, expandido ou recolhido.
 * `isCollapsed` troca só a APARÊNCIA (ícone+badge sem rótulo vs. ícone+rótulo+badge); o polling
 * (`usePolling` abaixo) nunca depende disso — antes, `!isCollapsed && <NotificationBell />` em
 * `AppSidebar` desmontava o componente inteiro (e o poll junto) ao recolher; agora o componente
 * nunca desmonta por causa do collapse, só o `AppSidebar` decide QUANDO passar `isCollapsed`.
 * Badge de `unread-count` via `usePolling` (45s, pausa em aba oculta — D-10).
 *
 * 🔒 Achado do gate revisao-pr (B4, T409): `usePolling` recebe `immediate: true` — sem isto, o
 * badge ficava em 0 pelos primeiros 45s de CADA carga de página (`setInterval` nunca chama a
 * função de imediato), fazendo qualquer staff logado numa janela recente de menção/resposta achar
 * que não tinha notificação nenhuma. `immediate` é opt-in no hook (default `false`) — os OUTROS
 * 2 callers de `usePolling` (`ConversationPanel.tsx`/`PatientConversationHandle.tsx`) continuam
 * exatamente como antes.
 *
 * Ripple deste opt-in: as suítes de `AdminLayout`/`AppSidebar` (`AppSidebar.test.tsx`,
 * `AdminLayout*.test.tsx`), que montam este componente com timers REAIS e SEM mockar
 * `AdminNotificationApiService`, agora disparam 1 fetch real no mount — inofensivo (rejeita rápido,
 * capturado pelo `catch` best-effort de `refreshCount` abaixo, sem asserção nova quebrada;
 * confirmado rodando as 4 suítes depois deste conserto).
 *
 * Dono do `SlideOverPanel`/`NotificationPanel` — mesma decisão de integração de
 * `PatientConversationHandle` (T1 do B2): quem tem o handle visual é quem abre/fecha o painel.
 */
import { useCallback, useState } from 'react';
import { Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { usePolling } from '@hooks/usePolling';
import { AdminNotificationApiService } from '@infrastructure/http/AdminNotificationApiService';
import { SlideOverPanel } from '@presentation/components/molecules/SlideOverPanel/SlideOverPanel';
import { Text } from '@presentation/components/atoms/Text';
import { NotificationPanel } from './NotificationPanel';

/**
 * D-10: 45s em produção. `VITE_NOTIFICATION_POLL_MS` (T416) permite um e2e Playwright reduzir o
 * intervalo SÓ NA STACK DE TESTE — nunca muda o valor de produção (sem a env, cai no default).
 */
const POLL_MS = Number((import.meta as any).env?.VITE_NOTIFICATION_POLL_MS) || 45000;

export interface NotificationBellProps {
  /** Item 4: `true` = sidebar recolhida — variante compacta (ícone + badge, sem o rótulo de
   * texto), mas com `title` (tooltip nativo) mostrando o mesmo rótulo. Default `false`
   * (variante expandida: ícone + rótulo + badge, como qualquer item da sidebar). */
  isCollapsed?: boolean;
}

export function NotificationBell({ isCollapsed = false }: NotificationBellProps): JSX.Element {
  const { t } = useTranslation();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const label = t('admin.notifications.bellLabel');

  const refreshCount = useCallback(async () => {
    try {
      const count = await AdminNotificationApiService.getUnreadCount();
      setUnreadCount(count);
    } catch {
      // Best-effort — badge é indicador secundário, mesmo padrão de `PatientConversationHandle`.
    }
  }, []);

  usePolling(() => void refreshCount(), POLL_MS, { pauseWhenHidden: true, immediate: true });

  const handleOpen = (): void => setIsPanelOpen(true);
  const handleClose = (): void => setIsPanelOpen(false);

  return (
    <div className="border-b border-gray-100">
      <button
        type="button"
        data-testid="notification-bell-btn"
        aria-label={label}
        title={isCollapsed ? label : undefined}
        onClick={handleOpen}
        className={
          isCollapsed
            ? 'relative flex w-full items-center justify-center py-3 hover:bg-gray-50 transition-colors'
            : 'relative flex w-full items-center gap-3 px-4 py-2.5 hover:bg-gray-50 transition-colors'
        }
      >
        <span className="relative inline-flex w-5 h-5 flex-shrink-0">
          <Bell className="w-5 h-5 text-gray-600" />
          {unreadCount > 0 && (
            <span
              data-testid="notification-bell-badge"
              aria-label={t('admin.notifications.unread', { count: unreadCount })}
              className="inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-red-600 absolute -top-1.5 -right-1.5"
            >
              <span className="text-white text-[10px] font-semibold leading-none">{unreadCount}</span>
            </span>
          )}
        </span>
        {!isCollapsed && (
          <Text as="span" size="sm" weight="medium" className="flex-1 text-left" color="inherit">
            {label}
          </Text>
        )}
      </button>
      <SlideOverPanel
        isOpen={isPanelOpen}
        onClose={handleClose}
        ariaLabel={t('admin.notifications.panelTitle')}
        closeAriaLabel={t('admin.notifications.close')}
        testId="notification-panel"
        widthClassName="max-w-sm"
      >
        <NotificationPanel isOpen={isPanelOpen} onClose={handleClose} onNotificationsChanged={() => void refreshCount()} />
      </SlideOverPanel>
    </div>
  );
}
