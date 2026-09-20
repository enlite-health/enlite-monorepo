/**
 * JobsEmbeddedSection.test.tsx
 *
 * CAMADA 0 — bug #2 (versão sem servidor novo, parecer do lex 10/09): o modal
 * genérico `jobs.incompleteModal.*` foi substituído pelo IncompleteRegistrationModal
 * real, alimentado por `missingFields` (prop — SEM requisição nova). "Ver Detalles"
 * NUNCA chama track-channel (continua assim, inalterado — condição C1 do lex).
 *
 * Rodada "home vagas API pública" (autorizado por Gabriel): "Postularse" deixou
 * de usar o modal prop-driven acima — cada card (`JobCard.tsx`) passa a usar
 * `usePostularseAction` (o MESMO hook de /vacantes/:id, canal fixo 'site'),
 * que chama o SERVIDOR de verdade (`WorkerApiService.trackAcquisitionChannel`)
 * pra decidir elegibilidade em tempo real, em vez de confiar na prop
 * `missingFields` (que podia estar desatualizada ou "não apurada"). Isso só
 * existe quando o job tem `id` (job_postings.id real — só a API pública
 * fornece; o scraper legado não tem, e o botão Postularse não é exibido pra
 * esses jobs — clique morto seria pior que ausência).
 *
 * Arquivo não tinha teste nenhum antes do fix original — cobertura 100% aqui
 * cobre o componente inteiro (fetch legado, fetch da API pública, filtros,
 * banner, modal de Ver Detalles), não só o diff desta rodada.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { JobsEmbeddedSection } from './JobsEmbeddedSection';
import type { PublicJobListing } from '@domain/entities/PublicJobListing';
import type { JobsResponse } from './jobsConstants';
import { ApiError } from '@infrastructure/http/ApiError';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockNavigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, optsOrFallback?: unknown) => {
      if (typeof optsOrFallback === 'string') return optsOrFallback;
      if (optsOrFallback && typeof optsOrFallback === 'object') {
        const opts = optsOrFallback as Record<string, unknown>;
        if (typeof opts['defaultValue'] === 'string') return opts['defaultValue'];
        if (typeof opts['field'] === 'string') return `Ir a ${opts['field']}`;
      }
      return key;
    },
  }),
}));

const mockGetPublicJobs = vi.fn();
vi.mock('@infrastructure/http/PublicApiService', () => ({
  PublicApiService: { getPublicJobs: (...args: unknown[]) => mockGetPublicJobs(...args) },
}));

vi.mock('@presentation/hooks/useAuth');
vi.mock('@infrastructure/http/WorkerApiService');

import { useAuth } from '@presentation/hooks/useAuth';
import { WorkerApiService } from '@infrastructure/http/WorkerApiService';

const mockUseAuth = vi.mocked(useAuth);
const mockTrackAcquisitionChannel = vi.mocked(WorkerApiService.trackAcquisitionChannel);

// ── Fixtures ──────────────────────────────────────────────────────────────────

/**
 * Jobs do scraper legado (`/api/jobs`): nunca têm `id` real (job_postings.id
 * — só a API pública fornece). `id: ''` é o valor HONESTO, não um placeholder
 * de conveniência — é exatamente o que `adaptPublicJobListing` NÃO produz
 * pra esta fonte (o fetch legado usa `data.data` cru, sem adapter nenhum).
 */
