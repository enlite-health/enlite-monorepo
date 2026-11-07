import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { WorkerAvatar } from '@presentation/components/atoms/WorkerAvatar';

interface ShellProps {
  width: number;
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
  testId: string;
  className?: string;
}

/** Molde do diálogo da página: overlay rgba(17,24,39,.45), raio 20, `role=dialog aria-modal`, Esc fecha. */
export function InviteDialogShell({ width, labelledBy, onClose, children, testId, className = '' }: ShellProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[rgba(17,24,39,.45)] p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        data-testid={testId}
        style={{ width }}
        className={`flex max-h-[780px] max-w-full flex-col gap-4 overflow-auto rounded-[20px] bg-white shadow-[0_24px_48px_rgba(0,0,0,.2)] ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

export interface ConfirmTarget { workerId: string; workerName: string; distanceKm: number | null }

interface Props {
  targets: readonly ConfirmTarget[];
  /** já convidados do passo (não recebem de novo por padrão, DF-5). */
  already: { names: string[]; date: string } | null;
  onCancel: () => void;
  onConfirm: (resend: boolean) => void;
}

/** F3 — confirmação com nomes e distâncias (E4). O envio só sai daqui. */
export function InviteConfirmDialog({ targets, already, onCancel, onConfirm }: Props): JSX.Element {
  const { t } = useTranslation();
  const [resend, setResend] = useState(false);
  const actionsRef = useRef<HTMLDivElement>(null);
  // foco inicial no "No, volver" (o padrão seguro: nada sai sem um clique deliberado).
  useEffect(() => { actionsRef.current?.querySelector('button')?.focus(); }, []);
  const total = targets.length + (resend && already ? already.names.length : 0);
  // "A", "A y B", "A, B y C" (a conjunção vem do i18n).
  const names = already
    ? already.names.length > 1
      ? `${already.names.slice(0, -1).join(', ')} ${t('admin.vacancyInvite.confirm.and')} ${already.names[already.names.length - 1]}`
      : already.names[0]
    : '';

  return (
    <InviteDialogShell width={560} labelledBy="invite-confirm-title" onClose={onCancel} testId="invite-confirm-dialog" className="p-7">
      <Heading level={3} as="h2" weight="semibold" color="primary" id="invite-confirm-title" className="!text-xl !leading-7">
        {t('admin.vacancyInvite.confirm.title')}
      </Heading>
      <Text size="sm" color="inherit" className="text-primary/70" data-testid="invite-confirm-lead">
        {t('admin.vacancyInvite.confirm.lead', { count: targets.length })}
      </Text>
      <ul data-testid="invite-confirm-list" className="max-h-[280px] overflow-y-auto rounded-2xl border border-gray-300">
        {targets.map((tg) => (
          <li key={tg.workerId} data-testid={`invite-confirm-item-${tg.workerId}`} className="flex h-[52px] items-center gap-3 border-b border-gray-300 px-4 last:border-b-0">
            <WorkerAvatar name={tg.workerName} avatarUrl={null} size={32} />
            <Text as="span" size="sm" weight="medium" color="primary" className="min-w-0 flex-1 truncate">{tg.workerName}</Text>
            <Text as="span" size="sm" color="inherit" className="text-primary/70 !text-[13px]">
              {tg.distanceKm == null
                ? t('admin.vacancyInvite.confirm.noLocation')
                : t('admin.vacancyInvite.row.distance', { value: tg.distanceKm.toFixed(1).replace('.', ',') })}
            </Text>
          </li>
        ))}
      </ul>
      {already && (
        <div data-testid="invite-confirm-already" className="flex flex-col gap-2.5 rounded-2xl bg-gray-200 px-4 py-3.5">
          <Text size="sm" color="primary" className="!text-[13px] !leading-5">
            {t(already.names.length === 1 ? 'admin.vacancyInvite.confirm.alreadyOne' : 'admin.vacancyInvite.confirm.alreadyMany', { names, date: already.date })}
          </Text>
          <Checkbox
            id="invite-confirm-resend"
            data-testid="invite-confirm-resend"
            label={t('admin.vacancyInvite.confirm.resend')}
            checked={resend}
            onChange={(e) => setResend(e.target.checked)}
          />
        </div>
      )}
      <Text size="xs" color="inherit" className="text-primary/70">{t('admin.vacancyInvite.confirm.note')}</Text>
      <div ref={actionsRef} className="flex justify-end gap-3">
        <Button variant="quiet" size="dense" shape="rounded" data-testid="invite-confirm-cancel" onClick={onCancel}>
          {t('admin.vacancyInvite.confirm.cancel')}
        </Button>
        <Button variant="primary" size="dense" shape="rounded" data-testid="invite-confirm-send" onClick={() => onConfirm(resend)} className="gap-2">
          <Send size={16} aria-hidden="true" />
          {t('admin.vacancyInvite.confirm.send', { count: total })}
        </Button>
      </div>
    </InviteDialogShell>
  );
}
