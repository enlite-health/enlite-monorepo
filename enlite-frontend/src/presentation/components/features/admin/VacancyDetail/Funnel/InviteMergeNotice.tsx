import { useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import {
  dismissInviteMergeNotice,
  isInviteMergeNoticeActive,
  wasInviteMergeNoticeDismissed,
} from './inviteMergeNoticeModel';

interface Props {
  /** Só para teste: o "agora" da comparação com a data-limite. */
  now?: Date;
}

export function InviteMergeNotice({ now }: Props): JSX.Element | null {
  const { t } = useTranslation();
  const uid = useAdminAuthStore((s) => s.authz?.uid);
  const [dismissed, setDismissed] = useState(() => wasInviteMergeNoticeDismissed(uid));

  if (dismissed || !isInviteMergeNoticeActive(now)) return null;

  return (
    <div
      data-testid="invite-merge-notice"
      className="flex items-center gap-1 text-xs leading-4 text-[rgba(24,1,73,0.7)]"
    >
      <span>{t('admin.vacancyDetail.funnelView.inviteEntry.mergeNotice')}</span>
      <button
        type="button"
        data-testid="invite-merge-notice-close"
        aria-label={t('admin.vacancyDetail.funnelView.inviteEntry.mergeNoticeClose')}
        title={t('admin.vacancyDetail.funnelView.inviteEntry.mergeNoticeClose')}
        onClick={() => {
          dismissInviteMergeNotice(uid);
          setDismissed(true);
        }}
        className="inline-flex h-5 w-5 items-center justify-center rounded text-primary hover:bg-gray-200"
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}
