import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Eye, FileText } from 'lucide-react';
import { DetailSkeleton } from '@presentation/components/ui/skeletons';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { ContainerGate } from '@presentation/components/features/access';
import { useActionGate, useHasCell } from '@presentation/hooks/useCellAccess';
import { useVacancyDetail } from '@hooks/admin/useVacancyDetail';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { formatCaseNumber } from '@domain/value-objects/caseNumberFormat';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { DraftVacancyKnownCard } from '@presentation/components/features/admin/VacancyDetail/DraftVacancyKnownCard';
import { DraftVacancyTodoCard } from '@presentation/components/features/admin/VacancyDetail/DraftVacancyTodoCard';
import { formatDayMonth, formatDateTime } from '@presentation/components/features/admin/VacancyDetail/draftVacancyFormat';
import {
  daysWithAttendanceCount,
  weeklyHoursFromSchedule,
  type NormalizedSchedule,
} from '@presentation/components/features/admin/VacancyDetail/draftVacancySchedule';
import {
  assertKnownLockedFields,
  missingDraftFieldsCount,
} from '@presentation/components/features/admin/VacancyDetail/draftVacancyFields';

export default function DraftVacancyPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { vacancy, isLoading, error } = useVacancyDetail(id);

  // Só para achar o SERVIÇO contratado (`contracted_service_id` → `contractedServices`) — nome
  // e endereço do paciente já vêm no GET da vaga, filtrados por célula (achado #7 do gate
  // parcial 25/09: antes esta 2ª leitura também era a fonte do nome, e uma falha dela apagava
  // o nome em silêncio mesmo quando o GET da vaga já trazia).
  const [patient, setPatient] = useState<PatientDetail | null>(null);
  const [patientLoadFailed, setPatientLoadFailed] = useState(false);

  useEffect(() => {
    const patientId = vacancy?.patient_id;
    if (!patientId) return;
    let cancelled = false;
    setPatientLoadFailed(false);
    AdminApiService.getPatientById(patientId)
      .then((p) => {
        if (!cancelled) setPatient(p);
      })
      .catch((err) => {
        // Sem logger de frontend neste repo — mesmo molde de CreateVacancyPage.tsx
        // (`[Componente] o-que-falhou:`, err).
        console.error('[DraftVacancyPage] getPatientById failed:', err);
        if (!cancelled) {
          setPatient(null);
          setPatientLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [vacancy?.patient_id]);

  const talentumGate = useActionGate('talentum', 'update');
  const vacancyWriteGate = useActionGate('vacancy', 'update');
  const canComplete = talentumGate.allowed && vacancyWriteGate.allowed;

  // D181 (memória `container-e-a-fronteira-do-redesenho`): permissão ausente NUNCA pode
  // parecer "vazio" — o GET zera estes campos sem a célula (`patientInVacancyProjection.ts`,
  // backend), e a tela precisa saber QUE célula é essa para não confundir "não preenchido" com
  // "não posso ver" (achado #6 do gate parcial 25/09).
  const hasIdentityCell = useHasCell('patient_identity', 'read');
  const hasAddressCell = useHasCell('patient_address', 'read');
  const hasClinicalCell = useHasCell('patient_clinical', 'read');

  if (isLoading) return <DetailSkeleton />;

  if (error || !vacancy) {
    return (
      <div className="w-full min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <Heading level={3} color="inherit" className="text-red-600">
          {error ?? t('admin.vacancyDetail.notFound')}
        </Heading>
        <Button variant="outline" size="sm" onClick={() => navigate('/admin/vacancies')}>
          ← {t('admin.vacancyDetail.back')}
        </Button>
      </div>
    );
  }

  // O detalhe SÓ existe pra vaga que não é mais rascunho — o inverso do redirect que
  // `VacancyDetailPage` faz. As duas rotas nunca mostram a vaga "errada" (fase-2.md).
  if (vacancy.is_draft === false) {
    return <Navigate to={`/admin/vacancies/${id}`} replace />;
  }

  // Sabotagem de contrato (paridade #5): se o GET trouxer `locked_fields` com um nome que este
  // arquivo não reconhece, ACUSA (log), mas não derruba a tela pra todo mundo — achado #8 do
  // gate parcial 25/09 (antes lançava dentro do render → RouteErrorBoundary geral). A versão
  // pura continua lançando (`draftVacancyFields.test.ts`) — é só este call site que virou
  // resiliente, mesmo padrão do `patient` acima.
  try {
    assertKnownLockedFields(vacancy.locked_fields);
  } catch (err) {
    console.error('[DraftVacancyPage] assertKnownLockedFields:', err);
  }

  const emptyValue = t('admin.draftVacancy.emptyValue');
  const notVisible = t('admin.draftVacancy.notVisibleForRole');
  const schedule = (vacancy.schedule ?? null) as NormalizedSchedule | null;
  const missing = missingDraftFieldsCount(vacancy);

  const service = patient?.contractedServices?.find((s) => s.id === vacancy.contracted_service_id) ?? null;
  const serviceLabel = service
    ? t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode)
    : null;
  const serviceDisplayValue = patientLoadFailed ? t('admin.draftVacancy.patientLoadError') : (serviceLabel ?? emptyValue);

  // Nome vem do GET DA VAGA (`patient_first_name`/`patient_last_name`), já projetado pelo
  // backend por `patient_identity:read` (`projectPatientInVacancy.ts`) — não da 2ª leitura.
  const rawPatientName = [vacancy.patient_first_name, vacancy.patient_last_name].filter(Boolean).join(' ') || null;
  const patientDisplayName = !hasIdentityCell ? notVisible : (rawPatientName ?? emptyValue);

  // `patients.dependencyOptions` (SEVERE|VERY_SEVERE|MODERATE|MILD — CHECK de `patients`), não
  // `vacancyDetail.vacancyForm.dependencyOptions` (outro domínio, valores em português livre): o
  // valor real de `dependency_level` é o enum ALL_CAPS do paciente. Célula `patient_clinical`
  // (`patientInVacancyProjection.ts`) — sem ela a linha some, não vira "Sin completar".
  const dependencyLabel =
    hasClinicalCell && vacancy.dependency_level
      ? t(`admin.patients.dependencyOptions.${vacancy.dependency_level}`, vacancy.dependency_level)
      : null;
  const dependencyLine = dependencyLabel ? t('admin.draftVacancy.dependencyPrefix', { level: dependencyLabel }) : null;

  // Célula `patient_address` (`patientInVacancyProjection.ts`) — sem ela os 5 campos de endereço
  // (incl. zona/cidade) vêm `null` do backend INDEPENDENTE de estarem preenchidos ou não; por
  // isso o front não pode escrever "Sin completar" aqui — escreveria uma mentira sobre o dado.
  const rawZoneCity = [vacancy.patient_zone, vacancy.patient_city].filter(Boolean).join(', ') || null;
  const zoneCityDisplay = !hasAddressCell ? notVisible : (rawZoneCity ?? emptyValue);
  const rawAddress = vacancy.patient_address_formatted ?? vacancy.patient_address_raw ?? null;
  const addressDisplayValue = !hasAddressCell ? notVisible : (rawAddress ?? emptyValue);

  const weeklyHours = weeklyHoursFromSchedule(schedule);
  const daysCount = daysWithAttendanceCount(schedule);
  const isDefaultSalary = vacancy.salary_text === 'A convenir';
  const createdLabel = formatDayMonth(vacancy.created_at);

  const titleService = serviceDisplayValue;
  const titlePatient = patientDisplayName;

  const scheduleText = t('admin.draftVacancy.subtitleSchedule', { count: daysCount, hours: weeklyHours });
  const scheduleSummary = schedule ? scheduleText : emptyValue;

  // "Caso N" só entra quando existe case_number — sem ele, o kicker não deve dizer "Caso Sin
  // completar" (achado #5c do gate parcial 25/09).
  const caseNumberFormatted = formatCaseNumber(vacancy.case_number);
  const kickerParts = [
    caseNumberFormatted ? t('admin.draftVacancy.kickerCase', { case: caseNumberFormatted }) : null,
    t('admin.draftVacancy.kickerVacancy', { vacancy: vacancy.vacancy_number ?? emptyValue }),
    t('admin.draftVacancy.kickerDate', { date: createdLabel ?? emptyValue }),
  ].filter((p): p is string => Boolean(p));

  return (
    <PageContainer>
      <button
        type="button"
        onClick={() => navigate('/admin/vacancies')}
        className="flex items-center gap-1.5 text-gray-800 hover:text-primary transition-colors mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        <Text as="span" size="sm" weight="medium" color="inherit">
          {t('admin.draftVacancy.back')}
        </Text>
      </button>

      <header className="flex flex-col gap-1.5 mb-6 min-w-0">
        <div className="flex items-center gap-2.5 flex-wrap min-w-0">
          <span
            className="inline-flex items-center gap-1 bg-amber-100 text-amber-700 px-2.5 py-0.5 rounded-full shrink-0"
            data-testid={`vacancy-draft-badge-${id}`}
          >
            <FileText className="w-3 h-3" aria-hidden="true" />
            <Text as="span" size="xs" weight="medium" color="inherit">
              {t('admin.vacancies.table.draftBadge')}
            </Text>
          </span>
          <Text as="span" size="sm" color="muted" className="break-words min-w-0">
            {kickerParts.join(' · ')}
          </Text>
        </div>
        {/* `break-words` — nome/serviço vêm de dado real e podem ter uma palavra longa sem
            espaço; sem isso o h1 empurra a largura da tela em vez de quebrar (medido a 400px
            com fixture sintética, 25/09). */}
        <Heading level={1} weight="semibold" color="primary" className="break-words">
          {t('admin.draftVacancy.title', { service: titleService, patient: titlePatient })}
        </Heading>
        <Text size="base" color="muted" className="break-words">
          {[zoneCityDisplay, scheduleText, t('admin.draftVacancy.subtitleProviders', { count: vacancy.providers_needed ?? 0 })].join(
            ' · ',
          )}
        </Text>
      </header>

      <section
        className="bg-primary/5 rounded-2xl px-6 sm:px-8 py-6 flex items-center justify-between gap-6 flex-wrap mb-8"
        data-testid="draft-vacancy-callout"
      >
        <div className="flex-1 min-w-[260px]">
          <Heading level={3} weight="semibold" color="primary" className="mb-1">
            {canComplete
              ? t('admin.draftVacancy.calloutTitleCanComplete', { count: missing })
              : t('admin.draftVacancy.calloutTitleReadOnly')}
          </Heading>
          <Text size="sm" color="muted" className="max-w-[60ch]">
            {canComplete ? t('admin.draftVacancy.calloutBodyCanComplete') : t('admin.draftVacancy.calloutBodyReadOnly')}
          </Text>
        </div>
        {canComplete ? (
          <Button
            variant="primary"
            size="lg"
            data-testid="complete-vacancy-btn"
            onClick={() => navigate(`/admin/vacancies/${id}/edit`)}
          >
            {t('admin.vacancies.completeVacancy')}
            <ArrowRight className="w-4 h-4" />
          </Button>
        ) : (
          <div className="flex items-center gap-2 text-primary/70">
            <Eye className="w-[18px] h-[18px]" aria-hidden="true" />
            <Text as="span" size="sm" color="inherit">
              {t('admin.draftVacancy.readOnlyPill')}
            </Text>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <ContainerGate resource="vacancy">
          <DraftVacancyKnownCard
            patientDisplayName={patientDisplayName}
            dependencyLine={dependencyLine}
            serviceDisplayValue={serviceDisplayValue}
            providersNeeded={vacancy.providers_needed}
            emptyValue={emptyValue}
            addressDisplayValue={addressDisplayValue}
            schedule={schedule}
            scheduleSummary={scheduleSummary}
            ageRangeValue={
              vacancy.age_range_min != null && vacancy.age_range_max != null
                ? t('admin.draftVacancy.ageRangeValue', { min: vacancy.age_range_min, max: vacancy.age_range_max })
                : emptyValue
            }
            hourlyRateValue={vacancy.salary_text ?? null}
            isDefaultSalary={isDefaultSalary}
            publicationLabel={createdLabel ?? emptyValue}
            patientId={vacancy.patient_id}
          />
        </ContainerGate>

        <ContainerGate resource="vacancy">
          <DraftVacancyTodoCard vacancy={vacancy} missing={missing} />
        </ContainerGate>
      </div>

      <Text size="xs" color="tertiary" className="mt-6">
        {t('admin.draftVacancy.lastUpdated', { date: formatDateTime(vacancy.updated_at) ?? emptyValue })}
      </Text>

      {canComplete && (
        <div className="mt-6">
          <Button
            variant="primary"
            size="lg"
            data-testid="complete-vacancy-btn-footer"
            onClick={() => navigate(`/admin/vacancies/${id}/edit`)}
          >
            {t('admin.vacancies.completeVacancy')}
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </PageContainer>
  );
}
