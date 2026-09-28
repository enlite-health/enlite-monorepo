import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@presentation/components/organisms/Card';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';
import { SearchableSelect } from '@presentation/components/molecules/SearchableSelect/SearchableSelect';
import type { ServiceTeamMember } from '@domain/entities/ServiceTeam';
import { weekdayName } from './substitutionDates';

interface AllocateSlotModalProps {
  slot: { weekday: number; startTime: string; endTime: string };
  /** As opções de `allocation-options` (os Seleccionados do serviço); `null` = ainda carregando. */
  options: ServiceTeamMember[] | null;
  onSubmit: (workerId: string) => void;
  onCancel: () => void;
}

/**
 * "Asignar prestador" num slot do itinerário (Fase 12, DX-12.10b; molde de comportamento
 * `SubstitutionDayModal`). A escolha é SÓ entre as `options` recebidas por prop (a aba busca em
 * `allocation-options`) — nenhuma busca livre de prestador, nenhuma chamada aqui. Confirmar fica
 * desabilitado até haver escolha.
 */
export function AllocateSlotModal({ slot, options, onSubmit, onCancel }: AllocateSlotModalProps): JSX.Element {
  const { t, i18n } = useTranslation();
  const tm = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.modal.${key}`, opts);
  const [workerId, setWorkerId] = useState('');

  const workerOptions = (options ?? []).map((member) => ({
    value: member.workerId,
    label: member.displayName ?? t('admin.patients.detail.serviceTeam.unnamedWorker', { shortId: member.workerId.slice(-8) }),
  }));

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" data-testid="itinerario-alocar-modal">
      <Card rounded="lg" className="p-6 w-full max-w-sm shadow-xl flex flex-col gap-4">
        <Heading level={3} color="primary">
          {tm('title', { day: weekdayName(slot.weekday, i18n.language), start: slot.startTime, end: slot.endTime })}
        </Heading>

        <SearchableSelect
          data-testid="itinerario-alocar-prestador"
          options={workerOptions}
          value={workerId}
          onChange={setWorkerId}
          disabled={options === null}
          label={tm('worker')}
          emptyMessage={tm('noOptions')}
        />

        <div className="flex gap-3">
          <Button variant="outline" size="sm" onClick={onCancel} className="flex-1" data-testid="itinerario-alocar-cancelar">
            {tm('cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => onSubmit(workerId)}
            disabled={!workerId}
            className="flex-1"
            data-testid="itinerario-alocar-confirmar"
          >
            {tm('confirm')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
