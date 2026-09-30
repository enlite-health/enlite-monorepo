import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Label } from '@presentation/components/atoms/Label';
import { ActionButton } from '@presentation/components/features/access';
import type { ExitDestination } from '@domain/entities/ServiceTeam';
import { SidePanelShell } from './SidePanelShell';
import { ExitReasonSelect } from './ExitReasonSelect';
import { ExitDestinationField } from './ExitDestinationField';

interface RemoveFromItineraryPanelProps {
  /** Rótulo do prestador que sai (nome ou o fallback com o fim do id). */
  workerLabel: string;
  onConfirm: (reasonCategory: string, destination: ExitDestination) => void;
  onCancel: () => void;
  submitting?: boolean;
  /** Mensagem já traduzida do último erro do envio; o painel fica aberto para tentar de novo. */
  errorMessage?: string | null;
}

/**
 * "Quitar del itinerario" (change itinerario-trocas-motivos-e-figma, Fase 4): motivo (catálogo, `ExitReasonSelect`)
 * e destino (`ExitDestinationField`), ambos obrigatórios — "Confirmar" fica desabilitado sem motivo OU sem destino.
 * A casca é a `SidePanelShell` do itinerário. A escrita é de quem abre o painel (`onConfirm`).
 */
export function RemoveFromItineraryPanel({ workerLabel, onConfirm, onCancel, submitting = false, errorMessage = null }: RemoveFromItineraryPanelProps): JSX.Element {
  const { t } = useTranslation();
  const tr = (key: string) => t(`admin.patients.detail.itinerary.removePanel.${key}`);
  const [reason, setReason] = useState('');
  const [destination, setDestination] = useState<ExitDestination | ''>('');

  return (
    <SidePanelShell ariaLabel={tr('title')} onClose={onCancel} testId="itinerario-quitar-painel">
      <div className="flex items-center justify-between w-full">
        <Heading level={1} as="h2" weight="semibold" color="primary">
          {tr('title')}
        </Heading>
        <ActionButton
          resource="patient_itinerary"
          action="update"
          variant="primary"
          size="md"
          className="w-[160px]"
          disabled={!reason || !destination || submitting}
          onClick={() => {
            if (reason && destination) onConfirm(reason, destination);
          }}
          data-testid="itinerario-quitar-confirmar"
        >
          {tr('confirm')}
        </ActionButton>
      </div>

      <Text size="sm" color="secondary" data-testid="itinerario-quitar-prestador">
        {t('admin.patients.detail.itinerary.removePanel.worker', { worker: workerLabel })}
      </Text>

      <div className="flex flex-col gap-1">
        <Label className="font-semibold !text-[16px] !leading-[1.35]">{tr('reason')}</Label>
        <ExitReasonSelect value={reason} onChange={setReason} data-testid="itinerario-quitar-motivo" />
      </div>

      <ExitDestinationField value={destination} onChange={setDestination} data-testid="itinerario-quitar-destino" />

      {errorMessage && (
        <Text size="sm" role="alert" color="inherit" className="text-red-600" data-testid="itinerario-quitar-erro">
          {errorMessage}
        </Text>
      )}
    </SidePanelShell>
  );
}
