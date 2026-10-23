import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { formatVacancyCase } from '@domain/value-objects/caseNumberFormat';
import type { ServiceReserve } from '@domain/entities/PatientItinerary';

/** A vaga viva do serviço como a ficha a conhece (`liveVacancy`); `null` = o ator não lê vagas (redigida) ou não há dado. */
export interface ServiceVacancyRef {
  caseNumber: number | null;
  caseOrdinal: number | null;
}

interface ServiceVacancyTagProps {
  reserve: ServiceReserve | null;
  vacancy: ServiceVacancyRef | null;
  /** `chip` = B2 (lilás, ou cinza sem vaga); `text` = B1 (linha discreta do cartão). */
  variant: 'chip' | 'text';
  'data-testid'?: string;
}

/**
 * A vaga do serviço numa frase só (mockup `b2a.png`/`desktop-light.png`): "Vacante CASO EN1234#01 · 3 en
 * Respuesta Rápida" ou "Sin vacante abierta". O "CASO …" sai de `formatVacancyCase` (o MESMO formato da
 * lista de vagas — `EN` por faixa do número); a contagem da reserva vem do GET do itinerário, nunca de conta aqui.
 * Cores do mockup (`.vtag`: #3B0A8C sobre #F1E8FF; `.vtag.none`: #4A4A4A sobre #EEEEEE) — todas acima de 7:1.
 */
export function ServiceVacancyTag({ reserve, vacancy, variant, 'data-testid': testId }: ServiceVacancyTagProps): JSX.Element {
  const { t } = useTranslation();
  const tv = (key: string, opts?: Record<string, unknown>) => t(`admin.patients.detail.itinerary.serviceVacancy.${key}`, opts);
  const caseLabel = vacancy?.caseNumber == null ? null : formatVacancyCase(vacancy.caseNumber, vacancy.caseOrdinal);
  const text =
    reserve === null
      ? tv('none')
      : caseLabel === null
        ? tv('openNoCase', { reserveCount: reserve.count })
        : tv('withCase', { caseLabel, reserveCount: reserve.count });
  if (variant === 'text') {
    return (
      <Text size="xs" color="tertiary" data-testid={testId}>
        {text}
      </Text>
    );
  }
  const tone = reserve === null ? 'bg-gray-300 text-[#4A4A4A]' : 'bg-[#F1E8FF] text-[#3B0A8C]';
  return (
    <span className={`self-start rounded-full px-3 py-[3px] ${tone}`} data-testid={testId} data-tone={reserve === null ? 'none' : 'open'}>
      <Text as="span" size="xs" weight="medium" color="inherit">
        {text}
      </Text>
    </span>
  );
}
