import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import { DetailSkeleton } from '@presentation/components/ui/skeletons';
import { Typography } from '@presentation/components/atoms/Typography';
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
import { VacancyFormModal } from '@presentation/components/features/admin/VacancyFormModal';
import { VacancyPrescreeningConfig } from '@presentation/components/features/admin/VacancyDetail/VacancyPrescreeningConfig';
import { VacancyTalentumCard } from '@presentation/components/features/admin/VacancyDetail/VacancyTalentumCard';
import { VacancyDetailTabs, type VacancyTab } from '@presentation/components/features/admin/VacancyDetail/VacancyDetailTabs';

export default function VacancyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { vacancy, isLoading, error, refetch } = useVacancyDetail(id);
  const [showEditModal, setShowEditModal] = useState(false);
  const [activeTab, setActiveTab] = useState<VacancyTab>('encuadres');

  if (isLoading) return <DetailSkeleton />;

  if (error || !vacancy) {
    return (
      <div className="w-full min-h-screen bg-background flex flex-col items-center justify-center gap-4">
        <Typography variant="h3" className="text-red-600">
          {error ?? t('admin.vacancyDetail.notFound')}
        </Typography>
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
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/admin/vacancies')}
            className="flex items-center gap-1 text-gray-800 hover:text-primary transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <Typography variant="body" weight="medium" className="text-inherit">
              {t('admin.vacancyDetail.back')}
            </Typography>
          </button>
          <ChevronRight className="w-4 h-4 text-gray-600" />
          <Typography variant="h1" weight="semibold" className="text-gray-800 font-poppins text-2xl">
            {pageTitle}
          </Typography>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            onClick={() => navigate(`/admin/vacancies/${id}/match`)}
            className="flex items-center gap-2 px-5"
          >
            {t('admin.vacancyDetail.viewMatch')}
          </Button>
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
          />
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
          onEdit={() => setShowEditModal(true)}
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
      />

      {/* TODO TD-XXX: Estado de Busca (candidatos summary) — próximo PR */}

      {/* Tabs */}
      <div className="mb-6">
        <VacancyDetailTabs activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {/* Tab content */}
      {activeTab === 'encuadres' && (
        <div className="mb-6">
          <VacancyFunnelView vacancyId={id!} />
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
            <Typography variant="h3" weight="semibold" className="text-gray-800">
              {t('admin.vacancyDetail.publications.title')}
            </Typography>
            {publications.length === 0 ? (
              <Typography variant="body" className="text-gray-800">
                {t('admin.vacancyDetail.publications.noPublications')}
              </Typography>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-300 text-gray-800">
                      <th className="text-left px-3 py-2 font-medium rounded-tl-lg">
                        {t('admin.vacancyDetail.publications.channel')}
                      </th>
                      <th className="text-left px-3 py-2 font-medium">
                        {t('admin.vacancyDetail.publications.date')}
                      </th>
                      <th className="text-left px-3 py-2 font-medium rounded-tr-lg">
                        {t('admin.vacancyDetail.publications.recruiter')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {publications.map((pub, i) => (
                      <tr key={i} className="border-b border-gray-600 last:border-0">
                        <td className="px-3 py-2">{pub.channel ?? '—'}</td>
                        <td className="px-3 py-2">
                          {pub.published_at
                            ? new Date(pub.published_at).toLocaleDateString('es-AR')
                            : '—'}
                        </td>
                        <td className="px-3 py-2">{pub.recruiter ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
              onSaved={refetch}
            />
          </div>
        </>
      )}

      {vacancy && (
        <VacancyFormModal
          isOpen={showEditModal}
          onClose={() => setShowEditModal(false)}
          onSuccess={() => {
            setShowEditModal(false);
            refetch();
          }}
          vacancy={vacancy}
        />
      )}
    </PageContainer>
  );
}
