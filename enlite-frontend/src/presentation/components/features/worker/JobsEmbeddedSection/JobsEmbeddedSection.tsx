import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useEffect, useState, useMemo } from 'react';
import { Select } from '@presentation/components/atoms/Select';
import { SearchInput } from '@presentation/components/molecules/SearchBar';
import { PublicApiService } from '@infrastructure/http/PublicApiService';
import { IncompleteRegistrationModal } from '@presentation/pages/public/components/IncompleteRegistrationModal';
import { PostularseErrorModal } from '@presentation/pages/public/components/PostularseErrorModal';
import type { PublicJobListing } from '@domain/entities/PublicJobListing';
import {
  type Job,
  type JobsResponse,
  getWorkerTypeOptions,
  getProvinceOptions,
  getLocalityOptions,
  getSexOptions,
} from './jobsConstants';

// `window` é sempre definido: esta é uma SPA Vite pura, sem SSR (arquitetura em
// enlite-frontend/CLAUDE.md) — o guard `typeof window !== 'undefined'` nunca
// tinha o ramo falso alcançado em nenhum ambiente real desta app.
function readUsePublicApi(): boolean {
  const override = (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API;
  if (typeof override === 'boolean') return override;
  return import.meta.env.VITE_USE_PUBLIC_JOBS_API === 'true';
}

function formatAgeRange(min: number | null, max: number | null): string {
  if (min !== null && max !== null) return `${min} a ${max} años`;
  if (min !== null) return `${min}+ años`;
  if (max !== null) return `hasta ${max} años`;
  return '';
}

function adaptPublicJobListing(dto: PublicJobListing): Job {
  return {
    code: String(dto.case_number),
    title: dto.title,
    workerType: (dto.worker_type ?? []).join(', '),
    provincia: dto.state ?? '',
    localidad: dto.city ?? '',
    barrio: dto.neighborhood ?? '',
    workerSex: dto.worker_sex ?? '',
    description: dto.description,
    service: dto.service ?? '',
    daysAndHours: dto.schedule_days_hours ?? '',
    ageRange: formatAgeRange(dto.age_range_min, dto.age_range_max),
    profile: dto.worker_profile_sought ?? '',
    whatsappLink: dto.whatsapp_url ?? '',
    detailLink: dto.detail_link,
  };
}

interface JobsEmbeddedSectionProps {
  isRegistrationComplete?: boolean;
  /**
   * `missingFields` do GET /api/workers/me (mesma fonte que WorkerHome usa
   * pra `isRegistrationComplete`) — SEM requisição nova. `null`/ausente =
   * "não apurado" (fail-closed, D302): o `IncompleteRegistrationModal` mostra
   * a mensagem genérica e honesta, nunca finge saber o que falta.
   */
  missingFields?: string[] | null;
}

export const JobsEmbeddedSection = ({
  isRegistrationComplete = false,
  missingFields = null,
}: JobsEmbeddedSectionProps): JSX.Element => {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const workerTypeOptions = useMemo(() => getWorkerTypeOptions(t), [t]);
  const provinceOptions = useMemo(() => getProvinceOptions(t), [t]);
  const localityOptions = useMemo(() => getLocalityOptions(), []);
  const sexOptions = useMemo(() => getSexOptions(t), [t]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showIncompleteModal, setShowIncompleteModal] = useState(false);

  const handleWhatsAppClick = (job: Job): void => {
    if (!isRegistrationComplete) {
      setShowIncompleteModal(true);
      return;
    }
    window.open(job.whatsappLink, '_blank');
  };

  const handleDetailsClick = (job: Job): void => {
    if (!isRegistrationComplete) {
      setShowIncompleteModal(true);
      return;
    }
    window.open(job.detailLink, '_blank');
  };

  const [searchTerm, setSearchTerm] = useState('');
  const [filterType, setFilterType] = useState('');
  const [filterProvince, setFilterProvince] = useState('');
  const [filterLocality, setFilterLocality] = useState('');
  const [filterSex, setFilterSex] = useState('');

  const filteredJobs = useMemo(() => {
    return jobs.filter(job => {
      const searchLower = searchTerm.toLowerCase();
      const matchesSearch = !searchTerm ||
        job.title.toLowerCase().includes(searchLower) ||
        job.code.includes(searchTerm) ||
        job.workerType.toLowerCase().includes(searchLower) ||
        job.localidad.toLowerCase().includes(searchLower) ||
        job.provincia.toLowerCase().includes(searchLower);

      const matchesType = !filterType || job.workerType === filterType;
      const matchesProvince = !filterProvince || job.provincia === filterProvince;
      const matchesLocality = !filterLocality || job.localidad === filterLocality;
      const matchesSex = !filterSex || job.workerSex === filterSex;

      return matchesSearch && matchesType && matchesProvince && matchesLocality && matchesSex;
    });
  }, [jobs, searchTerm, filterType, filterProvince, filterLocality, filterSex]);

  useEffect(() => {
    setIsLoading(true);
    setError(null);
    const fetchJobs = async (): Promise<void> => {
      if (readUsePublicApi()) {
        const listings = await PublicApiService.getPublicJobs();
        setJobs(listings.map(adaptPublicJobListing));
      } else {
        const apiUrl = import.meta.env.VITE_API_WORKER_FUNCTIONS_URL || 'http://localhost:8081';
        const response = await fetch(`${apiUrl}/api/jobs`);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const data: JobsResponse = await response.json();
        if (data.success) setJobs(data.data);
        else throw new Error('Failed to fetch jobs');
      }
    };
    fetchJobs()
      .catch(err => setError((err as Error).message))
      .finally(() => setIsLoading(false));
  }, []);

  const clearFilters = (): void => {
    setSearchTerm('');
    setFilterType('');
    setFilterProvince('');
    setFilterLocality('');
    setFilterSex('');
  };

  const activeFiltersCount = [
    searchTerm, filterType, filterProvince, filterLocality, filterSex
  ].filter(Boolean).length;

  if (isLoading) {
    return (
      <div className="w-full bg-white rounded-xl shadow-sm p-8">
        <div className="flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full bg-white rounded-xl shadow-sm p-8">
        <div className="text-center text-red-600">{error}</div>
      </div>
    );
  }

  return (
    <div id="jobs-section" className="w-full bg-white rounded-[20px] border border-[#d9d9d9] border-b-2 border-l-2 border-r-2 overflow-hidden flex flex-col">
      {/* Aviso antecipado do gate de postulación: o prestador vê desde já que
          precisa completar o registro antes de poder postularse, em vez de só
          descobrir ao clicar "Ver Detalles" (UX review P2). */}
      {!isRegistrationComplete && (
        <button
          type="button"
          onClick={() => navigate('/worker/profile')}
          data-testid="complete-registration-banner"
          className="flex w-full items-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-3 text-left hover:bg-amber-100 transition-colors"
        >
          <svg className="w-5 h-5 text-amber-600 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <span className="flex-1 text-sm font-lexend font-medium text-amber-900">
            {t('jobs.completeToApplyBanner', 'Completá tu registro para poder postularte a las vacantes.')}
          </span>
          <span className="text-sm font-lexend font-semibold text-amber-700 underline shrink-0">
            {t('jobs.completeNow', 'Completar')}
          </span>
        </button>
      )}

      {/* Header */}
      <div className="p-6">
        <h2 className="text-xl font-semibold text-[#180149] mb-4 font-lexend">
          {t('jobs.title')}
        </h2>

        <div className="mb-4">
          <SearchInput
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder={t('jobs.searchPlaceholder')}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
          <Select
            inputSize="compact"
            value={filterType}
            onValueChange={setFilterType}
            options={workerTypeOptions}
            placeholder={t('jobs.filters.workerType')}
          />
          <Select
            inputSize="compact"
            value={filterProvince}
            onValueChange={setFilterProvince}
            options={provinceOptions}
            placeholder={t('jobs.filters.province')}
          />
          <Select
            inputSize="compact"
            value={filterLocality}
            onValueChange={setFilterLocality}
            options={localityOptions}
            placeholder={t('jobs.filters.locality')}
          />
          <Select
            inputSize="compact"
            value={filterSex}
            onValueChange={setFilterSex}
            options={sexOptions}
            placeholder={t('jobs.filters.sex')}
          />
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[14px] text-[#737373] font-lexend font-medium">
              {t('jobs.activeFilters')}
            </span>
            {activeFiltersCount > 0 && (
              <span className="px-2 py-1 bg-[#180149] text-white text-xs rounded-full font-lexend">
                {activeFiltersCount}
              </span>
            )}
            <span className="text-[14px] text-[#737373] font-lexend font-medium ml-2">
              {filteredJobs.length} {t('jobs.results')}
            </span>
          </div>
          <button
            onClick={clearFilters}
            disabled={activeFiltersCount === 0}
            className="px-6 py-2 rounded-full border border-[#d9d9d9] bg-white text-[#180149] font-lexend font-medium text-sm hover:border-[#180149] disabled:bg-white disabled:text-[#999] disabled:border-[#d9d9d9] disabled:cursor-not-allowed transition-colors"
            style={{ backgroundColor: activeFiltersCount === 0 ? 'white' : undefined }}
          >
            {t('jobs.clearFilters')}
          </button>
        </div>
      </div>

      {/* Jobs List */}
      <div className="flex-1 overflow-y-auto px-4 md:px-6 pb-6 space-y-3 max-h-[50vh] md:max-h-[600px]">
        {filteredJobs.length === 0 ? (
          <div className="text-center py-8 text-[#737373] font-lexend text-[14px] font-medium">
            {t('jobs.noResults')}
          </div>
        ) : (
          filteredJobs.map((job) => (
            <div
              key={job.code}
              className="border border-[#d9d9d9] rounded-[10px] p-4 hover:border-[#180149] transition-colors bg-white"
            >
              <div className="flex items-start justify-between mb-3 gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="px-2 py-1 bg-[#180149] text-white text-xs rounded font-medium font-lexend">
                      {job.code}
                    </span>
                    <span className="text-xs text-[#737373] capitalize font-lexend font-medium">
                      {job.workerType.split(', ').map(p => t(`jobs.profession.${p}`, { defaultValue: p })).join(', ')}
                    </span>
                  </div>
                  <h3 className="font-semibold text-[#180149] text-sm font-lexend">
                    {[job.barrio, job.localidad, job.provincia].filter(Boolean).join(' · ')}
                  </h3>
                </div>
                <div className="flex flex-wrap gap-2 flex-shrink-0">
                  {job.whatsappLink && (
                    <button
                      onClick={() => handleWhatsAppClick(job)}
                      className="px-3 py-1.5 bg-[#25d366] text-white text-xs rounded hover:bg-[#128c7e] transition-colors font-lexend font-medium"
                    >
                      {t('jobs.apply')}
                    </button>
                  )}
                  <button
                    onClick={() => handleDetailsClick(job)}
                    className="px-3 py-1.5 bg-[#180149] text-white text-xs rounded hover:bg-[#2a014d] transition-colors font-lexend font-medium"
                  >
                    {t('jobs.viewDetails')}
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs text-[#737373] mb-3 font-lexend font-medium">
                <div>
                  <span className="text-[#180149] font-semibold">{t('jobs.fields.sex')}:</span>{' '}
                  {t(`jobs.sex.${job.workerSex}`, { defaultValue: job.workerSex })}
                </div>
                <div>
                  <span className="text-[#180149] font-semibold">{t('jobs.fields.ageRange')}:</span> {job.ageRange}
                </div>
                <div>
                  <span className="text-[#180149] font-semibold">{t('jobs.fields.serviceType')}:</span> {job.service}
                </div>
                <div>
                  <span className="text-[#180149] font-semibold">{t('jobs.fields.schedule')}:</span> {job.daysAndHours.substring(0, 30)}...
                </div>
              </div>

              <div className="text-xs text-[#737373] font-lexend font-medium">
                <p className="mb-1"><span className="text-[#180149] font-semibold">{t('jobs.fields.profile')}:</span> {job.profile}</p>
                <p className="line-clamp-2">{job.description}</p>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Cadastro incompleto — MESMO modal de /vacantes/:id (IncompleteRegistrationModal),
          alimentado pelo missingFields que a home já tem do GET /api/workers/me (sem
          requisição nova, sem recálculo local de completude — D302, decisão do parecer
          jurídico de 10/09). Nem Postularse nem Ver Detalles chamam track-channel.
          
          D1 (QA caça, incidente 08/09): `missingFields` null/ausente é "NÃO APUREI" —
          nunca "incompleto". Acontece quando o backend não devolveu o array (ainda) OU
          quando a worker clica ANTES do GET /api/workers/me da home resolver (a lista de
          vagas tem fetch PRÓPRIO, independente, e pode carregar primeiro). Mostrar
          "incompleto" nesse estado afirmaria o que a tela não sabe — mesmo defeito do
          incidente. Reusa o MESMO PostularseErrorModal (mesmo texto) de /vacantes/:id
          pro estado "não verificado", sem os CTAs de retry/completar (não fazem sentido
          aqui e não dá pra mandar completar algo que talvez já esteja completo). */}
      {showIncompleteModal && (
        missingFields == null ? (
          <PostularseErrorModal onClose={() => setShowIncompleteModal(false)} />
        ) : (
          <IncompleteRegistrationModal
            missingFields={missingFields}
            onClose={() => setShowIncompleteModal(false)}
          />
        )
      )}
    </div>
  );
};
