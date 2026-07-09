import { useTranslation } from 'react-i18next';
import { Users, Send } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';

interface MatchTotalsMarkerProps {
  /** Total de candidatos disponíveis somando TODOS os raios de alcance. */
  availableCount: number;
  /** Quantos já foram efetivamente recrutados (convite enviado / messagedAt). */
  recruitedCount: number;
}

/**
 * Marcador de totais do match (ClickUp 86ajb48v1 AC3): mostra o total de
 * pessoas disponíveis em todos os raios vs. quantas já foram recrutadas,
 * permitindo comparar disponíveis × recrutadas de relance.
 */
export function MatchTotalsMarker({
  availableCount,
  recruitedCount,
}: MatchTotalsMarkerProps) {
  const { t } = useTranslation();
  return (
    <div
      data-testid="match-totals-marker"
      className="flex items-center gap-4 rounded-card border border-gray-400 bg-white px-4 py-3"
    >
      <div className="flex items-center gap-2">
        <Users size={16} className="text-primary" aria-hidden="true" />
        <Text as="span" size="sm" color="muted">
          {t('admin.match.totals.available')}
        </Text>
        <Text as="span" size="sm" weight="semibold" color="secondary">
          {availableCount}
        </Text>
      </div>
      <span className="h-4 w-px bg-gray-400" aria-hidden="true" />
      <div className="flex items-center gap-2">
        <Send size={16} className="text-primary" aria-hidden="true" />
        <Text as="span" size="sm" color="muted">
          {t('admin.match.totals.recruited')}
        </Text>
        <Text as="span" size="sm" weight="semibold" color="secondary">
          {recruitedCount}
        </Text>
      </div>
    </div>
  );
}
