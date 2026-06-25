import { useState, useEffect } from 'react';
import { useParams, Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { MapPin, CheckCircle2 } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { VacancyStatusBadge } from '@presentation/components/atoms/VacancyStatusBadge';
import { Logo } from '@presentation/components/shared/Logo';
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

  return (
    <div className="bg-white border-[2.5px] border-[#eceff1] rounded-card overflow-hidden w-full lg:w-96 shrink-0">
      {/* Imagem placeholder — símbolo Enlite em marca d'água (240px como no Figma) */}
      <div className="h-60 bg-gradient-to-br from-clinic/10 via-care/5 to-primary/5 flex items-center justify-center">
        <img
          src="/EnliteMiniLogo.png"
          alt=""
          aria-hidden="true"
          className="w-20 h-20 object-contain opacity-40"
        />
      </div>

      <div className="px-8 py-6 flex flex-col gap-5">
        {/* Título + Status badge */}
        <div className="flex items-center justify-between w-full gap-3">
          <Heading level={2} weight="semibold" color="primary" className="leading-[1.3]">
            {vacancy.case_number != null
              ? `CASO ${vacancy.case_number}-${vacancy.vacancy_number}`
              : `CASO ${vacancy.vacancy_number}`}
          </Heading>
          <VacancyStatusBadge status={vacancy.status} className="shrink-0" />
        </div>

        {/* Endereço */}
        {vacancy.patient_zone && (
          <div className="flex items-center gap-2">
            <MapPin className="w-4 h-4 text-[#737373] shrink-0" />
            <Text as="span" size="sm" weight="medium">
              {vacancy.patient_zone}
            </Text>
          </div>
        )}

        {/* Botão Postularse */}
        <Button
          variant="primary"
          size="sm"
          fullWidth
          onClick={onPostularse}
          isLoading={isLoading}
          disabled={!vacancy.talentum_whatsapp_url}
        >
          {t('publicVacancy.postularse')}
        </Button>

        {/* Mensagem quando postulação indisponível */}
        {!vacancy.talentum_whatsapp_url && (
          <Text size="xs" color="muted" className="text-center">
            {t('publicVacancy.postularseUnavailable')}
          </Text>
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
        <Heading level={2} weight="semibold" color="primary" className="leading-[1.3]">
          {t('publicVacancy.therapeuticCompanions')}
        </Heading>

        {/* Indicações: disponível para */}
        {vacancy.required_sex && (
          <Text size="sm" weight="medium">
            {t('publicVacancy.availableFor')}{' '}
            <Text as="span" size="sm" weight="medium" color="primary">
              {t(`publicVacancy.sexLabels.${vacancy.required_sex}`, vacancy.required_sex)}
            </Text>
          </Text>
        )}

        {/* Descrição do trabalho */}
        {vacancy.talentum_description && (
          <div className="flex flex-col gap-2">
            <Heading level={4} weight="medium" color="primary" className="leading-[1.35]">
              {t('publicVacancy.jobDescription')}
            </Heading>
            <Text
              size="sm"
              weight="medium"
              className="max-w-[68ch] whitespace-pre-line break-words leading-[1.6]"
            >
              {vacancy.talentum_description}
            </Text>
          </div>
        )}

        {/* Características */}
        <div className="flex flex-col gap-2">
          <Heading level={4} weight="medium" color="primary" className="leading-[1.35]">
            {t('publicVacancy.characteristics')}
          </Heading>
          <div className="flex flex-col gap-2.5">
            {(vacancy.age_range_min != null || vacancy.age_range_max != null) && (
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                <Text size="sm" weight="medium">
                  {t('publicVacancy.ageRange')}{' '}
                  <Text as="span" size="sm" weight="medium" color="primary">
                    {vacancy.age_range_min != null && vacancy.age_range_max != null
                      ? `${vacancy.age_range_min} - ${vacancy.age_range_max}`
                      : vacancy.age_range_min ?? vacancy.age_range_max}
                  </Text>
                </Text>
              </div>
            )}
            {vacancy.patient_zone && (
              <div className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                <Text size="sm" weight="medium">
                  {t('publicVacancy.location')}{' '}
                  <Text as="span" size="sm" weight="medium" color="primary">
                    {vacancy.patient_zone}
                  </Text>
                </Text>
              </div>
            )}
            {vacancy.worker_attributes && (
              <div className="flex items-start gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-primary shrink-0 mt-1" />
                <Text size="sm" weight="medium" className="max-w-[68ch] break-words">
                  {t('publicVacancy.profile')}{' '}
                  <Text as="span" size="sm" weight="medium" color="primary">
                    {vacancy.worker_attributes}
                  </Text>
                </Text>
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
      <Heading level={2} weight="semibold" color="primary" className="mb-4">
        {t('publicVacancy.notFound.title')}
      </Heading>
      <Text size="sm" className="mb-6">
        {t('publicVacancy.notFound.body')}
      </Text>
      <Link to="/" className="text-primary underline">
        <Text as="span" size="sm" color="primary">
          {t('publicVacancy.notFound.backHome')}
        </Text>
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
    <div className="min-h-screen bg-background flex flex-col">
      {/* Navbar — marca Enlite à esquerda, país à direita */}
      <header className="flex items-center justify-between px-6 lg:px-[120px] py-6 border-b border-[#eceff1]">
        <Link to="/" aria-label="Enlite">
          <Logo className="h-9 w-36" />
        </Link>
        {vacancy?.country && (
          <div className="hidden md:inline-flex items-center gap-2 shrink-0">
            <img
              className="w-7 h-5 object-cover rounded-sm"
              alt={t(`countries.${vacancy.country}`)}
              src={`https://flagcdn.com/w40/${vacancy.country.toLowerCase()}.png`}
            />
            <Text as="span" size="sm" weight="medium" className="whitespace-nowrap">
              {t(`countries.${vacancy.country}`)}
            </Text>
          </div>
        )}
      </header>

      {/* Content — posicionado como no Figma: left-[120px] com w-[1200px] */}
      <main className="flex-1 px-6 lg:px-[120px] py-8 lg:py-10">
        {/* Título da página */}
        <Heading level={1} weight="semibold" color="primary" className="mb-6">
          {vacancy
            ? `${t('publicVacancy.vacante')}: ${vacancy.title}`
            : t('publicVacancy.vacante')}
        </Heading>

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

      {/* Footer de marca */}
      <footer className="border-t border-[#eceff1] px-6 lg:px-[120px] py-8 flex flex-col items-center gap-2">
        <Logo className="h-7 w-28" />
        <Text size="xs" color="muted" className="text-center">
          {t('publicVacancy.footer.tagline')}
        </Text>
      </footer>

      {state === 'unauthenticated' && (
        <UnauthenticatedModal onClose={dismissModal} onConfirm={confirmRegister} />
      )}

      {state === 'incomplete' && (
        <IncompleteRegistrationModal missingFields={missingFields} onClose={dismissModal} />
      )}
    </div>
  );
}
