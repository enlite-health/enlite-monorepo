/**
 * MergeMismatchAlert
 *
 * Warning banner shown inside the merge modal when there are conflicting fields.
 * Tells the operator how many fields have conflicting data.
 */

import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';

interface MergeMismatchAlertProps {
  conflictCount: number;
}

export function MergeMismatchAlert({ conflictCount }: MergeMismatchAlertProps) {
  const { t } = useTranslation();

  if (conflictCount === 0) return null;

  return (
    <div
      className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-xl p-4"
      role="alert"
      data-testid="merge-mismatch-alert"
    >
      <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
      <div className="flex flex-col gap-1">
        <Text as="span" size="sm" weight="semibold" color="inherit">
          {t('admin.dedup.merge.mismatchTitle', {
            count: conflictCount,
            defaultValue: `${conflictCount} campo${conflictCount !== 1 ? 's' : ''} con conflicto`,
          })}
        </Text>
        <Text as="span" size="xs" color="muted">
          {t(
            'admin.dedup.merge.mismatchDesc',
            'Expandí "Avanzado" para revisar y elegir qué valor conservar campo por campo.',
          )}
        </Text>
      </div>
    </div>
  );
}
