import { MapPin, User, Briefcase } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import type { VacancyForMatch } from './matchModalHelpers';
import { buildAddressLabel } from './matchModalHelpers';

interface ChipProps {
  icon: React.ReactNode;
  label: string;
  value: string;
}

function Chip({ icon, label, value }: ChipProps) {
  return (
    <div className="flex items-center gap-2 bg-gray-300 rounded-pill px-4 h-10">
      <span className="text-primary">{icon}</span>
      <Text as="span" size="sm" color="muted">{label}:</Text>
      <Text as="span" size="sm" weight="medium" color="secondary">{value}</Text>
    </div>
  );
}

interface MatchCriteriaChipsProps {
  vacancy: VacancyForMatch | undefined;
}

export function MatchCriteriaChips({ vacancy }: MatchCriteriaChipsProps) {
  const sex = vacancy?.required_sex ?? '—';
  const profession =
    (vacancy?.required_professions as string[] | null)?.[0] ?? '—';
  const address = buildAddressLabel(vacancy);

  return (
    <div className="flex flex-wrap gap-2">
      <Chip icon={<User size={16} />} label="Sexo" value={sex} />
      <Chip
        icon={<Briefcase size={16} />}
        label="Profesión"
        value={profession}
      />
      <Chip icon={<MapPin size={16} />} label="Dirección" value={address} />
    </div>
  );
}
