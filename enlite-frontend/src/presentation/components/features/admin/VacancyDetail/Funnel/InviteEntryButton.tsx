import { useEffect, useRef } from 'react';
import { Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { ActionButton } from '@presentation/components/features/access';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { useInviteProgressStore } from '@presentation/stores/inviteProgressStore';
import { useVacancyPendingInviteCount } from '@hooks/admin/useVacancyPendingInviteCount';
import { InviteMergeNotice } from './InviteMergeNotice';

interface Props {
  vacancyId: string;
}

/**
 * F0 (089 T030): entrada única da vacante para a página "Invitar prestadores". Substitui
 * os dois botões antigos (match e envio em massa). Visível com `messaging:send` (⚑2).
 */
export function InviteEntryButton({ vacancyId }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const { allowed } = useActionGate('messaging', 'send');
  const { count, refetch } = useVacancyPendingInviteCount(vacancyId, allowed);
  const isSending = useInviteProgressStore((s) => s.isSending);

  // Ao terminar um lote (isSending true → false) o contador relê o servidor.
  const wasSending = useRef(false);
  useEffect(() => {
    if (wasSending.current && !isSending) void refetch();
    wasSending.current = isSending;
  }, [isSending, refetch]);

  if (!allowed) return null;

  const label = t('admin.vacancyDetail.funnelView.inviteEntry.button');
  return (
    <div data-testid="invite-entry" className="flex flex-col items-end gap-1.5">
      <ActionButton
        resource="messaging"
        action="send"
        variant="primary"
        size="dense"
        shape="rounded"
        className="!h-11 !px-[18px] !text-[15px] gap-2.5"
        data-testid="invite-entry-button"
        onClick={() => navigate(`/admin/vacancies/${vacancyId}/match`, { state: { from: pathname + search } })}
      >
        <Send size={18} aria-hidden="true" />
        {label}
        {count > 0 && (
          <span
            data-testid="invite-entry-count"
            className="inline-flex min-h-[22px] min-w-[22px] items-center justify-center rounded-full border-2 border-[#F227AF] bg-white px-1.5 text-xs font-semibold leading-none text-primary"
          >
            {count}
          </span>
        )}
      </ActionButton>
      {count > 0 && (
        <span
          data-testid="invite-entry-pending-line"
          className="text-xs font-medium leading-4 text-primary"
        >
          {t('admin.vacancyDetail.funnelView.inviteEntry.pending', { count })}
        </span>
      )}
      <span className="text-xs leading-4 text-[rgba(24,1,73,0.7)]">
        {t('admin.vacancyDetail.funnelView.inviteEntry.optional')}
      </span>
      <InviteMergeNotice />
    </div>
  );
}