function legacyResponse(overrides: Partial<JobsResponse> = {}): JobsResponse {
  return {
    success: true,
    count: 2,
    data: [
      {
        id: '',
        code: '736',
        title: 'CASO 736',
        workerType: 'acompañante terapéutico',
        provincia: 'caba',
        localidad: 'palermo',
        barrio: 'palermo chico',
        workerSex: 'indistinto',
        description: 'desc 736',
        service: 'domiciliario',
        daysAndHours: 'Lunes a viernes de 09:00 a 15:00 hs, todo el mes completo',
        ageRange: '25 a 40 años',
        profile: 'perfil 736',
        whatsappLink: 'https://wa.me/5491100000000',
        detailLink: 'https://jobs.enlite.health/es/vagas/736/',
      },
      {
        // Sem whatsappLink — não deve renderizar o botão "Postularse".
        id: '',
        code: '732',
        title: 'CASO 732',
        workerType: 'cuidador/a',
        provincia: '',
        localidad: '',
        barrio: '',
        workerSex: 'mujer',
        description: 'desc 732',
        service: 'traslado',
        daysAndHours: 'Solo martes',
        ageRange: '',
        profile: 'perfil 732',
        whatsappLink: '',
        detailLink: 'https://jobs.enlite.health/es/vagas/732/',
      },
    ],
    ...overrides,
  };
}

function mockFetchOnce(response: Partial<JobsResponse>, ok = true, status = 200): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(response),
  }));
}

/** Job da API pública (com `id` real) — vocabulário canônico do PublicJobListing. */
function publicListing(overrides: Partial<PublicJobListing> = {}): PublicJobListing {
  return {
    id: 'job-1',
    case_number: 900,
    vacancy_number: 1,
    title: 'CASO 900',
    status: 'SEARCHING',
    description: 'desc',
    schedule_days_hours: null,
    worker_profile_sought: null,
    service: null,
    state: null,
    city: null,
    detail_link: 'https://jobs.enlite.health/es/vagas/900/',
    worker_type: null,
    worker_sex: null,
    job_zone: null,
    neighborhood: null,
    state_city: null,
    location_label: null,
    country: 'AR',
    age_range_min: null,
    age_range_max: null,
    whatsapp_url: 'https://wa.me/5491100000900',
    ...overrides,
  };
}

async function waitForLoaded(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByPlaceholderText('jobs.searchPlaceholder')).toBeInTheDocument();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default do SUÍTE é a fonte LEGADA (fetch), não a do produto (ver describe
  // "fonte pública por padrão" abaixo) — a maioria destes testes existe pra
  // cobrir o `fetch` legado deliberadamente, e usa o override de window
  // exatamente como "quem precisa desligar" a API pública seria esperado a
  // fazer. Só os testes que chamam `mockGetPublicJobs` setam `= true`.
  (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = false;
  mockUseAuth.mockReturnValue({
    isAuthenticated: true,
    isLoading: false,
    user: null,
    login: vi.fn(),
    loginWithGoogle: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
  });
  mockTrackAcquisitionChannel.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── Estados de carregamento (fetch legado /api/jobs) ─────────────────────────

describe('JobsEmbeddedSection — carregamento', () => {
  it('mostra spinner enquanto carrega', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection />);
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    await waitForLoaded(); // esvazia o efeito pendente antes do teste terminar
  });

  it('após carregar, renderiza os jobs do fetch legado', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();
    expect(screen.getByText('736')).toBeInTheDocument();
    expect(screen.getByText('732')).toBeInTheDocument();
  });

  it('HTTP não-ok → mostra "HTTP error! status: 500"', async () => {
    mockFetchOnce({}, false, 500);
    render(<JobsEmbeddedSection />);
    await waitFor(() => expect(screen.getByText(/HTTP error! status: 500/)).toBeInTheDocument());
  });

  it('success:false no payload → mostra "Failed to fetch jobs"', async () => {
    mockFetchOnce({ success: false, data: [], count: 0 });
    render(<JobsEmbeddedSection />);
    await waitFor(() => expect(screen.getByText(/Failed to fetch jobs/)).toBeInTheDocument());
  });

  it('fetch rejeita (erro de rede) → mostra a mensagem do erro', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));
    render(<JobsEmbeddedSection />);
    await waitFor(() => expect(screen.getByText('Network down')).toBeInTheDocument());
  });
});

// ── Fonte pública (PublicApiService), toggle via window.__USE_PUBLIC_JOBS_API ──

