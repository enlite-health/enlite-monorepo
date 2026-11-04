import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { AdminContractedServicesApiService } from '@infrastructure/http/AdminContractedServicesApiService';
import { classifyActionError } from '@hooks/admin/contractedServiceActionError';
import { formatInstant } from '@presentation/utils/dateTimeFormat';

interface AssembleItineraryButtonProps {
  patientId: string;
  /** `max(assembled_at)` do GET do itinerário (ISO UTC); `null`/ausente = ainda não montado. */
  assembledAt: string | null | undefined;
  /** Refaz o GET do itinerário depois de montar. */
  onAssembled: () => void;
}

/** Códigos 422 com texto próprio; qualquer outro cai em `generic` (nunca o id de serviço cru da API). */
const KNOWN_ERROR_CODES = ['NO_SERVICE_WITH_VACANCY', 'SERVICE_WITHOUT_SLOT'];

/** "dd/mm" da string ISO, no fuso de Buenos Aires — nunca o fuso do processo. `—` se a data não parsear. */
function formatDdMm(iso: string): string {
  // `en-GB` só pela forma fixa dd/mm com zero à esquerda (`es-AR` devolve "30/9" mesmo com '2-digit').
  return formatInstant(iso, { day: '2-digit', month: '2-digit' }, 'en-GB') ?? '—';
}

/**
 * "Itinerario listo" (Fase 3, C8) — topo da aba Itinerario. Sem montagem: `ActionButton`
 * `patient_itinerary:update` (sem a célula o botão SOME, D269). Montado: no lugar do botão, o texto
 * "Itinerario listo desde dd/mm". A recusa 422 sai traduzida pelo CÓDIGO.
 */
export function AssembleItineraryButton({ patientId, assembledAt, onAssembled }: AssembleItineraryButtonProps): JSX.Element | null {
  const { t } = useTranslation();
  const [submitting, setSubmitting] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  if (!patientId) return null;

  if (assembledAt) {
    return (
      <Text data-testid="itinerario-montado" size="sm" color="secondary">
        {t('admin.patients.detail.itinerary.assemble.assembledSince', { date: formatDdMm(assembledAt) })}
      </Text>
    );
  }

  async function handleClick(): Promise<void> {
    setSubmitting(true);
    setErrorCode(null);
    try {
      await AdminContractedServicesApiService.assembleItinerary(patientId);
      onAssembled();
    } catch (err) {
      const classified = classifyActionError(err);
      setErrorCode(classified.kind === 'coded' && KNOWN_ERROR_CODES.includes(classified.code) ? classified.code : 'generic');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 items-start">
      <ActionButton
        resource="patient_itinerary"
        action="update"
        size="sm"
        isLoading={submitting}
        onClick={() => void handleClick()}
        data-testid="itinerario-montar"
      >
        {t('admin.patients.detail.itinerary.assemble.label')}
      </ActionButton>
      {errorCode && (
        <Text data-testid="itinerario-montar-erro" size="sm" role="alert" color="inherit" className="text-red-600">
          {t(`admin.patients.detail.itinerary.assemble.errors.${errorCode}`)}
        </Text>
      )}
    </div>
  );
}
