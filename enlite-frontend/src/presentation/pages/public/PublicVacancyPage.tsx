import { useState, useEffect } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MapPin, CheckCircle2, Briefcase } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { PublicApiService, VacancyNotFoundError } from '@infrastructure/http/PublicApiService';
import { WorkerApiService } from '@infrastructure/http/WorkerApiService';
import { useAuth } from '@presentation/hooks/useAuth';
import { usePostularseAction } from '@presentation/hooks/usePostularseAction';
import { ScheduleSection } from './components/ScheduleSection';
import { UnauthenticatedModal } from './components/UnauthenticatedModal';
import { IncompleteRegistrationModal } from './components/IncompleteRegistrationModal';
import type { PublicVacancyDetail } from '@domain/entities/Vacancy';

const VALID_UTM_SOURCES = new Set(['facebook', 'instagram', 'whatsapp', 'linkedin', 'site']);

function normalizeUtmSource(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === 'portal_jobs') return 'site';
  return lower;
}

// ── Sub-components ──────────────────────────────────────────────────────────

function VacancyCaseCard({
  vacancy,
  onPostularse,
  isLoading,
}: {
  vacancy: PublicVacancyDetail;
  onPostularse: () => void;
  isLoading: boolean;
}) {
  const { t } = useTranslation();
  const statusLabel =
    vacancy.status === 'BUSQUEDA' ? t('publicVacancy.statusActive') : vacancy.status;

  return (
    <div className="bg-white border-[2.5px] border-[#eceff1] rounded-card overflow-hidden w-full lg:w-96 shrink-0">
      {/* Imagem placeholder — 240px como no Figma */}
      <div className="h-60 bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center">
        <Briefcase className="w-16 h-16 text-primary/20" />
      </div>

      <div className="px-8 py-6 flex flex-col gap-5">
        {/* Título + Status badge */}
        <div className="flex items-center justify-between w-full">
          <p className="font-poppins font-semibold text-2xl leading-[1.3] text-[#737373]">
            {vacancy.case_number != null
              ? `CASO ${vacancy.case_number}-${vacancy.vacancy_number}`
              : `CASO ${vacancy.vacancy_number}`}
          </p>
          <span className="bg-blue-yonder text-white text-sm font-poppins font-medium px-6 py-1 rounded">
            {statusLabel}
          </span>
        </div>

        {/* Descrição curta (título da vaga) */}
        <p className="font-lexend font-medium text-sm leading-[1.4] text-[#737373]">
          {vacancy.title}
        </p>

        {/* Endereço */}
        {vacancy.patient_zone && (
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-[#737373] shrink-0" />
            <span className="font-lexend font-medium text-sm leading-[1.4] text-[#737373]">
              {vacancy.patient_zone}
            </span>
          </div>
        )}

        {/* Botão Postularse */}
        <Button
          variant="primary"
          size="sm"
          className="w-full"
          onClick={onPostularse}
          isLoading={isLoading}
          disabled={!vacancy.talentum_whatsapp_url}
        >
          {t('publicVacancy.postularse')}
        </Button>

        {/* Mensagem quando postulação indisponível */}
        {!vacancy.talentum_whatsapp_url && (
          <p className="text-xs text-gray-500 text-center">
            {t('publicVacancy.postularseUnavailable')}
          </p>
        )}
      </div>
    </div>
  );
}

function VacancyDetailsCard({
  vacancy,
}: {
  vacancy: PublicVacancyDetail;
}) {
  const { t } = useTranslation();

  return (
    <div className="bg-white border-[2.5px] border-[#eceff1] rounded-card overflow-hidden flex-1 px-8 py-8">
      <div className="flex flex-col gap-6">
        {/* Header: título */}
        <div className="flex items-center justify-between">
          <p className="font-poppins font-semibold text-2xl leading-[1.3] text-primary">
            {t('publicVacancy.therapeuticCompanions')}
          </p>
        </div>

        {/* Indicações: disponível para + hipótese diagnóstica */}
        <div className="flex flex-col gap-3">
          {vacancy.required_sex && (
            <p className="font-lexend font-medium text-sm leading-[1.4] text-[#737373]">
              {t('publicVacancy.availableFor')}{' '}
              <span className="text-primary font-medium">
                {t(`publicVacancy.sexLabels.${vacancy.required_sex}`, vacancy.required_sex)}
              </span>
            </p>
          )}
        </div>

        {/* Descrição do trabalho */}
        {vacancy.talentum_description && (
          <div className="flex flex-col gap-2">
            <p className="font-lexend font-medium text-base leading-[1.35] text-primary">
              {t('publicVacancy.jobDescription')}
            </p>
            <p className="font-lexend font-medium text-sm leading-[1.4] text-[#737373] whitespace-pre-line">
              {vacancy.talentum_description}
            </p>
          </div>
        )}

        {/* Características */}
        <div className="flex flex-col gap-2">
          <p className="font-lexend font-medium text-base leading-[1.35] text-primary">
            {t('publicVacancy.characteristics')}
          </p>
          <div className="flex flex-col gap-2.5">
            {(vacancy.age_range_min != null || vacancy.age_range_max != null) && (
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                <p className="font-lexend font-medium text-sm leading-[1.4] text-[#737373]">
                  {t('publicVacancy.ageRange')}{' '}
                  <span className="text-primary">
                    {vacancy.age_range_min != null && vacancy.age_range_max != null
                      ? `${vacancy.age_range_min} - ${vacancy.age_range_max}`
                      : vacancy.age_range_min ?? vacancy.age_range_max}
                  </span>
                </p>
              </div>
            )}
            {vacancy.patient_zone && (
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                <p className="font-lexend font-medium text-sm leading-[1.4] text-[#737373]">
                  {t('publicVacancy.location')}{' '}
                  <span className="text-primary">{vacancy.patient_zone}</span>
                </p>
              </div>
            )}
            {vacancy.worker_attributes && (
              <div className="flex items-start gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-primary shrink-0 mt-1" />
                <p className="font-lexend font-medium text-sm leading-[1.4] text-[#737373]">
                  {t('publicVacancy.profile')}{' '}
                  <span className="text-primary">{vacancy.worker_attributes}</span>
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Horários */}
        {vacancy.schedule && Object.keys(vacancy.schedule).length > 0 && (
          <ScheduleSection schedule={vacancy.schedule} />
        )}
      </div>
    </div>
  );
}

function VacancySkeleton() {
  return (
    <div className="animate-pulse flex flex-col lg:flex-row gap-6">
      <div className="bg-gray-300 rounded-card w-full lg:w-96 h-[573px]" />
      <div className="bg-gray-300 rounded-card flex-1 h-[764px]" />
    </div>
  );
}

function VacancyNotFound() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-20">
      <p className="font-poppins font-semibold text-2xl text-primary mb-4">
        {t('publicVacancy.notFound.title')}
      </p>
      <p className="font-lexend text-sm text-[#737373] mb-6">
        {t('publicVacancy.notFound.body')}
      </p>
      <Link to="/" className="text-primary underline font-lexend text-sm">
        {t('publicVacancy.notFound.backHome')}
      </Link>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function PublicVacancyPage() {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const { t } = useTranslation();
  const { isAuthenticated } = useAuth();
  const [vacancy, setVacancy] = useState<PublicVacancyDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isNotFound, setIsNotFound] = useState(false);

  const { state, missingFields, postularse, dismissModal, confirmRegister } = usePostularseAction(
    vacancy?.talentum_whatsapp_url ?? null,
    vacancy?.id ?? null,
  );

  // Capture UTM source and store return URL for post-registration redirect
  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const rawSource = searchParams.get('utm_source');
    if (rawSource) {
      const normalized = normalizeUtmSource(rawSource);
      if (VALID_UTM_SOURCES.has(normalized)) {
        sessionStorage.setItem('enlite_utm_source', normalized);
      }
    }
    sessionStorage.setItem('enlite_vacancy_return_url', location.pathname);
  }, [location.pathname, location.search]);

  // Track acquisition channel on page load (creates encuadre for Kanban INITIATED).
  // Fires as soon as the worker is authenticated and vacancy is loaded — no need to wait for Postularse.
  useEffect(() => {
    if (!vacancy?.id || !isAuthenticated) return;
    const channel = sessionStorage.getItem('enlite_utm_source');
    if (!channel) return;

    WorkerApiService.trackAcquisitionChannel(vacancy.id, channel)
      .then(() => sessionStorage.removeItem('enlite_utm_source'))
      .catch((err) => console.warn('[PublicVacancyPage] trackChannel failed:', err));
  }, [vacancy?.id, isAuthenticated]);

  useEffect(() => {
    if (!id) return;
    setIsLoading(true);
    PublicApiService.getVacancy(id)
      .then(setVacancy)
      .catch((err) => {
        if (err instanceof VacancyNotFoundError) setIsNotFound(true);
      })
      .finally(() => setIsLoading(false));
  }, [id]);

  return (
    <div className="min-h-screen bg-background">
      {/* Navbar — Poppins SemiBold 24px como no Figma */}
      <header className="flex items-center justify-between px-6 lg:px-[120px] py-8">
        <p className="font-poppins font-semibold text-2xl leading-[1.3] text-primary">
          {vacancy
            ? `${t('publicVacancy.vacante')}: ${vacancy.title}`
            : t('publicVacancy.vacante')}
        </p>
        {vacancy?.country && (
          <div className="hidden md:inline-flex items-center gap-2 shrink-0">
            <img
              className="w-7 h-5 object-cover"
              alt={t(`countries.${vacancy.country}`)}
              src={`https://flagcdn.com/w40/${vacancy.country.toLowerCase()}.png`}
            />
            <span className="font-lexend font-medium text-sm text-[#737373] whitespace-nowrap">
              {t(`countries.${vacancy.country}`)}
            </span>
          </div>
        )}
      </header>

      {/* Content — posicionado como no Figma: left-[120px] com w-[1200px] */}
      <main className="px-6 lg:px-[120px] pb-12">
        {isLoading && <VacancySkeleton />}
        {isNotFound && <VacancyNotFound />}
        {vacancy && !isLoading && (
          <div className="flex flex-col lg:flex-row items-start gap-6 max-w-[1200px]">
            <VacancyCaseCard
              vacancy={vacancy}
              onPostularse={postularse}
              isLoading={state === 'loading'}
            />
            <VacancyDetailsCard vacancy={vacancy} />
          </div>
        )}
      </main>

      {state === 'unauthenticated' && (
        <UnauthenticatedModal onClose={dismissModal} onConfirm={confirmRegister} />
      )}

      {state === 'incomplete' && missingFields && (
        <IncompleteRegistrationModal missingFields={missingFields} onClose={dismissModal} />
      )}
    </div>
  );
}
