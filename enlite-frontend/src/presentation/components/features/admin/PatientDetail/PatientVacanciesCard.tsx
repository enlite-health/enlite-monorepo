import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { PatientVacancySummary } from '@domain/entities/PatientDetail';
import { formatVacancyCase } from '@domain/value-objects/caseNumberFormat';
import { VacancyLifecycleBadge } from '@presentation/components/atoms/VacancyLifecycleBadge';
import { PatientStatusPill } from '@presentation/components/atoms/PatientStatusPill';

interface PatientVacanciesCardProps {
  patientId: string;
  vacancies: PatientVacancySummary[];
  isLoading: boolean;
  error: string | null;
}

/** Spec 047 (F4): o código é `formatVacancyCase` — o MESMO dono da coluna "Código de la vacante" da tabela de serviços. */
function buildVacancyTitle(v: PatientVacancySummary): string {
  if (v.caseNumber != null) return formatVacancyCase(v.caseNumber, v.caseOrdinal);
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
                      <Text size="sm" weight="semibold" color="primary" className="block" data-testid={`patient-vacancy-code-${v.id}`}>
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
                <PatientStatusPill status={v.patientStatus} />
                <VacancyLifecycleBadge lifecycle={v.lifecycle} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
