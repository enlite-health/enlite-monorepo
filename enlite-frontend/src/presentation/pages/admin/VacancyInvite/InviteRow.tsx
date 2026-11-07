import { useTranslation } from 'react-i18next';
import { LoaderCircle } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Badge } from '@presentation/components/atoms/Badge';
import { Checkbox } from '@presentation/components/atoms/Checkbox';
import { WorkerAvatar } from '@presentation/components/atoms/WorkerAvatar';
import type { RowModel } from './inviteBoardModel';

/** Estado de envio desta pessoa na fila (DF-18 c, DF-19). `text` do erro vem localizado da página. */
export type RowSendState = { kind: 'sending' } | { kind: 'error'; text: string };

interface Props {
  row: RowModel;
  /** clicou no nome: pino enfatizado + fundo de foco. */
  focused: boolean;
  /** cursor no pino correspondente (ou na linha). */
  highlighted: boolean;
  send?: RowSendState;
  onToggle: (workerId: string) => void;
  onNameClick: (workerId: string) => void;
  onHover: (workerId: string | null) => void;
}

/** B.8 — linha de prestador (64 px). */
export function InviteRow({ row, focused, highlighted, send, onToggle, onNameClick, onHover }: Props): JSX.Element {
  const { t } = useTranslation();
  const c = row.candidate;
  const id = c.workerId;
  const bg = focused ? 'bg-[#ECE8F6]' : highlighted ? 'bg-gray-200' : 'bg-white hover:bg-gray-200';
  const distance =
    row.distanceKm == null
      ? t('admin.vacancyInvite.row.noDistance')
      : t('admin.vacancyInvite.row.distance', { value: row.distanceKm.toFixed(1).replace('.', ',') });

  let stamp: JSX.Element | null = null;
  if (send?.kind === 'sending') {
    stamp = (
      <span className="inline-flex items-center gap-1 text-primary/70">
        <LoaderCircle size={14} className="animate-spin" aria-hidden="true" />
        <Text as="span" size="xs" color="inherit">{t('admin.vacancyInvite.row.sending')}</Text>
      </span>
    );
  } else if (send?.kind === 'error') {
    stamp = <span title={send.text}><Badge tone="warning">{send.text}</Badge></span>;
  } else if (row.badge?.kind === 'today') {
    stamp = <Badge tone="success">{t('admin.vacancyInvite.row.invitedToday')}</Badge>;
  } else if (row.badge?.kind === 'on') {
    stamp = <Badge tone="neutral">{t('admin.vacancyInvite.row.invitedOn', { date: row.badge.dayMonth })}</Badge>;
  }

  return (
    <div
      id={`invite-row-${id}`}
      data-testid={`invite-row-${id}`}
      data-focused={focused || undefined}
      data-selected={row.selected}
      onMouseEnter={() => onHover(id)}
      onMouseLeave={() => onHover(null)}
      className={`flex h-16 items-center gap-3 border-b border-gray-300 px-6 ${bg}`}
    >
      <div className="w-5 shrink-0">
        {row.selectable && (
          <Checkbox
            data-testid={`invite-row-check-${id}`}
            aria-label={t('admin.vacancyInvite.row.choose', { name: c.workerName })}
            checked={row.selected}
            onChange={() => onToggle(id)}
          />
        )}
      </div>
      <WorkerAvatar name={c.workerName} avatarUrl={null} size={32} />
      <div className="min-w-0 flex-1">
        <button
          type="button"
          data-testid={`invite-row-name-${id}`}
          title={t('admin.vacancyInvite.row.showOnMap')}
          onClick={() => onNameClick(id)}
          className="block max-w-full truncate text-left"
        >
          <Text as="span" size="sm" weight="medium" color="primary">{c.workerName}</Text>
        </button>
        <div className="flex h-5 items-center gap-2">
          {c.occupation && <Text as="span" size="xs" color="inherit" className="text-primary/70">{c.occupation}</Text>}
          {c.activeCasesCount > 0 && <Badge tone="warning">{t('admin.vacancyInvite.row.activeCases', { count: c.activeCasesCount })}</Badge>}
          <a
            href={`/admin/workers/${id}`}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`invite-row-profile-${id}`}
            className="text-primary underline"
          >
            <Text as="span" size="xs" color="inherit">{t('admin.vacancyInvite.row.viewProfile')}</Text>
          </a>
        </div>
      </div>
      <div className="w-[156px] shrink-0" data-testid={`invite-row-docs-${id}`}>
        <Badge tone={row.docsComplete ? 'success' : 'warning'}>
          {t(row.docsComplete ? 'admin.vacancyInvite.docs.complete' : 'admin.vacancyInvite.docs.missing')}
        </Badge>
      </div>
      <Text as="span" size="sm" color="primary" data-testid={`invite-row-distance-${id}`} className="w-14 shrink-0 text-right !text-[13px] tabular-nums">
        {distance}
      </Text>
      <div className="flex w-[136px] shrink-0 justify-end" data-testid={`invite-row-badge-${id}`}>{stamp}</div>
    </div>
  );
}
