/**
 * DedupSignalBadge
 *
 * Inline badge showing how many accounts in a group have real login activity.
 * Uses inline span pattern (NOT the Badge atom — that's for StepStatus).
 * Pattern from BlockedAttemptsPage.tsx:87-96.
 *
 * Signal logic:
 *   realCount === total → all real
 *   realCount === 0     → all test/prueba
 *   otherwise           → mixed
 */

import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { DedupAccount } from '@domain/entities/DedupGroup';

interface DedupSignalBadgeProps {
  accounts: DedupAccount[];
}

/** Counts how many accounts have login_real===true */
function countRealAccounts(accounts: DedupAccount[]): number {
  return accounts.filter((a) => a.login_real).length;
}

export function DedupSignalBadge({ accounts }: DedupSignalBadgeProps) {
  const { t } = useTranslation();
  const total = accounts.length;
  const realCount = countRealAccounts(accounts);

  let colorClass: string;
  let label: string;

  if (realCount === total) {
    colorClass = 'bg-green-100 text-green-700';
    label = t('admin.dedup.signal.allReal', {
      count: total,
      defaultValue: `${total} real${total !== 1 ? 'es' : ''}`,
    });
  } else if (realCount === 0) {
    colorClass = 'bg-slate-100 text-slate-600';
    label = t('admin.dedup.signal.allTest', {
      count: total,
      defaultValue: `${total} prueba`,
    });
  } else {
    colorClass = 'bg-amber-100 text-amber-700';
    label = t('admin.dedup.signal.mixed', {
      real: realCount,
      test: total - realCount,
      defaultValue: `${realCount} real · ${total - realCount} prueba`,
    });
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full ${colorClass}`}>
      <Text as="span" size="xs" weight="medium" color="inherit">
        {label}
      </Text>
    </span>
  );
}
