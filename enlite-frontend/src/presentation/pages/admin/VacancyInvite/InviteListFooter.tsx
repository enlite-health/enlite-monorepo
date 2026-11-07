import { useTranslation } from 'react-i18next';
import { Expand, Send } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import type { FooterModel, StepId } from './inviteBoardModel';

interface Props {
  footer: FooterModel;
  step: StepId;
  /** meta `invitedCount` do servidor (DF-20). */
  invitedCount: number;
  /** motivo (já traduzido) que desabilita "Invitar" — sem `messaging:send` (⚑2). */
  inviteDisabledReason?: string;
  onInvite: () => void;
  onMore: () => void;
  onFinish: () => void;
}

/** B.10 — rodapé (72 px); a visibilidade dos botões vem do modo do modelo (§9.5). */
export function InviteListFooter({ footer, step, invitedCount, inviteDisabledReason, onInvite, onMore, onFinish }: Props): JSX.Element {
  const { t } = useTranslation();
  const { mode, selectedCount, more } = footer;
  const moreLabel = more
    ? t(step === 'vacante' ? 'admin.vacancyInvite.footer.moreFromVacante' : 'admin.vacancyInvite.footer.more', { km: more.km, count: more.count })
    : '';
  const showMoreSecondary = !!more && (mode === 'invite' || mode === 'empty');
  const showMorePrimary = !!more && mode === 'after';
  const showFinishSecondary = mode === 'after';
  const showFinishPrimary = mode === 'last';
  const showInvite = mode === 'invite' || mode === 'empty';

  return (
    <div data-testid="invite-footer" data-mode={mode} className="flex h-[72px] items-center gap-3 border-t border-gray-300 bg-white px-6">
      <Text as="span" size="sm" color="inherit" data-testid="invite-invited-total" className="mr-auto text-primary/70 !text-[13px]">
        {t('admin.vacancyInvite.footer.invitedTotal', { count: invitedCount })}
      </Text>
      {mode === 'empty' && (
        <Text as="span" size="xs" color="inherit" data-testid="invite-footer-hint" className="text-primary/70">
          {t('admin.vacancyInvite.footer.pickOne')}
        </Text>
      )}
      {showMoreSecondary && (
        <Button variant="quiet" size="dense" shape="rounded" data-testid="invite-btn-more-secondary" onClick={onMore}>{moreLabel}</Button>
      )}
      {showFinishSecondary && (
        <Button variant="quiet" size="dense" shape="rounded" data-testid="invite-btn-finish-secondary" onClick={onFinish}>{t('admin.vacancyInvite.footer.finish')}</Button>
      )}
      {showInvite && (
        <Button
          variant="primary"
          size="dense"
          shape="rounded"
          data-testid="invite-btn-invite"
          disabled={mode === 'empty' || !!inviteDisabledReason}
          title={inviteDisabledReason}
          onClick={onInvite}
          className="gap-2"
        >
          <Send size={16} aria-hidden="true" />
          {mode === 'empty' ? t('admin.vacancyInvite.footer.inviteEmpty') : t('admin.vacancyInvite.footer.invite', { count: selectedCount })}
        </Button>
      )}
      {showMorePrimary && (
        <Button variant="primary" size="dense" shape="rounded" data-testid="invite-btn-more-primary" onClick={onMore} className="gap-2">
          <Expand size={16} aria-hidden="true" />
          {moreLabel}
        </Button>
      )}
      {showFinishPrimary && (
        <Button variant="primary" size="dense" shape="rounded" data-testid="invite-btn-finish-primary" onClick={onFinish}>{t('admin.vacancyInvite.footer.finish')}</Button>
      )}
    </div>
  );
}
