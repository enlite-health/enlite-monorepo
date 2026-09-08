/**
 * BlockedAttemptsFilters
 *
 * Filter bar for the BlockedAttemptsPage:
 * - Filter by reason (dropdown)
 * - Filter by vacancy ID (text input)
 */

import { useTranslation } from 'react-i18next';
import { Select } from '@presentation/components/atoms/Select';
import { Input } from '@presentation/components/atoms/Input';
import type { BlockedReason } from '@domain/entities/BlockedAttempt';

interface Props {
  reason: BlockedReason | '';
  vacancyId: string;
  onReasonChange: (reason: BlockedReason | '') => void;
  onVacancyIdChange: (id: string) => void;
}

export function BlockedAttemptsFilters({
  reason,
  vacancyId,
  onReasonChange,
  onVacancyIdChange,
}: Props): JSX.Element {
  const { t } = useTranslation();
  const ba = (key: string) => t(`admin.blockedAttempts.${key}`);

  /**
   * Derivado de `BlockedReason` para não divergir da API — foi a divergência que
   * deixou o painel exibindo o balde "Registro completo" no topo sem deixar
   * filtrar por ele. São justamente as pessoas prontas para trabalhar, que o
   * recálculo ao vivo passou a revelar (D300).
   */
  const REASONS: BlockedReason[] = [
    'registration_incomplete',
    'worker_disabled',
    'worker_not_found',
    'eligible',
  ];

  const reasonOptions = [
    { value: '', label: ba('filters.allReasons') },
    ...REASONS.map((r) => ({ value: r, label: t(`admin.blockedAttempts.reason.${r}`) })),
  ];

  return (
    <div className="flex flex-wrap gap-3 mb-4" data-testid="blocked-filters">
      <div className="w-full sm:w-64">
        <Select
          options={reasonOptions}
          value={reason}
          onValueChange={(v) => onReasonChange(v as BlockedReason | '')}
          aria-label={ba('filters.reason')}
          inputSize="compact"
        />
      </div>
      <div className="w-full sm:w-80">
        <Input
          type="text"
          value={vacancyId}
          onChange={(e) => onVacancyIdChange(e.target.value)}
          placeholder={ba('filters.vacancyPlaceholder')}
          aria-label={ba('filters.vacancy')}
          inputSize="compact"
        />
      </div>
    </div>
  );
}
