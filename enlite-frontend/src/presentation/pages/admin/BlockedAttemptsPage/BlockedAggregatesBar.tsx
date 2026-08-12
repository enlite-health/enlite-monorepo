/**
 * BlockedAggregatesBar
 *
 * Displays the aggregate summary cards at the top of the BlockedAttemptsPage:
 * total blocked + breakdown by reason.
 */

import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { BlockedAggregates } from '@domain/entities/BlockedAttempt';

const REASON_BADGE_COLORS: Record<string, string> = {
  registration_incomplete: 'bg-amber-100 text-amber-800',
  worker_disabled: 'bg-red-100 text-red-800',
  worker_not_found: 'bg-slate-100 text-slate-700',
};

interface Props {
  aggregates: BlockedAggregates;
}

export function BlockedAggregatesBar({ aggregates }: Props): JSX.Element {
  const { t } = useTranslation();
  const ba = (key: string) => t(`admin.blockedAttempts.${key}`);

  const reasons = Object.entries(aggregates.byReason);

  return (
    <div className="flex flex-wrap gap-4 mb-6">
      {/* Total card */}
      <div
        className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex-1 min-w-[160px]"
        data-testid="agg-total"
      >
        <Text size="xs" color="muted" as="span">
          {ba('aggregates.totalBlocked')}
        </Text>
        <Heading level={2} color="primary" weight="bold" className="mt-1">
          {aggregates.totalBlocked}
        </Heading>
      </div>

      {/* Per-reason cards */}
      {reasons.map(([reason, count]) => {
        const colorClass =
          REASON_BADGE_COLORS[reason] ?? 'bg-slate-100 text-slate-700';
        return (
          <div
            key={reason}
            className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex-1 min-w-[160px]"
            data-testid={`agg-reason-${reason}`}
          >
            <span
              className={`inline-block px-2 py-0.5 rounded-full mb-2 ${colorClass}`}
            >
              <Text as="span" size="xs" weight="medium" color="inherit">
                {t(`admin.blockedAttempts.reason.${reason}`, { defaultValue: reason })}
              </Text>
            </span>
            <Heading level={2} color="secondary" weight="semibold" className="mt-1">
              {count}
            </Heading>
          </div>
        );
      })}
    </div>
  );
}
