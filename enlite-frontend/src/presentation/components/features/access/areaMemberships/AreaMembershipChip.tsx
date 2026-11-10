import { Text } from '@presentation/components/atoms';
import type { AreaPersonMembership } from '@domain/entities/AreaMembership';
import { useMembershipLabel } from './useMembershipLabel';

/** A bolinha de cada área (tokens `care`/`learn` do tailwind); área sem cor própria usa o cinza neutro. */
const DOT: Record<string, string> = { care: 'bg-care', learn: 'bg-learn' };

/** O chip de um vínculo vivo (área + papel). Só leitura: revogar é no painel lateral. */
export function AreaMembershipChip({ membership }: { membership: AreaPersonMembership }): JSX.Element {
  const label = useMembershipLabel();
  return (
    <span
      className="inline-flex items-center gap-1.5 h-6 px-2.5 rounded-full bg-gray-200 border border-gray-600 whitespace-nowrap"
      data-testid="area-membership-chip"
    >
      <span className={`w-2 h-2 rounded-full shrink-0 ${DOT[membership.area] ?? 'bg-gray-800'}`} aria-hidden="true" />
      <Text as="span" size="xs" weight="medium" color="primary">{label(membership)}</Text>
    </span>
  );
}
