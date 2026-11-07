import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheck } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { InviteDialogShell } from './InviteConfirmDialog';
import type { FinishSummary } from './inviteBoardModel';

interface Props {
  summary: FinishSummary;
  onKeepInviting: () => void;
  onBack: () => void;
}

/** F5 — resumo do dia com dado do servidor (DF-20). Faixas com 0 não aparecem. */
export function InviteFinishDialog({ summary, onKeepInviting, onBack }: Props): JSX.Element {
  const { t } = useTranslation();
  const actionsRef = useRef<HTMLDivElement>(null);
  useEffect(() => { actionsRef.current?.querySelector('button')?.focus(); }, []);

  const rows: Array<{ key: string; label: string; count: number }> = [];
  if (summary.vacante > 0) rows.push({ key: 'vacante', label: t('admin.vacancyInvite.steps.vacante'), count: summary.vacante });
  for (const b of summary.bands) {
    rows.push({
      key: String(b.max),
      label: b.min === 0 ? t('admin.vacancyInvite.steps.upTo', { km: b.max }) : t('admin.vacancyInvite.finish.between', { min: b.min, max: b.max }),
      count: b.count,
    });
  }
  if (summary.noLocation > 0) rows.push({ key: 'noLocation', label: t('admin.vacancyInvite.confirm.noLocation'), count: summary.noLocation });

  return (
    <InviteDialogShell width={520} labelledBy="invite-finish-title" onClose={onKeepInviting} testId="invite-finish-dialog" className="items-center p-8 text-center">
      <span aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-full bg-[#E1F6EE] text-[#0A5540]">
        <CircleCheck size={28} />
      </span>
      <Heading level={3} as="h2" weight="semibold" color="primary" id="invite-finish-title" className="!text-xl !leading-7" data-testid="invite-finish-title">
        {t('admin.vacancyInvite.finish.title', { count: summary.total })}
      </Heading>
      <ul data-testid="invite-finish-table" className="w-full rounded-2xl border border-gray-300 text-left">
        {rows.map((r) => (
          <li key={r.key} data-testid={`invite-finish-row-${r.key}`} className="flex h-11 items-center gap-3 border-b border-gray-300 px-4 last:border-b-0">
            <Text as="span" size="sm" color="primary" className="flex-1">{r.label}</Text>
            <Text as="span" size="sm" weight="semibold" color="primary" className="tabular-nums">{r.count}</Text>
          </li>
        ))}
      </ul>
      <Text size="sm" color="inherit" className="text-primary/70">{t('admin.vacancyInvite.finish.text')}</Text>
      <div ref={actionsRef} className="flex justify-center gap-3">
        <Button variant="quiet" size="dense" shape="rounded" data-testid="invite-finish-keep" onClick={onKeepInviting}>
          {t('admin.vacancyInvite.finish.keep')}
        </Button>
        <Button variant="primary" size="dense" shape="rounded" data-testid="invite-finish-back" onClick={onBack}>
          {t('admin.vacancyInvite.back')}
        </Button>
      </div>
    </InviteDialogShell>
  );
}