describe('JobsEmbeddedSection — fonte pública de vagas', () => {
  it('min e max presentes → "X a Y años"', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing({ age_range_min: 20, age_range_max: 30 })]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());
    expect(screen.getByText(/20 a 30 años/)).toBeInTheDocument();
  });

  it('só min → "X+ años"', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing({ age_range_min: 40, age_range_max: null })]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());
    expect(screen.getByText(/40\+ años/)).toBeInTheDocument();
  });

  it('só max → "hasta X años"', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing({ age_range_min: null, age_range_max: 60 })]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());
    expect(screen.getByText(/hasta 60 años/)).toBeInTheDocument();
  });

  it('nem min nem max, e campos opcionais null → string vazia, sem quebrar (nullish fallbacks)', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing({ whatsapp_url: null })]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());
    // whatsapp_url null → sem botão Postularse pra esse job
    expect(screen.queryByRole('button', { name: 'jobs.apply' })).not.toBeInTheDocument();
  });

  it('worker_type presente → junta as profissões', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing({ worker_type: ['AT', 'CAREGIVER'] })]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());
    expect(screen.getByText('AT, CAREGIVER')).toBeInTheDocument();
  });

  it('código de exibição é `case_number-vacancy_number` (paridade com o painel admin, VacancyDetailPage.tsx)', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing({ case_number: 824, vacancy_number: 5012 })]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('824-5012')).toBeInTheDocument());
  });
});

// ── PADRÃO da fonte de vagas (achado do gate 12/09): a home liga a API ────────
// pública por padrão — sem override de window nem env definida, a fonte é a
// API pública, não mais o scraper legado. `window.__USE_PUBLIC_JOBS_API` e
// `VITE_USE_PUBLIC_JOBS_API` continuam existindo como override pra quem
// precisar desligar (ex.: stage, cuja massa sintética não aparece no feed
// público — ver frontend-stg.yml). Prioridade: window > env > default (true).

describe('JobsEmbeddedSection — padrão da fonte de vagas (API pública ligada por padrão)', () => {
  it('sem override de window E sem env definida → usa a API pública por padrão', async () => {
    delete (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API;
    mockGetPublicJobs.mockResolvedValue([publicListing()]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());
    expect(mockGetPublicJobs).toHaveBeenCalled();
  });

  it('VITE_USE_PUBLIC_JOBS_API="false" (sem override de window) → desliga, usa o fetch legado', async () => {
    delete (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API;
    vi.stubEnv('VITE_USE_PUBLIC_JOBS_API', 'false');
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();
    expect(screen.getByText('736')).toBeInTheDocument();
    expect(mockGetPublicJobs).not.toHaveBeenCalled();
  });

  it('window.__USE_PUBLIC_JOBS_API=false desliga mesmo com env indefinida (override sempre vence)', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = false;
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();
    expect(screen.getByText('736')).toBeInTheDocument();
    expect(mockGetPublicJobs).not.toHaveBeenCalled();
  });

  it('window.__USE_PUBLIC_JOBS_API=true liga mesmo com VITE_USE_PUBLIC_JOBS_API="false" (override sempre vence)', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    vi.stubEnv('VITE_USE_PUBLIC_JOBS_API', 'false');
    mockGetPublicJobs.mockResolvedValue([publicListing()]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());
  });
});

// ── Banner de cadastro incompleto ─────────────────────────────────────────────

describe('JobsEmbeddedSection — banner de cadastro incompleto', () => {
  it('isRegistrationComplete=false → banner visível; clicar navega pro perfil', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete={false} />);
    await waitForLoaded();

    const banner = screen.getByTestId('complete-registration-banner');
    expect(banner).toBeInTheDocument();
    fireEvent.click(banner);
    expect(mockNavigate).toHaveBeenCalledWith('/worker/profile');
  });

  it('isRegistrationComplete=true → banner ausente', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();
    expect(screen.queryByTestId('complete-registration-banner')).not.toBeInTheDocument();
  });
});

// ── Postularse — job SEM id (fonte legada): botão não existe ─────────────────

