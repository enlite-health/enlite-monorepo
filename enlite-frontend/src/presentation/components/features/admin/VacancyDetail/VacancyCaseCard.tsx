import { useTranslation } from 'react-i18next';
import { MapPin } from 'lucide-react';
import { Typography } from '@presentation/components/atoms/Typography';
import { VacancyStatusBadge } from '@presentation/components/atoms/VacancyStatusBadge';

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
      <Typography variant="label" color="secondary">
        {label}
      </Typography>
      <Typography variant="value" color="primary" weight="medium">
        {value != null && value !== '' ? String(value) : '—'}
      </Typography>
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
      <Typography variant="label" color="secondary">
        {label}
      </Typography>
      <Typography variant="value-sm" color="primary" weight="medium">
        {formatDateAR(value)}
      </Typography>
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
}: VacancyCaseCardProps) {
  const { t } = useTranslation();

  const caseParts = [
    profession,
    sex,
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
    <div className="border-[2.5px] border-gray-400 rounded-card bg-white p-8">
      {/* Header: case label + badge */}
      <div className="flex justify-between items-center mb-5">
        <Typography variant="section-title" color="primary" weight="medium">
          {t('admin.vacancyDetail.caseCard.caseLabel')} {caseNumber ?? '—'}
        </Typography>
        <VacancyStatusBadge status={status} />
      </div>

      {/* Dependency level pill */}
      {dependencyLevel && (
        <span className="inline-flex items-center font-lexend font-medium text-base text-cyan-focus bg-gray-400 px-7 py-2 rounded">
          {dependencyLevel}
        </span>
      )}

      {/* Case description */}
      <Typography variant="label" color="secondary" className="mt-4">
        {caseDesc}
      </Typography>

      {/* Location */}
      {locationParts && (
        <div className="flex items-center gap-1 mt-3">
          <MapPin className="w-4 h-4 text-gray-800 shrink-0" strokeWidth={1.5} />
          <Typography variant="label" color="secondary">
            {locationParts}
          </Typography>
        </div>
      )}

      {/* Payment term */}
      <div className="flex flex-col gap-2.5 mt-6">
        <Typography variant="section-title" color="primary" weight="medium">
          {t('admin.vacancyDetail.caseCard.paymentTerm')}
        </Typography>
        <Typography variant="label" color="secondary">
          {paymentTermLabel}
        </Typography>
      </div>

      {/* Details */}
      <div className="flex flex-col gap-2.5 mt-6">
        <Typography variant="section-title" color="primary" weight="medium">
          {t('admin.vacancyDetail.caseCard.details')}
        </Typography>
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
        <Typography variant="section-title" color="primary" weight="medium">
          {t('admin.vacancyDetail.caseCard.dates')}
        </Typography>
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
