import { useTranslation } from 'react-i18next';
import { Label } from '@presentation/components/atoms/Label';
import { Text } from '@presentation/components/atoms/Text';
import type { ExitDestination } from '@domain/entities/ServiceTeam';

interface ExitDestinationFieldProps {
  value: ExitDestination | '';
  onChange: (destination: ExitDestination) => void;
  /** Destinos indisponíveis (a Fase 6 desabilita `LEAVE_SERVICE` no modo agendado). */
  disabledOptions?: readonly ExitDestination[];
  'data-testid'?: string;
}

const DESTINATIONS: readonly ExitDestination[] = ['RESERVE', 'LEAVE_SERVICE'];

/**
 * Destino de quem sai do itinerário (change itinerario-trocas-motivos-e-figma, Fase 4; reusado na Fase 6):
 * 2 rádios, obrigatório — sem valor inicial, quem usa mantém "Confirmar" desabilitado até escolher.
 * `RESERVE` = "Sigue como reserva" (volta a Selecionado); `LEAVE_SERVICE` = "Sale del encuadre de este servicio"
 * (marca de rejeição com o mesmo motivo). Só rótulos — a regra do que cada um faz é do backend.
 */
export function ExitDestinationField({
  value,
  onChange,
  disabledOptions = [],
  'data-testid': testId = 'exit-destination',
}: ExitDestinationFieldProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div role="radiogroup" aria-label={t('admin.patients.detail.itinerary.exitDestination.label')} className="flex flex-col gap-2" data-testid={testId}>
      <Label className="font-semibold !text-[16px] !leading-[1.35]">{t('admin.patients.detail.itinerary.exitDestination.label')}</Label>
      {DESTINATIONS.map((destination) => (
        <label key={destination} className="flex items-center gap-2">
          <input
            type="radio"
            name={`${testId}-radio`}
            value={destination}
            checked={value === destination}
            disabled={disabledOptions.includes(destination)}
            onChange={() => onChange(destination)}
            data-testid={`${testId}-${destination}`}
          />
          <Text as="span" size="sm">
            {t(`admin.patients.detail.itinerary.exitDestination.${destination}`)}
          </Text>
        </label>
      ))}
    </div>
  );
}