describe('JobsEmbeddedSection — Postularse e job sem id (fonte legada)', () => {
  it('job do scraper legado (whatsappLink presente, SEM id): não mostra o botão Postularse — só a API pública tem job_postings.id real', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();

    // 736 tem whatsappLink mas id=''; 732 não tem nem whatsappLink. Nenhum
    // dos dois mostra o botão Postularse.
    expect(screen.queryByRole('button', { name: 'jobs.apply' })).not.toBeInTheDocument();
    expect(mockTrackAcquisitionChannel).not.toHaveBeenCalled();
  });

  it('job com id E whatsappLink (fonte pública): mostra o botão Postularse', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing()]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'jobs.apply' })).toBeInTheDocument();
  });
});

// ── Ver Detalles — comportamento INALTERADO (prop-driven, nunca track-channel) ─

describe('JobsEmbeddedSection — Ver Detalles (comportamento inalterado)', () => {
  it('cadastro completo: Ver Detalles abre o link de detalhe do job (window.open)', async () => {
    mockFetchOnce(legacyResponse());
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();

    fireEvent.click(screen.getAllByRole('button', { name: 'jobs.viewDetails' })[0]);
    expect(openSpy).toHaveBeenCalledWith('https://jobs.enlite.health/es/vagas/736/', '_blank');
    openSpy.mockRestore();
  });

  it('cadastro incompleto: Ver Detalles abre o MESMO IncompleteRegistrationModal, NÃO abre o link, NENHUMA request pra track-channel', async () => {
    mockFetchOnce(legacyResponse());
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['phone']} />);
    await waitForLoaded();

    fireEvent.click(screen.getAllByRole('button', { name: 'jobs.viewDetails' })[0]);

    expect(screen.getByRole('heading', { name: 'publicVacancy.incompleteModal.title' })).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    expect(mockTrackAcquisitionChannel).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('modal mostra o campo nomeado a partir de missingFields (prop, sem requisição nova)', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['phone']} />);
    await waitForLoaded();

    fireEvent.click(screen.getAllByRole('button', { name: 'jobs.viewDetails' })[0]);
    expect(screen.getByRole('button', { name: /phone/i })).toBeInTheDocument();
  });

  it('missingFields nulo/ausente (não apurado) → mensagem de VERIFICAÇÃO (não "incompleto"), fail-closed, sem CTA de completar', async () => {
    mockFetchOnce(legacyResponse());
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<JobsEmbeddedSection isRegistrationComplete={false} />);
    await waitForLoaded();

    fireEvent.click(screen.getAllByRole('button', { name: 'jobs.viewDetails' })[0]);

    expect(screen.getByText('publicVacancy.errorModal.title')).toBeInTheDocument();
    expect(screen.getByText('publicVacancy.errorModal.bodyHome')).toBeInTheDocument();
    expect(screen.queryByText('publicVacancy.errorModal.body')).not.toBeInTheDocument();
    expect(screen.queryByText('publicVacancy.incompleteModal.title')).not.toBeInTheDocument();
    expect(screen.queryByText('publicVacancy.errorModal.complete')).not.toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('mensagem de verificação fecha ao clicar "Cerrar"', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete={false} />);
    await waitForLoaded();

    fireEvent.click(screen.getAllByRole('button', { name: 'jobs.viewDetails' })[0]);
    expect(screen.getByText('publicVacancy.errorModal.title')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'publicVacancy.errorModal.cancel' }));
    expect(screen.queryByText('publicVacancy.errorModal.title')).not.toBeInTheDocument();
  });

  it('missingFields=[] (array vazio, conhecido) → CONTINUA usando o modal de pendências normal (não é o caso "não apurado")', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={[]} />);
    await waitForLoaded();

    fireEvent.click(screen.getAllByRole('button', { name: 'jobs.viewDetails' })[0]);
    expect(screen.getByText('publicVacancy.incompleteModal.title')).toBeInTheDocument();
    expect(screen.queryByText('publicVacancy.errorModal.title')).not.toBeInTheDocument();
  });

  it('fechar o modal (cancelar) esconde-o de novo', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['phone']} />);
    await waitForLoaded();

    fireEvent.click(screen.getAllByRole('button', { name: 'jobs.viewDetails' })[0]);
    expect(screen.getByRole('heading', { name: 'publicVacancy.incompleteModal.title' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'publicVacancy.incompleteModal.cancel' }));
    expect(screen.queryByRole('heading', { name: 'publicVacancy.incompleteModal.title' })).not.toBeInTheDocument();
  });
});

