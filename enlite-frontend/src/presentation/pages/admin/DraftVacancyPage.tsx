import { useEffect, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowRight, Check, Eye, FileText } from 'lucide-react';
import { DetailSkeleton } from '@presentation/components/ui/skeletons';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { ContainerGate } from '@presentation/components/features/access';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { useVacancyDetail } from '@hooks/admin/useVacancyDetail';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { formatCaseNumber } from '@domain/value-objects/caseNumberFormat';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { FieldPair, FieldPairGrid } from '@presentation/components/features/admin/PatientDetail/FieldPairs';
import { DraftVacancyScheduleGrid } from '@presentation/components/features/admin/VacancyDetail/DraftVacancyScheduleGrid';
import {
  daysWithAttendanceCount,
  weeklyHoursFromSchedule,
  type NormalizedSchedule,
} from '@presentation/components/features/admin/VacancyDetail/draftVacancySchedule';
import {
  DRAFT_TODO_FIELDS,
  assertKnownLockedFields,
  missingDraftFieldsCount,
} from '@presentation/components/features/admin/VacancyDetail/draftVacancyFields';

/** `Date` no fuso `es-AR`, só dia+mês ("23 de septiembre") — o mesmo formato do protótipo v3. */
function formatDayMonth(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString('es-AR', { day: 'numeric', month: 'long' });
  } catch {
    return null;
  }
}

