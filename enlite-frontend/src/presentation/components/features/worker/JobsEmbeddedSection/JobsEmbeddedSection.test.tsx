/**
 * JobsEmbeddedSection.test.tsx
 *
 * CAMADA 0 — bug #2 (versão sem servidor novo, parecer do lex 10/09): o modal
 * genérico `jobs.incompleteModal.*` foi substituído pelo IncompleteRegistrationModal
 * real, alimentado por `missingFields` (prop — SEM requisição nova). Nem
 * "Postularse" nem "Ver Detalles" chamam track-channel.
 *
 * Arquivo não tinha teste nenhum antes deste fix — cobertura 100% aqui cobre
 * o componente inteiro (fetch legado, fetch da API pública, filtros, banner,
 * modal), não só o diff.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { JobsEmbeddedSection } from './JobsEmbeddedSection';
import type { PublicJobListing } from '@domain/entities/PublicJobListing';
import type { JobsResponse } from './jobsConstants';

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

// ── Fixtures ──────────────────────────────────────────────────────────────────

function legacyResponse(overrides: Partial<JobsResponse> = {}): JobsResponse {
  return {
    success: true,
    count: 2,
    data: [
      {
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

async function waitForLoaded(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByPlaceholderText('jobs.searchPlaceholder')).toBeInTheDocument();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API;
});

afterEach(() => {
  vi.unstubAllGlobals();
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
  function listing(overrides: Partial<PublicJobListing> = {}): PublicJobListing {
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
      whatsapp_url: null,
      ...overrides,
    };
  }

  it('min e max presentes → "X a Y años"', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([listing({ age_range_min: 20, age_range_max: 30 })]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900')).toBeInTheDocument());
    expect(screen.getByText(/20 a 30 años/)).toBeInTheDocument();
  });

  it('só min → "X+ años"', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([listing({ age_range_min: 40, age_range_max: null })]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900')).toBeInTheDocument());
    expect(screen.getByText(/40\+ años/)).toBeInTheDocument();
  });

  it('só max → "hasta X años"', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([listing({ age_range_min: null, age_range_max: 60 })]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900')).toBeInTheDocument());
    expect(screen.getByText(/hasta 60 años/)).toBeInTheDocument();
  });

  it('nem min nem max, e campos opcionais null → string vazia, sem quebrar (nullish fallbacks)', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([listing()]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900')).toBeInTheDocument());
    // whatsapp_url null → sem botão Postularse pra esse job
    expect(screen.queryByRole('button', { name: 'jobs.apply' })).not.toBeInTheDocument();
  });

  it('worker_type presente → junta as profissões', async () => {
    (window as { __USE_PUBLIC_JOBS_API?: boolean }).__USE_PUBLIC_JOBS_API = true;
    mockGetPublicJobs.mockResolvedValue([listing({ worker_type: ['AT', 'CAREGIVER'] })]);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitFor(() => expect(screen.getByText('900')).toBeInTheDocument());
    expect(screen.getByText('AT, CAREGIVER')).toBeInTheDocument();
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

// ── Postularse / Ver Detalles — cadastro completo (abre de verdade) ──────────

describe('JobsEmbeddedSection — cadastro completo', () => {
  it('Postularse abre o WhatsApp do job (window.open) — sem chamar track-channel', async () => {
    mockFetchOnce(legacyResponse());
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(legacyResponse()) });
    vi.stubGlobal('fetch', fetchSpy);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'jobs.apply' }));
    expect(openSpy).toHaveBeenCalledWith('https://wa.me/5491100000000', '_blank');
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('track-channel'))).toBe(false);
    openSpy.mockRestore();
  });

  it('Ver Detalles abre o link de detalhe do job (window.open)', async () => {
    mockFetchOnce(legacyResponse());
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();

    fireEvent.click(screen.getAllByRole('button', { name: 'jobs.viewDetails' })[0]);
    expect(openSpy).toHaveBeenCalledWith('https://jobs.enlite.health/es/vagas/736/', '_blank');
    openSpy.mockRestore();
  });

  it('job sem whatsappLink não renderiza o botão Postularse', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete />);
    await waitForLoaded();
    // Só 1 botão "Postularse" (job 736), embora existam 2 jobs.
    expect(screen.getAllByRole('button', { name: 'jobs.apply' })).toHaveLength(1);
  });
});

// ── Postularse / Ver Detalles — cadastro INCOMPLETO (modal, sem track-channel) ─

describe('JobsEmbeddedSection — cadastro incompleto (bug #2)', () => {
  it('Postularse com cadastro incompleto → abre IncompleteRegistrationModal, NÃO abre WhatsApp', async () => {
    mockFetchOnce(legacyResponse());
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['phone']} />);
    await waitForLoaded();

    // Fase 4/DD5: com 1 pendência de REGISTRO (phone → aba general), o
    // rótulo do botão deixa de ser "Postularse" — vira dinâmico
    // (`jobs.applyLabel.registration` sob este mock de i18n literal). O
    // CLIQUE continua abrindo o MESMO modal, sem request nova (é o que
    // este teste prova).
    fireEvent.click(screen.getByRole('button', { name: 'jobs.applyLabel.registration' }));

    expect(screen.getByRole('heading', { name: 'publicVacancy.incompleteModal.title' })).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('Ver Detalles com cadastro incompleto → MESMO modal, NÃO abre o link da vaga, NENHUMA request pra track-channel', async () => {
    mockFetchOnce(legacyResponse());
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve(legacyResponse()) });
    vi.stubGlobal('fetch', fetchSpy);
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['phone']} />);
    await waitForLoaded();

    fireEvent.click(screen.getAllByRole('button', { name: 'jobs.viewDetails' })[0]);

    expect(screen.getByRole('heading', { name: 'publicVacancy.incompleteModal.title' })).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls.some((c) => String(c[0]).includes('track-channel'))).toBe(false);
    openSpy.mockRestore();
  });

  it('modal mostra o campo nomeado a partir de missingFields (mesma prop passada, sem requisição nova)', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['phone']} />);
    await waitForLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'jobs.applyLabel.registration' }));
    expect(screen.getByRole('button', { name: /phone/i })).toBeInTheDocument();
  });

  it('missingFields nulo/ausente (não apurado — GET ainda não voltou, ou backend não devolveu) → mensagem de VERIFICAÇÃO (não "incompleto"), fail-closed, sem CTA de completar', async () => {
    mockFetchOnce(legacyResponse());
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<JobsEmbeddedSection isRegistrationComplete={false} />);
    await waitForLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'jobs.apply' }));

    // Incidente 08/09: a tela NÃO PODE afirmar "incompleto" sobre um estado que
    // não apurou. Mostra o MESMO componente do PostularseErrorModal
    // (/vacantes/:id), mas com texto PRÓPRIO da home (rodada 5): o texto
    // padrão fala em WhatsApp/retry/completar — nada disso existe aqui.
    expect(screen.getByText('publicVacancy.errorModal.title')).toBeInTheDocument();
    expect(screen.getByText('publicVacancy.errorModal.bodyHome')).toBeInTheDocument();
    expect(screen.queryByText('publicVacancy.errorModal.body')).not.toBeInTheDocument();
    expect(screen.queryByText('publicVacancy.incompleteModal.bodyGeneric')).not.toBeInTheDocument();
    expect(screen.queryByText('publicVacancy.incompleteModal.title')).not.toBeInTheDocument();
    // Sem CTA de "completar registro": pode estar tudo certo, não dá pra mandar
    // completar algo que talvez já esteja completo.
    expect(screen.queryByText('publicVacancy.errorModal.complete')).not.toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('missingFields nulo em "Ver Detalles" → MESMA mensagem de verificação, link da vaga não abre', async () => {
    mockFetchOnce(legacyResponse());
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<JobsEmbeddedSection isRegistrationComplete={false} />);
    await waitForLoaded();

    fireEvent.click(screen.getAllByRole('button', { name: 'jobs.viewDetails' })[0]);

    expect(screen.getByText('publicVacancy.errorModal.title')).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it('mensagem de verificação fecha ao clicar "Cerrar"', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete={false} />);
    await waitForLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'jobs.apply' }));
    expect(screen.getByText('publicVacancy.errorModal.title')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'publicVacancy.errorModal.cancel' }));
    expect(screen.queryByText('publicVacancy.errorModal.title')).not.toBeInTheDocument();
  });

  it('missingFields=[] (array vazio, conhecido) → CONTINUA usando o modal de pendências normal (não é o caso "não apurado")', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={[]} />);
    await waitForLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'jobs.apply' }));
    expect(screen.getByText('publicVacancy.incompleteModal.title')).toBeInTheDocument();
    expect(screen.queryByText('publicVacancy.errorModal.title')).not.toBeInTheDocument();
  });

  it('fechar o modal (cancelar) esconde-o de novo', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['phone']} />);
    await waitForLoaded();

    fireEvent.click(screen.getByRole('button', { name: 'jobs.applyLabel.registration' }));
    expect(screen.getByRole('heading', { name: 'publicVacancy.incompleteModal.title' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'publicVacancy.incompleteModal.cancel' }));
    expect(screen.queryByRole('heading', { name: 'publicVacancy.incompleteModal.title' })).not.toBeInTheDocument();
  });
});

// ── Fase 4/DD5 — rótulo dinâmico do "Postularse" (usa buildPendingRows,     ──
// ── a MESMA função da lista de tarefas — sem segunda contagem)               ─

describe('JobsEmbeddedSection — rótulo dinâmico do Postularse (Fase 4, DD5)', () => {
  it('1 pendência de DOCUMENTO → rótulo vira dinâmico (jobs.applyLabel.document sob este mock literal)', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['doc_criminal_record']} profession="AT" />);
    await waitForLoaded();

    expect(screen.getByRole('button', { name: 'jobs.applyLabel.document' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'jobs.apply' })).not.toBeInTheDocument();
  });

  it('2+ pendências → rótulo vira dinâmico (jobs.applyLabel.multiple) — MESMO N que buildPendingRows devolve pra lista de tarefas', async () => {
    mockFetchOnce(legacyResponse());
    render(
      <JobsEmbeddedSection
        isRegistrationComplete={false}
        missingFields={['phone', 'doc_criminal_record', 'doc_identity_document']}
        profession="CAREGIVER"
      />,
    );
    await waitForLoaded();

    expect(screen.getByRole('button', { name: 'jobs.applyLabel.multiple' })).toBeInTheDocument();
  });

  it('cadastro COMPLETO (missingFields=[]) → rótulo continua "Postularse" original', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete missingFields={[]} />);
    await waitForLoaded();

    expect(screen.getByRole('button', { name: 'jobs.apply' })).toBeInTheDocument();
  });

  it('missingFields NULO (não apurado) → rótulo continua "Postularse" original, mesmo com profession informada', async () => {
    mockFetchOnce(legacyResponse());
    render(<JobsEmbeddedSection isRegistrationComplete={false} profession="AT" />);
    await waitForLoaded();

    expect(screen.getByRole('button', { name: 'jobs.apply' })).toBeInTheDocument();
  });

  it('todos os jobs com whatsappLink mostram o MESMO rótulo (depende só de missingFields/profession, não do job)', async () => {
    mockFetchOnce(legacyResponse({
      data: [
        { code: '1', title: 'A', workerType: 'cuidador/a', provincia: '', localidad: '', barrio: '', workerSex: '', description: '', service: '', daysAndHours: '', ageRange: '', profile: '', whatsappLink: 'https://wa.me/1', detailLink: 'https://x/1' },
        { code: '2', title: 'B', workerType: 'cuidador/a', provincia: '', localidad: '', barrio: '', workerSex: '', description: '', service: '', daysAndHours: '', ageRange: '', profile: '', whatsappLink: 'https://wa.me/2', detailLink: 'https://x/2' },
      ],
      count: 2,
    }));
    render(<JobsEmbeddedSection isRegistrationComplete={false} missingFields={['doc_criminal_record']} profession="AT" />);
    await waitForLoaded();

    expect(screen.getAllByRole('button', { name: 'jobs.applyLabel.document' })).toHaveLength(2);
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