// ── Postularse (job com id) — vai pro servidor via usePostularseAction ───────

describe('JobsEmbeddedSection — Postularse com id (usePostularseAction, canal fixo "site")', () => {
  it('elegível: chama trackAcquisitionChannel(jobId, "site") e abre o WhatsApp só depois do servidor confirmar', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing({ id: 'job-42', whatsapp_url: 'https://wa.me/5491100000042' })]);
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'jobs.apply' }));

    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('https://wa.me/5491100000042', '_blank'));
    expect(mockTrackAcquisitionChannel).toHaveBeenCalledWith('job-42', 'site');
    openSpy.mockRestore();
  });

  it('inelegível (403 WORKER_NOT_ELIGIBLE): mostra IncompleteRegistrationModal com os missingFields do SERVIDOR (não a prop), NÃO abre WhatsApp', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing({ id: 'job-42' })]);
    mockTrackAcquisitionChannel.mockRejectedValueOnce(
      new ApiError(
        {
          success: false,
          error: 'registration_incomplete',
          code: 'WORKER_NOT_ELIGIBLE',
          missingFields: ['doc_criminal_record'],
        },
        403,
      ),
    );
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    // A prop `missingFields` (GET /api/workers/me) fica desatualizada de
    // propósito neste teste — prova que o modal usa o retorno FRESCO do
    // servidor (403 do click), não a prop. Ela também dirige o RÓTULO do
    // botão (Fase 4/DD5, inalterado) — 'phone' vira "jobs.applyLabel.registration".
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['phone']} />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'jobs.applyLabel.registration' }));

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'publicVacancy.incompleteModal.title' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /doc_criminal_record/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Ir a phone$/i })).not.toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('erro do servidor (rede/500): mostra "No pudimos verificar" (bodyHome), NÃO abre WhatsApp', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing({ id: 'job-42' })]);
    mockTrackAcquisitionChannel.mockRejectedValueOnce(new Error('Network down'));
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'jobs.apply' }));

    await waitFor(() => expect(screen.getByText('publicVacancy.errorModal.bodyHome')).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'publicVacancy.incompleteModal.title' })).not.toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('fechar o modal de inelegibilidade (dismissModal) esconde-o e permite reintentar', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing({ id: 'job-42' })]);
    mockTrackAcquisitionChannel.mockRejectedValueOnce(
      new ApiError({ success: false, error: 'registration_incomplete', code: 'WORKER_NOT_ELIGIBLE', missingFields: ['phone'] }, 403),
    );
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'jobs.apply' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'publicVacancy.incompleteModal.title' })).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'publicVacancy.incompleteModal.cancel' }));
    expect(screen.queryByRole('heading', { name: 'publicVacancy.incompleteModal.title' })).not.toBeInTheDocument();
  });

  it('"Ver Detalles" NUNCA chama track-channel, mesmo num card cujo Postularse (id presente) usa o servidor', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing({ id: 'job-42' })]);
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'jobs.viewDetails' }));

    expect(openSpy).toHaveBeenCalledWith('https://jobs.enlite.health/es/vagas/900/', '_blank');
    expect(mockTrackAcquisitionChannel).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});

// ── Fase 4/DD5 — rótulo dinâmico do "Postularse" (usa buildPendingRows,     ──
// ── a MESMA função da lista de tarefas — sem segunda contagem)               ─
// Testes usam jobs COM id (fonte pública) — o rótulo em si é só texto (prop
// missingFields/profession), mas o botão só existe quando id está presente.