/** Data + hora, para "Última edición" (F27 — o dado liga de verdade na Fase 4). */
function formatDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleString('es-AR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

export default function DraftVacancyPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { vacancy, isLoading, error } = useVacancyDetail(id);

  const [patient, setPatient] = useState<PatientDetail | null>(null);

  useEffect(() => {
    const patientId = vacancy?.patient_id;
    if (!patientId) return;
    let cancelled = false;
    AdminApiService.getPatientById(patientId)
      .then((p) => {
        if (!cancelled) setPatient(p);
      })
      .catch(() => {
        // Resiliente de propósito: sem `patient_identity`/`patient_services:read` (ou erro de
        // rede) a tela ainda mostra o que a vaga sozinha tem — "Sin completar" cobre o resto.
        if (!cancelled) setPatient(null);
      });
    return () => {
      cancelled = true;
    };
  }, [vacancy?.patient_id]);

  const talentumGate = useActionGate('talentum', 'update');
  const vacancyWriteGate = useActionGate('vacancy', 'update');
  const canComplete = talentumGate.allowed && vacancyWriteGate.allowed;

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
  // arquivo não reconhece, falha alto — não silencioso.
  assertKnownLockedFields(vacancy.locked_fields);

  const emptyValue = t('admin.draftVacancy.emptyValue');
  const schedule = (vacancy.schedule ?? null) as NormalizedSchedule | null;
  const missing = missingDraftFieldsCount(vacancy);

  const service = patient?.contractedServices?.find((s) => s.id === vacancy.contracted_service_id) ?? null;
  const serviceLabel = service
    ? t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode)
    : null;
  const patientName = patient ? [patient.firstName, patient.lastName].filter(Boolean).join(' ') : null;
  // `patients.dependencyOptions` (SEVERE|VERY_SEVERE|MODERATE|MILD — CHECK de `patients`), não
  // `vacancyDetail.vacancyForm.dependencyOptions` (Leve/Moderado/Grave/Alto/Muy Grave em
  // português-livre, outro domínio de texto do wizard): o valor real de `dependency_level` é o
  // enum ALL_CAPS do paciente, e a `rawEnumLeakGuard` deste repo pega a tabela errada.
  const dependencyLabel = vacancy.dependency_level
    ? t(`admin.patients.dependencyOptions.${vacancy.dependency_level}`, vacancy.dependency_level)
    : null;

  const zoneCity = [vacancy.patient_zone, vacancy.patient_city].filter(Boolean).join(', ');
  const weeklyHours = weeklyHoursFromSchedule(schedule);
  const daysCount = daysWithAttendanceCount(schedule);
  const address = vacancy.patient_address_formatted ?? vacancy.patient_address_raw ?? null;
  const isDefaultSalary = vacancy.salary_text === 'A convenir';
  const createdLabel = formatDayMonth(vacancy.created_at);

  const titleService = serviceLabel ?? emptyValue;
  const titlePatient = patientName ?? emptyValue;

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
            {t('admin.draftVacancy.kicker', {
              case: formatCaseNumber(vacancy.case_number) ?? emptyValue,
              vacancy: vacancy.vacancy_number ?? emptyValue,
              date: createdLabel ?? emptyValue,
            })}
          </Text>
        </div>
        {/* `break-words` — nome/serviço vêm de dado real (patient) e podem ter uma palavra longa
            sem espaço; sem isso o h1 empurra a largura da tela em vez de quebrar (medido a
            400px com fixture sintética, 25/09). */}
        <Heading level={1} weight="semibold" color="primary" className="break-words">
          {t('admin.draftVacancy.title', { service: titleService, patient: titlePatient })}
        </Heading>
        <Text size="base" color="muted" className="break-words">
          {[
            zoneCity || emptyValue,
            t('admin.draftVacancy.subtitleSchedule', { days: daysCount, hours: weeklyHours }),
            t('admin.draftVacancy.subtitleProviders', { count: vacancy.providers_needed ?? 0 }),
          ].join(' · ')}
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
            {canComplete
              ? t('admin.draftVacancy.calloutBodyCanComplete')
              : t('admin.draftVacancy.calloutBodyReadOnly')}
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
          <section className="bg-white rounded-2xl border-2 border-gray-600 p-6 sm:p-7">
            <Heading level={2} weight="semibold" color="primary" className="mb-5">
              {t('admin.draftVacancy.knownTitle')}
            </Heading>
            <FieldPairGrid>
              <FieldPair
                label={t('admin.draftVacancy.fields.patient')}
                full
                value={
                  patientName ? (
                    <>
                      {patientName}
                      {dependencyLabel && (
                        <Text as="span" size="xs" color="muted" className="block font-normal">
                          {t('admin.draftVacancy.dependencyPrefix', { level: dependencyLabel })}
                        </Text>
                      )}
                    </>
                  ) : (
                    emptyValue
                  )
                }
              />
              <FieldPair label={t('admin.draftVacancy.fields.service')} value={serviceLabel ?? emptyValue} />
              <FieldPair
                label={t('admin.draftVacancy.fields.providersNeeded')}
                value={vacancy.providers_needed ?? emptyValue}
              />
              <FieldPair label={t('admin.draftVacancy.fields.address')} full value={address ?? emptyValue} />
              <div className="flex flex-col min-w-0 sm:col-span-2">
                <Text as="span" size="2xs" color="primary" className="uppercase tracking-wide">
                  {t('admin.draftVacancy.fields.schedule')}
                </Text>
                <div className="mt-1.5">
                  <DraftVacancyScheduleGrid schedule={schedule} />
                </div>
                <Text as="span" size="sm" weight="medium" color="muted" className="mt-1.5">
                  {schedule
                    ? t('admin.draftVacancy.subtitleSchedule', { days: daysCount, hours: weeklyHours })
                    : emptyValue}
                </Text>
              </div>
              <FieldPair
                label={t('admin.draftVacancy.fields.ageRange')}
                value={
                  vacancy.age_range_min != null && vacancy.age_range_max != null
                    ? t('admin.draftVacancy.ageRangeValue', {
                        min: vacancy.age_range_min,
                        max: vacancy.age_range_max,
                      })
                    : emptyValue
                }
              />
              <FieldPair
                label={t('admin.draftVacancy.fields.hourlyRate')}
                value={
                  vacancy.salary_text ? (
                    <>
                      {vacancy.salary_text}
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
              <FieldPair label={t('admin.draftVacancy.fields.publication')} value={createdLabel ?? emptyValue} />
            </FieldPairGrid>
            <Text size="xs" color="muted" className="mt-5 pt-4 border-t border-gray-600">
              {t('admin.draftVacancy.knownNote')}{' '}
              <a href={`/admin/patients/${vacancy.patient_id}`} className="underline">
                {t('admin.draftVacancy.knownNoteLink')}
              </a>
            </Text>
          </section>
        </ContainerGate>

        <ContainerGate resource="vacancy">
          <section className="bg-white rounded-2xl border-2 border-gray-600 p-6 sm:p-7">
            <Heading level={2} weight="semibold" color="primary" className="mb-5">
              {t('admin.draftVacancy.todoTitle')}{' '}
              <Text as="span" size="sm" color="tertiary" weight="normal">
                {t('admin.draftVacancy.todoCount', { count: missing })}
              </Text>
            </Heading>
            <ul className="flex flex-col">
              {DRAFT_TODO_FIELDS.map((field) => {
                const done = !field.isEmpty(vacancy);
                return (
                  <li
                    key={field.key}
                    className="flex items-center gap-3 py-2.5 border-b border-gray-600 last:border-b-0"
                  >
                    <span
                      className={
                        done
                          ? 'w-[18px] h-[18px] rounded-full bg-green-600 flex items-center justify-center shrink-0'
                          : 'w-[18px] h-[18px] rounded-full border-2 border-gray-600 shrink-0'
                      }
                    >
                      {done && <Check className="w-[11px] h-[11px] text-white" aria-hidden="true" />}
                    </span>
                    <Text as="span" size="sm" color={done ? 'muted' : 'secondary'}>
                      {t(`admin.draftVacancy.todo.${field.labelKey}`)}
                    </Text>
                    {field.asideKey && (
                      <Text as="span" size="xs" color="tertiary" className="ml-auto">
                        {t(`admin.draftVacancy.todo.${field.asideKey}`)}
                      </Text>
                    )}
                  </li>
                );
              })}
            </ul>
            <Text size="xs" color="muted" className="mt-5 pt-4 border-t border-gray-600">
              {t('admin.draftVacancy.todoThen')}
            </Text>
          </section>
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
