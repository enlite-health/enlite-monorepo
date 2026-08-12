import { createPortal } from 'react-dom';
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  X,
  Ban,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { blockedReasonMessage } from '@infrastructure/http/AdminMessagingApiService';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import {
  useInviteProgressStore,
  type SendItem,
} from '@presentation/stores/inviteProgressStore';

/** Iniciais para o avatar (mesmo padrão dos cards de match). */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '—';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function StatusIcon({ status }: { status: SendItem['status'] }): JSX.Element {
  switch (status) {
    case 'sent':
      return <CheckCircle2 className="w-5 h-5 text-green-600" />;
    case 'error':
      return <AlertCircle className="w-5 h-5 text-red-500" />;
    case 'sending':
      return <Loader2 className="w-5 h-5 text-primary animate-spin" />;
    case 'cancelled':
      return <Ban className="w-5 h-5 text-gray-800" />;
    default:
      // pending — anel vazio (igual ao "aguardando" do Drive)
      return (
        <span className="w-5 h-5 rounded-full border-2 border-gray-600 inline-block" />
      );
  }
}

function InviteRow({ item }: { item: SendItem }): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <span className="w-8 h-8 shrink-0 rounded-full bg-primary text-white flex items-center justify-center">
        <Text as="span" size="xs" weight="semibold" color="white">
          {initials(item.workerName)}
        </Text>
      </span>
      <div className="min-w-0 flex-1">
        <Text size="sm" color="secondary" className="truncate">
          {item.workerName}
        </Text>
        {item.status === 'error' && (
          <Text as="span" size="xs" color="inherit" className="text-red-500 truncate block">
            {item.errorCode
              ? blockedReasonMessage(item.errorCode, item.errorDetail, t)
              : item.error ?? t('admin.messaging.statusErrorFallback')}
          </Text>
        )}
      </div>
      <StatusIcon status={item.status} />
    </div>
  );
}

/**
 * Painel flutuante de progresso de envio de convites — inspirado no card de
 * upload do Google Drive, adaptado ao design system Enlite. Fica no canto
 * inferior-direito, NÃO bloqueia o fluxo do operador: ele pode fechar o modal de
 * match e navegar entre telas enquanto os convites saem em background.
 *
 * Renderizado uma única vez no App (via portal), alimentado pelo
 * inviteProgressStore global.
 */
export function InviteProgressPanel(): JSX.Element | null {
  const { t } = useTranslation();
  const items = useInviteProgressStore((s) => s.items);
  const isOpen = useInviteProgressStore((s) => s.isOpen);
  const isSending = useInviteProgressStore((s) => s.isSending);
  const collapsed = useInviteProgressStore((s) => s.collapsed);
  const cancel = useInviteProgressStore((s) => s.cancel);
  const dismiss = useInviteProgressStore((s) => s.dismiss);
  const toggleCollapsed = useInviteProgressStore((s) => s.toggleCollapsed);

  if (!isOpen || items.length === 0) return null;
  if (typeof document === 'undefined') return null;

  const total = items.length;
  const sent = items.filter((i) => i.status === 'sent').length;
  const errors = items.filter((i) => i.status === 'error').length;
  const cancelled = items.filter((i) => i.status === 'cancelled').length;
  const processed = sent + errors + cancelled;
  const pct = total === 0 ? 0 : Math.round((processed / total) * 100);

  const title = isSending
    ? t('admin.messaging.panel.sending', { done: processed, total })
    : errors > 0
    ? t('admin.messaging.panel.doneWithErrors', { sent, errors })
    : cancelled > 0
    ? t('admin.messaging.panel.doneCancelled', { sent, cancelled })
    : t('admin.messaging.panel.done', { count: sent });

  return createPortal(
    <div
      role="status"
      aria-live="polite"
      data-testid="invite-progress-panel"
      className="fixed bottom-4 right-4 z-[90] w-full max-w-sm rounded-card shadow-large border border-gray-400 bg-white overflow-hidden"
    >
      {/* Header (barra escura, análoga ao Drive — na cor primary do Enlite) */}
      <div className="flex items-center gap-2 bg-primary px-4 py-3">
        <Text as="span" size="sm" weight="semibold" color="white" className="flex-1 truncate">
          {title}
        </Text>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={t(collapsed ? 'admin.messaging.panel.expand' : 'admin.messaging.panel.collapse')}
          className="text-white/80 hover:text-white transition-colors"
        >
          {collapsed ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
        </button>
        {!isSending && (
          <button
            type="button"
            onClick={dismiss}
            aria-label={t('common.close')}
            className="text-white/80 hover:text-white transition-colors"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {/* Barra de progresso */}
      <div className="h-1 bg-gray-400">
        <div
          className="h-full bg-primary transition-[width] duration-300"
          style={{ width: `${pct}%` }}
          data-testid="invite-progress-bar"
        />
      </div>

      {!collapsed && (
        <>
          <div className="max-h-72 overflow-y-auto divide-y divide-gray-400">
            {items.map((item) => (
              <InviteRow key={item.workerId} item={item} />
            ))}
          </div>

          {isSending && (
            <div className="flex items-center justify-end px-4 py-3 border-t border-gray-400">
              <Button variant="outline" size="sm" onClick={cancel}>
                {t('common.cancel')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>,
    document.body,
  );
}