describe('JobsEmbeddedSection — rótulo dinâmico do Postularse (Fase 4, DD5)', () => {
  it('1 pendência de DOCUMENTO → rótulo vira dinâmico (jobs.applyLabel.document sob este mock literal)', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing()]);
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['doc_criminal_record']} profession="AT" />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'jobs.applyLabel.document' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'jobs.apply' })).not.toBeInTheDocument();
  });

  it('2+ pendências → rótulo vira dinâmico (jobs.applyLabel.multiple) — MESMO N que buildPendingRows devolve pra lista de tarefas', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing()]);
    render(
      <JobsEmbeddedSection
        isRegistrationComplete={false}
        missingFields={['phone', 'doc_criminal_record', 'doc_identity_document']}
        profession="CAREGIVER"
      />,
    );
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'jobs.applyLabel.multiple' })).toBeInTheDocument();
  });

  it('cadastro COMPLETO (missingFields=[]) → rótulo continua "Postularse" original', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing()]);
    render(<JobsEmbeddedSection isRegistrationComplete missingFields={[]} />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'jobs.apply' })).toBeInTheDocument();
  });

  it('missingFields NULO (não apurado) → rótulo continua "Postularse" original, mesmo com profession informada', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([publicListing()]);
    render(<JobsEmbeddedSection isRegistrationComplete={false} profession="AT" />);
    await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());

    expect(screen.getByRole('button', { name: 'jobs.apply' })).toBeInTheDocument();
  });

  it('todos os jobs com whatsappLink+id mostram o MESMO rótulo (depende só de missingFields/profession, não do job)', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([
      publicListing({ id: 'job-1', case_number: 1, vacancy_number: 1, whatsapp_url: 'https://wa.me/1' }),
      publicListing({ id: 'job-2', case_number: 2, vacancy_number: 1, whatsapp_url: 'https://wa.me/2' }),
    ]);
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['doc_criminal_record']} profession="AT" />);
    await waitFor(() => expect(screen.getByText('1-1')).toBeInTheDocument());

    expect(screen.getAllByRole('button', { name: 'jobs.applyLabel.document' })).toHaveLength(2);
  });

  describe('contraste WCAG AA (gate 11/09, rodada 3 — unit barato que fixa a cor sem depender de e2e)', () => {
    // `bg-[#25d366]` (verde claro do ícone do WhatsApp) media 1,98:1 com
    // texto branco — abaixo do mínimo WCAG AA (4,5:1), achado do gate
    // quando o botão passou a carregar a frase inteira da entrega
    // (Fase 4/DD5). Decisão de desenho do orquestrador: verde-escuro da
    // marca `#075E54` (7,67:1) — mantém a identidade WhatsApp. Este teste
    // não recalcula contraste (papel do e2e, via getComputedStyle) — só
    // trava que ninguém reintroduz o verde claro num refactor futuro.
    it('botão Postularse usa bg-[#075E54] (verde-escuro da marca), NÃO bg-[#25d366] (verde claro, 1,98:1)', async () => {
      (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
      mockGetPublicJobs.mockResolvedValue([publicListing()]);
      render(<JobsEmbeddedSection isRegistrationComplete />);
      await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());

      const applyBtn = screen.getAllByRole('button', { name: 'jobs.apply' })[0];
      expect(applyBtn).toHaveClass('bg-[#075E54]');
      expect(applyBtn).not.toHaveClass('bg-[#25d366]');
      expect(applyBtn).toHaveClass('hover:bg-[#054C44]');
      expect(applyBtn).not.toHaveClass('hover:bg-[#128c7e]');
    });
  });

  describe('data-clarity-mask (condição C12 do lex) — atualizado pra arquitetura JobCard/API pública', () => {
    // C12 protege o RÓTULO dinâmico do botão Postularse (pode conter o nome
    // do documento pendente — dado do próprio worker) de vazar pro Clarity
    // (session replay). O botão só existe hoje quando o job tem `whatsappLink`
    // E `id` real (job_postings.id — só a API pública fornece); job legado
    // do scraper nunca tem `id`, então o botão não é exibido (comportamento
    // NOVO E INTENCIONAL da rodada "home vagas API pública" — NÃO É
    // REGRESSÃO: sem `id` não dá pra checar elegibilidade real, e um botão
    // que sempre falharia seria peor que a ausência dele). Este describe
    // cobre as duas pontas: mask presente onde o botão existe, e confirma
    // que "não existe" é o esperado onde não existe.
    it('vaga da API pública (COM id) — botão Postularse tem data-clarity-mask="True"', async () => {
      (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
      mockGetPublicJobs.mockResolvedValue([publicListing()]);
      render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['doc_criminal_record']} profession="AT" />);
      await waitFor(() => expect(screen.getByText('900-1')).toBeInTheDocument());

      expect(screen.getByRole('button', { name: 'jobs.applyLabel.document' })).toHaveAttribute('data-clarity-mask', 'True');
    });

    it('vaga legada do scraper (SEM id) — botão Postularse NÃO existe (novo comportamento intencional, não regressão do C12)', async () => {
      mockFetchOnce(legacyResponse());
      render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['doc_criminal_record']} profession="AT" />);
      await waitForLoaded();

      expect(screen.queryByRole('button', { name: 'jobs.applyLabel.document' })).not.toBeInTheDocument();
    });
  });
});

