/**
 * NotificationBell — sino de notificações (Spec 022, Bloco 4, T409/T410/D-13).
 *
 * Montado em `AppSidebar` (T411), IMEDIATAMENTE ACIMA do bloco do usuário. Badge de
 * `unread-count` via `usePolling` (45s, pausa em aba oculta — D-10).
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
import { NotificationPanel } from './NotificationPanel';

/**
 * D-10: 45s em produção. `VITE_NOTIFICATION_POLL_MS` (T416) permite um e2e Playwright reduzir o
 * intervalo SÓ NA STACK DE TESTE — nunca muda o valor de produção (sem a env, cai no default).
 */
const POLL_MS = Number((import.meta as any).env?.VITE_NOTIFICATION_POLL_MS) || 45000;

export function NotificationBell(): JSX.Element {
  const { t } = useTranslation();
  const [unreadCount, setUnreadCount] = useState(0);
  const [isPanelOpen, setIsPanelOpen] = useState(false);

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
    <div className="border-t border-gray-200 px-3 py-2">
      <button
        type="button"
        data-testid="notification-bell-btn"
        aria-label={t('admin.notifications.bellLabel')}
        onClick={handleOpen}
        className="relative flex items-center gap-2 w-full px-2 py-2 rounded-md hover:bg-gray-100 transition-colors"
      >
        <Bell className="w-5 h-5 text-gray-600" />
        {unreadCount > 0 && (
          <span
            data-testid="notification-bell-badge"
            aria-label={t('admin.notifications.unread', { count: unreadCount })}
            className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 absolute top-1 left-6"
          >
            <span className="text-white text-[10px] font-semibold leading-none">{unreadCount}</span>
          </span>
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
