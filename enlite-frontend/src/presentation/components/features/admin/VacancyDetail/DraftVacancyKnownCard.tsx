import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { FieldPair, FieldPairGrid } from '@presentation/components/features/admin/PatientDetail/FieldPairs';
import { DraftVacancyScheduleGrid } from './DraftVacancyScheduleGrid';
import type { NormalizedSchedule } from './draftVacancySchedule';

/**
 * "Lo que ya sabemos" (protótipo v3, F24) — extraído de `DraftVacancyPage.tsx` (gate parcial
 * 25/09, achado #10). Só apresenta: os valores já vêm resolvidos da página (nome/endereço já
 * passaram pela checagem de célula — D181, achado #6 — e o "Sin completar" default já foi
 * decidido lá). Nenhum destes campos é editável; é por isso que a página não usa `input`.
 */
interface DraftVacancyKnownCardProps {
  patientDisplayName: string;
  dependencyLine: string | null;
  serviceDisplayValue: string;
  providersNeeded: number | null;
  emptyValue: string;
  addressDisplayValue: string;
  schedule: NormalizedSchedule | null;
  scheduleSummary: string;
  ageRangeValue: string;
  hourlyRateValue: string | null;
  isDefaultSalary: boolean;
  publicationLabel: string;
  patientId: string | null;
}

export function DraftVacancyKnownCard({
  patientDisplayName,
  dependencyLine,
  serviceDisplayValue,
  providersNeeded,
  emptyValue,
  addressDisplayValue,
  schedule,
  scheduleSummary,
  ageRangeValue,
  hourlyRateValue,
  isDefaultSalary,
  publicationLabel,
  patientId,
}: DraftVacancyKnownCardProps) {
  const { t } = useTranslation();

  return (
    <section className="bg-white rounded-2xl border-2 border-gray-600 p-6 sm:p-7">
      <Heading level={2} weight="semibold" color="primary" className="mb-5">
        {t('admin.draftVacancy.knownTitle')}
      </Heading>
      <FieldPairGrid>
        <FieldPair
          label={t('admin.draftVacancy.fields.patient')}
          full
          value={
            <>
              {patientDisplayName}
              {dependencyLine && (
                <Text as="span" size="xs" color="muted" className="block font-normal">
                  {dependencyLine}
                </Text>
              )}
            </>
          }
        />
        <FieldPair label={t('admin.draftVacancy.fields.service')} value={serviceDisplayValue} />
        <FieldPair label={t('admin.draftVacancy.fields.providersNeeded')} value={providersNeeded ?? emptyValue} />
        <FieldPair label={t('admin.draftVacancy.fields.address')} full value={addressDisplayValue} />
        <div className="flex flex-col min-w-0 sm:col-span-2">
          <Text as="span" size="2xs" color="primary" className="uppercase tracking-wide">
            {t('admin.draftVacancy.fields.schedule')}
          </Text>
          <div className="mt-1.5">
            <DraftVacancyScheduleGrid schedule={schedule} />
          </div>
          <Text as="span" size="sm" weight="medium" color="muted" className="mt-1.5">
            {scheduleSummary}
          </Text>
        </div>
        <FieldPair label={t('admin.draftVacancy.fields.ageRange')} value={ageRangeValue} />
        <FieldPair
          label={t('admin.draftVacancy.fields.hourlyRate')}
          value={
            hourlyRateValue ? (
              <>
                {hourlyRateValue}
                {isDefaultSalary && (
                  <Text as="span" size="xs" color="muted" className="block font-normal">
                    {t('admin.draftVacancy.defaultValueHint')}
                  </Text>
                )}
              </>
            ) : (
              emptyValue
            )
          }
        />
        <FieldPair label={t('admin.draftVacancy.fields.publication')} value={publicationLabel} />
      </FieldPairGrid>
      <Text size="xs" color="muted" className="mt-5 pt-4 border-t border-gray-600">
        {t('admin.draftVacancy.knownNote')}{' '}
        {patientId && (
          <Link to={`/admin/patients/${patientId}`} className="underline">
            {t('admin.draftVacancy.knownNoteLink')}
          </Link>
        )}
      </Text>
    </section>
  );
}