// ── Filtros e busca ───────────────────────────────────────────────────────────

describe('JobsEmbeddedSection — filtros e busca', () => {
  it('busca por texto filtra a lista (sem match → jobs.noResults)', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();

    fireEvent.change(screen.getByPlaceholderText('jobs.searchPlaceholder'), { target: { value: 'zzz-no-match' } });
    expect(screen.getByText('jobs.noResults')).toBeInTheDocument();
  });

  it('busca por código do job encontra por número', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();

    fireEvent.change(screen.getByPlaceholderText('jobs.searchPlaceholder'), { target: { value: '732' } });
    expect(screen.getByText('732')).toBeInTheDocument();
    expect(screen.queryByText('736')).not.toBeInTheDocument();
  });

  it('filtro de tipo/provincia/localidade/sexo restringe a lista e habilita "Limpiar"', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();

    const [typeSelect, provinceSelect, localitySelect, sexSelect] = screen.getAllByRole('combobox');
    const clearBtn = screen.getByRole('button', { name: 'jobs.clearFilters' });
    expect(clearBtn).toBeDisabled();

    fireEvent.change(sexSelect, { target: { value: 'mujer' } });
    expect(clearBtn).not.toBeDisabled();
    expect(screen.getByText('732')).toBeInTheDocument();
    expect(screen.queryByText('736')).not.toBeInTheDocument();

    fireEvent.click(clearBtn);
    expect(screen.getByText('736')).toBeInTheDocument();

    fireEvent.change(typeSelect, { target: { value: 'acompañante terapéutico' } });
    expect(screen.getByText('736')).toBeInTheDocument();
    expect(screen.queryByText('732')).not.toBeInTheDocument();
    fireEvent.click(clearBtn);

    fireEvent.change(provinceSelect, { target: { value: 'caba' } });
    expect(screen.getByText('736')).toBeInTheDocument();
    expect(screen.queryByText('732')).not.toBeInTheDocument();
    fireEvent.click(clearBtn);

    fireEvent.change(localitySelect, { target: { value: 'palermo' } });
    expect(screen.getByText('736')).toBeInTheDocument();
    expect(screen.queryByText('732')).not.toBeInTheDocument();
  });

  it('contador de filtros ativos aparece quando activeFiltersCount > 0', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();

    fireEvent.change(screen.getByPlaceholderText('jobs.searchPlaceholder'), { target: { value: '736' } });
    expect(screen.getByText('1')).toBeInTheDocument();
  });
});
