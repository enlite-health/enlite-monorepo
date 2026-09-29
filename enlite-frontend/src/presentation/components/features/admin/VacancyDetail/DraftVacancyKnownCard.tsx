import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { DraftVacancyScheduleGrid } from './DraftVacancyScheduleGrid';
import type { NormalizedSchedule } from './draftVacancySchedule';
import type { PatientDiagnosisDetail } from '@domain/entities/PatientDetail';
import { diagnosisDisplayState } from '@domain/entities/diagnosisDisplay';

/**
 * Par rótulo/valor LOCAL a este card — não o `FieldPair` de `PatientDetail/FieldPairs.tsx`
 * (gate fecho 25/09, achado #5). Aquele componente fixa o valor em `color="muted"`, que no tema
 * é `#73737380` (49% de opacidade) por decisão do Gabriel PARA O CARD DELE (D291,
 * `peca-de-campo-por-largura-do-container`) — reusar aqui faria o valor "parecer desabilitado".
 * O protótipo v3 desta tela usa `--text: #374151` SÓLIDO para o valor
 * (`evidencias/prototipo-v3-2026-09-24.html`), que é exatamente o token `color="tertiary"` do
 * `Text` — nenhuma cor nova, só o token certo para ESTE protótipo. Rótulo idêntico ao D291
 * (11px caixa-alta `primary`), porque essa parte bate nos dois desenhos.
 */
function Pair({ label, value, full, aside }: { label: string; value: ReactNode; full?: boolean; aside?: ReactNode }) {
  return (
    <div className={`flex flex-col min-w-0${full ? ' sm:col-span-2' : ''}`}>
      <Text as="span" size="2xs" color="primary" className="uppercase tracking-wide">
        {label}
      </Text>
      <Text as="span" size="sm" weight="medium" color="tertiary" className="break-words">
        {value}
      </Text>
      {aside}
    </div>
  );
}

function PairGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3.5">{children}</div>;
}

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
  /** 2ª linha do endereço (zona/cidade), como o protótipo (`<small>Palermo, CABA</small>`) —
   *  `null` quando não há célula OU não há zona/cidade a mostrar (achado #5 do gate fecho). */
  addressZoneCityLine: string | null;
  schedule: NormalizedSchedule | null;
  scheduleSummary: string;
  ageRangeValue: string;
  hourlyRateValue: string | null;
  isDefaultSalary: boolean;
  publicationLabel: string;
  patientId: string | null;
  /** Patología estruturada do paciente (CID-11, lida na hora — nunca copiada para a vaga).
   *  `null` = ator sem a célula `patient_clinical:read` — distinto de `[]` (spec cid-na-vacante,
   *  mesmo contrato de `VacancyProfessionCard`/`VacancyFormLeftColumn`). */
  diagnoses: PatientDiagnosisDetail[] | null;
  /** Bulkhead (C4): catálogo de terminologia falhou ao ler — distinto de "sem diagnóstico". */
  diagnosesUnavailable: boolean;
}

export function DraftVacancyKnownCard({
  patientDisplayName,
  dependencyLine,
  serviceDisplayValue,
  providersNeeded,
  emptyValue,
  addressDisplayValue,
  addressZoneCityLine,
  schedule,
  scheduleSummary,
  ageRangeValue,
  hourlyRateValue,
  isDefaultSalary,
  publicationLabel,
  patientId,
  diagnoses,
  diagnosesUnavailable,
}: DraftVacancyKnownCardProps) {
  const { t } = useTranslation();

  return (
    <section className="bg-white rounded-card border-[2.5px] border-gray-400 p-6 sm:p-7">
      <Heading level={2} weight="semibold" color="primary" className="mb-5">
        {t('admin.draftVacancy.knownTitle')}
      </Heading>
      <PairGrid>
        <Pair
          label={t('admin.draftVacancy.fields.patient')}
          full
          value={patientDisplayName}
          aside={
            dependencyLine && (
              <Text as="span" size="xs" color="muted" className="block font-normal">
                {dependencyLine}
              </Text>
            )
          }
        />
        {/* Patología (spec cid-na-vacante): mesmo contrato de 3 estados de
            `VacancyProfessionCard`/`VacancyFormLeftColumn` — `diagnosisDisplayState` decide,
            este card só desenha. REQ-21: só o título, nunca código/grupo/release/uri do CID. */}
        <div className="flex flex-col min-w-0 sm:col-span-2">
          <Text as="span" size="2xs" color="primary" className="uppercase tracking-wide">
            {t('admin.patients.detail.diagnosisCard.patologies')}
          </Text>
          {(() => {
            const state = diagnosisDisplayState(diagnoses, diagnosesUnavailable);
            if (state.kind === 'unavailable') {
              return (
                <Text
                  as="span"
                  size="sm"
                  weight="medium"
                  className="!text-red-600 break-words"
                  data-testid="draft-vacancy-patologias-unavailable"
                >
                  {t('admin.patients.detail.diagnosisCard.patologiesUnavailable')}
                </Text>
              );
            }
            if (state.kind === 'noPermission') {
              return (
                <Text
                  as="span"
                  size="sm"
                  weight="medium"
                  color="secondary"
                  className="break-words"
                  data-testid="draft-vacancy-patologias-no-permission"
                >
                  {t('admin.patients.detail.diagnosisCard.patologiesNoPermission')}
                </Text>
              );
            }
            if (state.kind === 'empty') {
              return (
                <Text
                  as="span"
                  size="sm"
                  weight="medium"
                  color="tertiary"
                  data-testid="draft-vacancy-patologias-empty"
                >
                  —
                </Text>
              );
            }
            return (
              <Text
                as="span"
                size="sm"
                weight="medium"
                color="tertiary"
                className="break-words"
                data-testid="draft-vacancy-patologias"
              >
                {state.diagnoses.map((d) => d.title).join(', ')}
              </Text>
            );
          })()}
        </div>
        <Pair label={t('admin.draftVacancy.fields.service')} value={serviceDisplayValue} />
        <Pair label={t('admin.draftVacancy.fields.providersNeeded')} value={providersNeeded ?? emptyValue} />
        <Pair
          label={t('admin.draftVacancy.fields.address')}
          full
          value={addressDisplayValue}
          aside={
            addressZoneCityLine && (
              <Text as="span" size="xs" color="muted" className="block font-normal">
                {addressZoneCityLine}
              </Text>
            )
          }
        />
        <div className="flex flex-col min-w-0 sm:col-span-2">
          <Text as="span" size="2xs" color="primary" className="uppercase tracking-wide">
            {t('admin.draftVacancy.fields.schedule')}
          </Text>
          <div className="mt-1.5">
            <DraftVacancyScheduleGrid schedule={schedule} />
          </div>
          <Text as="span" size="sm" weight="medium" color="tertiary" className="mt-1.5">
            {scheduleSummary}
          </Text>
        </div>
        <Pair label={t('admin.draftVacancy.fields.ageRange')} value={ageRangeValue} />
        <Pair
          label={t('admin.draftVacancy.fields.hourlyRate')}
          value={hourlyRateValue ?? emptyValue}
          aside={
            hourlyRateValue &&
            isDefaultSalary && (
              <Text as="span" size="xs" color="muted" className="block font-normal">
                {t('admin.draftVacancy.defaultValueHint')}
              </Text>
            )
          }
        />
        <Pair label={t('admin.draftVacancy.fields.publication')} value={publicationLabel} />
      </PairGrid>
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
