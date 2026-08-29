import { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { DetailSkeleton } from '@presentation/components/ui/skeletons';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';
import { Button } from '@presentation/components/atoms/Button';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { useVacancyDetail } from '@hooks/admin/useVacancyDetail';
import { VacancyCaseCard } from '@presentation/components/features/admin/VacancyDetail/VacancyCaseCard';
import { VacancyPatientCard } from '@presentation/components/features/admin/VacancyDetail/VacancyPatientCard';
import { VacancyProfessionCard } from '@presentation/components/features/admin/VacancyDetail/VacancyProfessionCard';
import { VacancyMeetLinksRow } from '@presentation/components/features/admin/VacancyDetail/VacancyMeetLinksRow';
import { VacancyFunnelView } from '@presentation/components/features/admin/VacancyDetail/Funnel/VacancyFunnelView';
import { VacancyMeetLinksCard } from '@presentation/components/features/admin/VacancyDetail/VacancyMeetLinksCard';
import { VacancySocialLinksCard } from '@presentation/components/features/admin/VacancyDetail/VacancySocialLinksCard';
import { VacancyScheduleEditModal } from '@presentation/components/features/admin/VacancyDetail/VacancyScheduleEditModal';
import { VacancyDescriptionEditModal } from '@presentation/components/features/admin/VacancyDetail/VacancyDescriptionEditModal';
import type { EditableVacancyStatus } from '@presentation/components/features/admin/VacancyDetail/VacancyStatusEditor';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { VacancyPrescreeningConfig } from '@presentation/components/features/admin/VacancyDetail/VacancyPrescreeningConfig';
import { VacancyTalentumCard } from '@presentation/components/features/admin/VacancyDetail/VacancyTalentumCard';
import { VacancyDetailTabs, type VacancyTab } from '@presentation/components/features/admin/VacancyDetail/VacancyDetailTabs';

export default function VacancyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { t } = useTranslation();
  const { vacancy, isLoading, error, refetch } = useVacancyDetail(id);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showDescriptionModal, setShowDescriptionModal] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<VacancyTab>('encuadres');
  const [showPublishedRedirectBanner, setShowPublishedRedirectBanner] = useState(false);

  // Operador foi redirecionado pra cá pelo VacancyFormSection após receber 403 do PUT
  // (vaga já publicada). Mostra banner amigável + limpa o state pra não persistir num refresh.
  useEffect(() => {
    const state = location.state as { publishedVacancyRedirect?: boolean } | null;
    if (state?.publishedVacancyRedirect) {
      setShowPublishedRedirectBanner(true);
      window.history.replaceState({}, '');
    }
  }, [location.state]);

  const handleStatusChange = async (next: EditableVacancyStatus): Promise<void> => {
    if (!id) return;
    setStatusError(null);
    setStatusSaving(true);
    try {
      await AdminApiService.updateVacancy(id, { status: next });
      await refetch();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusError(msg);
    } finally {
      setStatusSaving(false);
    }
  };

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

  const patientName = [vacancy.patient_first_name, vacancy.patient_last_name]
    .filter(Boolean)
    .join(' ');

  const pageTitle =
    vacancy.case_number != null && vacancy.vacancy_number != null
      ? `${t('admin.vacancyDetail.case')} ${vacancy.case_number}-${vacancy.vacancy_number}${patientName ? ` — ${patientName}` : ''}`
      : vacancy.case_number != null
        ? `${t('admin.vacancyDetail.case')} ${vacancy.case_number}${patientName ? ` — ${patientName}` : ''}`
        : vacancy.title ?? t('admin.vacancyDetail.vacancy');

  const publications: Array<{
    channel: string | null;
    published_at: string | null;
    recruiter: string | null;
  }> = vacancy.publications ?? [];

  return (
    <PageContainer>
      {/* Banner: operador foi redirecionado do form de edição completa porque a vaga
          já saiu do rascunho. Edição localizada (lápis em "Días y Horarios" + dropdown
          do status badge) é o caminho correto a partir daqui. */}
      {showPublishedRedirectBanner && (
        <div
          className="mb-6 bg-amber-50 border border-amber-300 rounded-xl px-5 py-4 flex items-start justify-between gap-4"
          data-testid="published-redirect-banner"
        >
          <Text size="sm" color="inherit" className="text-amber-900">
            {t('admin.vacancyDetail.publishedRedirectBanner')}
          </Text>
          <button
            type="button"
            onClick={() => setShowPublishedRedirectBanner(false)}
            className="text-amber-700 hover:text-amber-900 transition-colors shrink-0"
            aria-label={t('admin.vacancyDetail.dismissBanner')}
            data-testid="published-redirect-banner-dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/admin/vacancies')}
            className="flex items-center gap-1 text-gray-800 hover:text-primary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <Text as="span" size="sm" weight="medium" color="inherit">
              {t('admin.vacancyDetail.back')}
            </Text>
          </button>
          <ChevronRight className="w-4 h-4 text-gray-600" />
          <Heading level={1} weight="semibold" color="secondary">
            {pageTitle}
          </Heading>
        </div>
      </div>

      {/* Linha 1: assimétrica — coluna esquerda fixa 404px, direita flex-1 */}
      <div className="grid grid-cols-1 lg:grid-cols-[404px_1fr] gap-5 mb-5">
        <div className="flex flex-col gap-5">
          <VacancyCaseCard
            status={vacancy.status ?? '—'}
            caseNumber={vacancy.case_number ?? null}
            dependencyLevel={vacancy.dependency_level ?? null}
            profession={
              vacancy.required_professions?.length
                ? vacancy.required_professions[0]
                : null
            }
            sex={vacancy.required_sex ?? null}
            zone={vacancy.patient_zone ?? null}
            patientCity={vacancy.patient_city ?? vacancy.city ?? null}
            patientNeighborhood={vacancy.patient_neighborhood ?? null}
            paymentTermDays={vacancy.payment_term_days ?? null}
            netHourlyRate={vacancy.net_hourly_rate ?? null}
            weeklyHours={vacancy.weekly_hours ?? null}
            providersNeeded={vacancy.providers_needed ?? null}
            publishedAt={vacancy.created_at ?? null}
            closedAt={vacancy.closed_at ?? null}
            onStatusChange={handleStatusChange}
            isStatusSaving={statusSaving}
          />
          {statusError && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2">
              <Text size="sm" color="inherit" className="text-red-600">
                {statusError}
              </Text>
            </div>
          )}
          <VacancyPatientCard
            firstName={vacancy.patient_first_name ?? null}
            lastName={vacancy.patient_last_name ?? null}
            diagnosis={vacancy.patient_diagnosis ?? null}
            zone={vacancy.patient_zone ?? null}
            insuranceVerified={vacancy.insurance_verified ?? null}
          />
        </div>

        <VacancyProfessionCard
          profession={
            vacancy.required_professions?.length
              ? vacancy.required_professions[0]
              : null
          }
          requiredSex={vacancy.required_sex ?? null}
          diagnosis={vacancy.patient_diagnosis ?? null}
          talentumDescription={vacancy.talentum_description ?? null}
          ageRangeMin={vacancy.age_range_min ?? null}
          ageRangeMax={vacancy.age_range_max ?? null}
          zone={vacancy.patient_zone ?? null}
          workerAttributes={vacancy.worker_attributes ?? null}
          serviceType={vacancy.service_type ?? null}
          schedule={vacancy.schedule ?? null}
          onEditSchedule={() => setShowScheduleModal(true)}
          onEditDescription={() => setShowDescriptionModal(true)}
        />
      </div>

      {/* Meet links row (renders nothing when no slots filled) */}
      <VacancyMeetLinksRow
        meetLink1={vacancy.meet_link_1 ?? null}
        meetDatetime1={vacancy.meet_datetime_1 ?? null}
        meetLink2={vacancy.meet_link_2 ?? null}
        meetDatetime2={vacancy.meet_datetime_2 ?? null}
        meetLink3={vacancy.meet_link_3 ?? null}
        meetDatetime3={vacancy.meet_datetime_3 ?? null}
        recurringWeekday={vacancy.meet_recurring_weekday ?? null}
        recurringTime={vacancy.meet_recurring_time ?? null}
        recurringLink={vacancy.meet_recurring_link ?? null}
      />

      {/* TODO TD-XXX: Estado de Busca (candidatos summary) — próximo PR */}

      {/* Tabs */}
      <div className="mb-6">
        <VacancyDetailTabs activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {/* Tab content */}
      {activeTab === 'encuadres' && (
        <div className="mb-6">
          <VacancyFunnelView vacancyId={id!} vacancy={vacancy} />
        </div>
      )}

      {activeTab === 'talentum' && (
        <>
          <div className="mb-6">
            <VacancyPrescreeningConfig
              vacancyId={id!}
              isPublished={!!vacancy.talentum_project_id}
            />
          </div>
          <div className="mb-6">
            <VacancyTalentumCard
              vacancyId={id!}
              talentumProjectId={vacancy.talentum_project_id ?? null}
              talentumWhatsappUrl={vacancy.talentum_whatsapp_url ?? null}
              talentumSlug={vacancy.talentum_slug ?? null}
              talentumPublishedAt={vacancy.talentum_published_at ?? null}
              talentumDescription={vacancy.talentum_description ?? null}
              onRefresh={refetch}
            />
          </div>
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
            <Heading level={3} weight="semibold" color="secondary">
              {t('admin.vacancyDetail.publications.title')}
            </Heading>
            {publications.length === 0 ? (
              <Text size="sm" color="secondary">
                {t('admin.vacancyDetail.publications.noPublications')}
              </Text>
            ) : (
              <Table>
                <TableHeader>
                  <TableHead>{t('admin.vacancyDetail.publications.channel')}</TableHead>
                  <TableHead>{t('admin.vacancyDetail.publications.date')}</TableHead>
                  <TableHead>{t('admin.vacancyDetail.publications.recruiter')}</TableHead>
                </TableHeader>
                <TableBody>
                  {publications.map((pub, i) => (
                    <TableRow key={i}>
                      <TableCell>{pub.channel ?? '—'}</TableCell>
                      <TableCell>
                        {pub.published_at
                          ? new Date(pub.published_at).toLocaleDateString('es-AR')
                          : '—'}
                      </TableCell>
                      <TableCell>{pub.recruiter ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </>
      )}

      {activeTab === 'links' && (
        <>
          <div className="mb-6">
            <VacancySocialLinksCard
              vacancyId={id!}
              caseNumber={vacancy.case_number ?? null}
              vacancyNumber={vacancy.vacancy_number ?? null}
              socialShortLinks={vacancy.social_short_links ?? null}
              onRefresh={refetch}
            />
          </div>
          <div className="mb-6">
            <VacancyMeetLinksCard
              vacancyId={id!}
              meetLink1={vacancy.meet_link_1 ?? null}
              meetDatetime1={vacancy.meet_datetime_1 ?? null}
              meetLink2={vacancy.meet_link_2 ?? null}
              meetDatetime2={vacancy.meet_datetime_2 ?? null}
              meetLink3={vacancy.meet_link_3 ?? null}
              meetDatetime3={vacancy.meet_datetime_3 ?? null}
              recurringWeekday={vacancy.meet_recurring_weekday ?? null}
              recurringTime={vacancy.meet_recurring_time ?? null}
              recurringLink={vacancy.meet_recurring_link ?? null}
              onSaved={refetch}
            />
          </div>
        </>
      )}

      {vacancy && id && (
        <VacancyScheduleEditModal
          isOpen={showScheduleModal}
          vacancyId={id}
          vacancy={vacancy}
          onClose={() => setShowScheduleModal(false)}
          onSuccess={() => {
            setShowScheduleModal(false);
            refetch();
          }}
        />
      )}

      {vacancy && id && (
        <VacancyDescriptionEditModal
          isOpen={showDescriptionModal}
          vacancyId={id}
          currentDescription={vacancy.talentum_description ?? null}
          onClose={() => setShowDescriptionModal(false)}
          onSuccess={() => {
            setShowDescriptionModal(false);
            refetch();
          }}
        />
      )}
    </PageContainer>
  );
}
