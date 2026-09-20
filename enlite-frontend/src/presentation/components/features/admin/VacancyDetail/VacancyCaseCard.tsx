import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { VacancyStatusBadge } from '@presentation/components/atoms/VacancyStatusBadge';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import {
  VacancyStatusEditor,
  type EditableVacancyStatus,
} from './VacancyStatusEditor';

interface VacancyCaseCardProps {
  status: string;
  caseNumber: number | null;
  dependencyLevel: string | null;
  profession: string | null;
  sex: string | null;
  zone: string | null;
  patientCity: string | null;
  patientNeighborhood: string | null;
  paymentTermDays: number | null;
  netHourlyRate: string | null;
  weeklyHours: number | null;
  providersNeeded: number | null;
  publishedAt: string | null;
  closedAt: string | null;
  onStatusChange?: (next: EditableVacancyStatus) => void | Promise<void>;
  isStatusSaving?: boolean;
}

function formatDateAR(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    return new Date(dateStr).toLocaleDateString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
    });
  } catch {
    return '—';
  }
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: string | number | null;
}) {
  return (
    <div className="flex justify-between items-baseline gap-2">
      <Text size="base" color="secondary">
        {label}
      </Text>
      <Text size="xl" color="primary" weight="medium">
        {value != null && value !== '' ? String(value) : '—'}
      </Text>
    </div>
  );
}

function DateRow({
  label,
  value,
}: {
  label: string;
  value: string | null;
}) {
  return (
    <div className="flex justify-between items-baseline gap-2">
      <Text size="base" color="secondary">
        {label}
      </Text>
      <Text size="lg" color="primary" weight="medium">
        {formatDateAR(value)}
      </Text>
    </div>
  );
}

export function VacancyCaseCard({
  status,
  caseNumber,
  dependencyLevel,
  profession,
  sex,
  zone,
  patientCity,
  patientNeighborhood,
  paymentTermDays,
  netHourlyRate,
  weeklyHours,
  providersNeeded,
  publishedAt,
  closedAt,
  onStatusChange,
  isStatusSaving,
}: VacancyCaseCardProps) {
  const { t } = useTranslation();
  // PUT /vacancies/:id → updateVacancy → vacancy:write. O dropdown de status
  // (inclusive "CLOSED", o equivalente a arquivar) não é `<Button>`, então
  // usa `useActionGate` direto — mesma leitura do `ActionButton` (D269).
  const vacancyWriteGate = useActionGate('vacancy', 'update');

  const sexLabel = sex
    ? t(`admin.vacancyDetail.vacancyForm.sexOptions.${sex}`, sex)
    : null;

  const professionLabel = profession
    ? t(`admin.vacancyDetail.vacancyForm.professionOptions.${profession}`, profession)
    : null;

  const caseParts = [
    professionLabel,
    sexLabel,
    zone,
  ].filter(Boolean).join(' - ');

  const caseDesc = caseNumber != null
    ? [`${t('admin.vacancyDetail.caseCard.caseLabel')} ${caseNumber}`, caseParts]
        .filter(Boolean)
        .join(' - ')
    : caseParts || '—';

  const locationParts = [patientCity, patientNeighborhood].filter(Boolean).join(', ');

  const paymentTermLabel = paymentTermDays != null
    ? String(paymentTermDays)
    : '—';

  return (
    <div data-testid="vacancy-case-card" className="border-[2.5px] border-gray-400 rounded-card bg-white p-8">
      {/* Header: case label + badge */}
      <div className="flex justify-between items-center mb-5">
        <Heading level={2} color="primary" weight="medium">
          {t('admin.vacancyDetail.caseCard.caseLabel')} {caseNumber ?? '—'}
        </Heading>
        {/* D269 — sem vacancy:write o valor vira TEXTO (o badge), sem os
            controles do editor (nem dropdown, nem gatilho clicável). */}
        {onStatusChange && !vacancyWriteGate.denied ? (
          <VacancyStatusEditor
            status={status}
            isSaving={isStatusSaving}
            onChange={onStatusChange}
          />
        ) : (
          <VacancyStatusBadge status={status} />
        )}
      </div>

      {/* Dependency level pill */}
      {dependencyLevel && (
        <span className="inline-flex items-center bg-gray-400 text-cyan-focus px-7 py-2 rounded">
          <Text as="span" size="base" weight="medium" color="inherit">
            {t(`admin.patients.dependencyOptions.${dependencyLevel}`, {
              defaultValue: dependencyLevel,
            })}
          </Text>
        </span>
      )}

      {/* Case description */}
      <Text size="base" color="secondary" className="mt-4">
        {caseDesc}
      </Text>

      {/* Location */}
      {locationParts && (
        <div className="flex items-center gap-1 mt-3">
          <MapPin className="w-4 h-4 text-gray-800 shrink-0" strokeWidth={1.5} />
          <Text size="base" color="secondary">
            {locationParts}
          </Text>
        </div>
      )}

      {/* Payment term */}
      <div className="flex flex-col gap-2.5 mt-6">
        <Heading level={2} color="primary" weight="medium">
          {t('admin.vacancyDetail.caseCard.paymentTerm')}
        </Heading>
        <Text size="base" color="secondary">
          {paymentTermLabel}
        </Text>
      </div>

      {/* Details */}
      <div className="flex flex-col gap-2.5 mt-6">
        <Heading level={2} color="primary" weight="medium">
          {t('admin.vacancyDetail.caseCard.details')}
        </Heading>
        <DetailRow
          label={t('admin.vacancyDetail.caseCard.netHourlyRate')}
          value={netHourlyRate ?? null}
        />
        <DetailRow
          label={t('admin.vacancyDetail.caseCard.weeklyHours')}
          value={weeklyHours != null ? `${weeklyHours}h` : null}
        />
        <DetailRow
          label={t('admin.vacancyDetail.caseCard.providersNeeded')}
          value={providersNeeded ?? null}
        />
      </div>

      {/* Dates */}
      <div className="flex flex-col gap-2.5 mt-6">
        <Heading level={2} color="primary" weight="medium">
          {t('admin.vacancyDetail.caseCard.dates')}
        </Heading>
        <DateRow
          label={t('admin.vacancyDetail.caseCard.publishedAt')}
          value={publishedAt}
        />
        <DateRow
          label={t('admin.vacancyDetail.caseCard.closedAt')}
          value={closedAt}
        />
      </div>
    </div>
  );
}
