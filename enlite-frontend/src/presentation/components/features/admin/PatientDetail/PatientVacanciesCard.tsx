import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { PatientVacancySummary } from '@domain/entities/PatientDetail';

interface PatientVacanciesCardProps {
  patientId: string;
  vacancies: PatientVacancySummary[];
  isLoading: boolean;
  error: string | null;
}

function VacancyStatusBadgeInline({ status }: { status: string | null }) {
  const { t } = useTranslation();
  if (!status) return null;
  const label = t(`admin.vacancyDetail.statusBadge.${status}`, { defaultValue: status });

  const COLOR_MAP: Record<string, string> = {
    SEARCHING: 'bg-blue-100 text-blue-700',
    SEARCHING_REPLACEMENT: 'bg-amber-100 text-amber-700',
    RAPID_RESPONSE: 'bg-amber-100 text-amber-700',
    PENDING_ACTIVATION: 'bg-cyan-100 text-cyan-700',
    ACTIVE: 'bg-green-100 text-green-700',
    ON_HOLD: 'bg-amber-100 text-amber-700',
    SUSPENDED: 'bg-gray-100 text-gray-600',
    CLOSED: 'bg-gray-100 text-gray-600',
    ADMISSION: 'bg-cyan-100 text-cyan-700',
  };
  const colorClass = COLOR_MAP[status.toUpperCase()] ?? 'bg-gray-100 text-gray-600';

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full ${colorClass}`}>
      <Text as="span" size="xs" weight="medium" color="inherit">{label}</Text>
    </span>
  );
}

function DraftBadge() {
  const { t } = useTranslation();
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
      <Text as="span" size="xs" weight="medium" color="inherit">
        {t('admin.vacancies.table.draftBadge')}
      </Text>
    </span>
  );
}

function buildVacancyTitle(v: PatientVacancySummary): string {
  if (v.caseNumber != null && v.vacancyNumber != null) {
    return `CASO ${v.caseNumber}-${v.vacancyNumber}`;
  }
  return v.title ?? '—';
}

export function PatientVacanciesCard({
  vacancies,
  isLoading,
  error,
}: PatientVacanciesCardProps) {
  const { t } = useTranslation();

  return (
    <div
      data-testid="patient-vacancies-card"
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
    >
      <Heading level={2} as="h3" weight="semibold" color="primary">
        {t('admin.patients.detail.vacanciesCard.title')}
      </Heading>

      {isLoading && (
        <Text size="sm" color="secondary">{t('common.loading')}</Text>
      )}

      {error && !isLoading && (
        <Text size="sm" color="secondary" className="text-red-600">
          {t('admin.patients.detail.vacanciesCard.error')}
        </Text>
      )}

      {!isLoading && !error && vacancies.length === 0 && (
        <Text size="sm" color="muted">
          {t('admin.patients.detail.vacanciesCard.empty')}
        </Text>
      )}

      {!isLoading && !error && vacancies.length > 0 && (
        <ul className="flex flex-col gap-3">
          {vacancies.map((v) => (
            <li
              key={v.id}
              className="flex flex-col sm:flex-row sm:items-center gap-2 py-3 border-b border-gray-100 last:border-b-0"
            >
              <div className="flex-1 min-w-0">
                {(() => {
                  const code = buildVacancyTitle(v);
                  return (
                    <>
                      <Text size="sm" weight="semibold" color="primary" className="block">
                        {code}
                      </Text>
                      {v.title && v.title !== code && (
                        <Text size="xs" color="secondary" className="block truncate">
                          {v.title}
                        </Text>
                      )}
                    </>
                  );
                })()}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {v.isDraft && <DraftBadge />}
                <VacancyStatusBadgeInline status={v.status} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
