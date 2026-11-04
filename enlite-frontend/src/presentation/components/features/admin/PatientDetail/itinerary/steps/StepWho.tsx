import { useTranslation } from 'react-i18next';
import { PersonAvatar } from '@presentation/components/atoms/PersonAvatar';
import { Text } from '@presentation/components/atoms/Text';
import type { OutgoingCandidate } from '@domain/entities/SubstitutionRequest';
import { workerLabel } from '../../workerLabel';
import { OptionCard } from './OptionCard';

interface StepWhoProps {
  people: OutgoingCandidate[];
  status: 'loading' | 'ok' | 'error';
  selected: string | null;
  onSelect: (workerId: string) => void;
}

/** Passo 1 — "¿Quién no va a venir?": UMA linha por PESSOA com alocação neste serviço (US3), nunca por faixa. */
export function StepWho({ people, status, selected, onSelect }: StepWhoProps): JSX.Element {
  const { t } = useTranslation();
  const ts = (key: string) => t(`admin.patients.detail.itinerary.flow.who.${key}`);

  if (status === 'loading') {
    return (
      <Text size="sm" color="tertiary" data-testid="substitucion-quien-cargando">
        {ts('loading')}
      </Text>
    );
  }
  if (status === 'error') {
    return (
      <Text size="sm" role="alert" color="inherit" className="text-red-800" data-testid="substitucion-quien-error">
        {ts('loadError')}
      </Text>
    );
  }
  if (people.length === 0) {
    return (
      <Text size="sm" color="tertiary" data-testid="substitucion-quien-vacio">
        {ts('empty')}
      </Text>
    );
  }
  return (
    <div className="flex flex-col gap-2.5" role="radiogroup" aria-label={ts('title')}>
      {people.map((person) => {
        const name = workerLabel(t, person.workerId, person.displayName);
        return (
          <OptionCard
            key={person.workerId}
            name="substitucion-quien"
            selected={selected === person.workerId}
            onSelect={() => onSelect(person.workerId)}
            title={name}
            compact
            leading={<PersonAvatar uid={person.workerId} name={name} size={32} />}
            data-testid={`substitucion-quien-${person.workerId}`}
          />
        );
      })}
    </div>
  );
}
