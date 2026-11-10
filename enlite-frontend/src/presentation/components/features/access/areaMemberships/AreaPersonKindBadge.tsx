import { useTranslation } from 'react-i18next';
import { Badge, type BadgeTone } from '@presentation/components/atoms/Badge/Badge';
import type { AreaPersonKind } from '@domain/entities/AreaMembership';

const TONE: Record<AreaPersonKind, BadgeTone> = { staff: 'brand', worker: 'success', account: 'warning' };

export function AreaPersonKindBadge({ kind, className = '' }: { kind: AreaPersonKind; className?: string }): JSX.Element {
  const { t } = useTranslation();
  return (
    <Badge tone={TONE[kind]} className={className}>
      <span data-testid="area-person-kind" data-kind={kind}>{t(`admin.access.areaMemberships.kinds.${kind}`)}</span>
    </Badge>
  );
}
