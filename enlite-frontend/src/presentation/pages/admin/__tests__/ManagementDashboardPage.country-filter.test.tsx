/**
 * PR-9 (`lex` #9, US-22, L9-4) — seletor de país no cabeçalho da Gestão à Vista.
 *
 * Cobre:
 *   - o seletor lista SÓ `data.scope.countries` (nunca a lista fixa do sistema,
 *     nunca Portugal — FR-734);
 *   - trocar o país refaz a busca com `country=` novo (via
 *     ManagementDashboardApiService.getManagementDashboard);
 *   - ator com 1 país só (scope.countries=['AR']): 1 opção, sem BR.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ManagementDashboardPage } from '../ManagementDashboardPage';
import { ManagementDashboardApiService } from '@infrastructure/http/ManagementDashboardApiService';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        'admin.patients.countryOptions.AR': 'Argentina',
        'admin.patients.countryOptions.BR': 'Brasil',
        'admin.patients.countryOptions.all': 'Todos los países',
      };
      return dict[key] ?? key;
    },
  }),
}));

vi.mock('@presentation/components/features/admin/ManagementDashboard/ZoneAnalyticsSection', () => ({
  ZoneAnalyticsSection: () => <div data-testid="mgmt-zone-stub" />,
}));
vi.mock('@presentation/components/features/admin/ManagementDashboard/PacientesSection', () => ({
  PacientesSection: ({ country }: { country: string }) => (
    <div data-testid="mgmt-pacientes-stub" data-country={country} />
  ),
}));

function payloadWith(countries: Array<'AR' | 'BR'>, requested: 'AR' | 'BR' | 'ALL' = 'ALL'): ManagementDashboardData {
  return {
    scope: { countries, requested },
    bigNumbers: { equiposArmados: 0, equiposPorArmar: 0, pacientesActivos: 0, vacantesAbiertas: 0, vacantesPausadas: 0 },
    equipoArmada: { armados: 0, porArmar: 0, semConfig: 0, pendenteClasificacao: 0, pctRespostaRapidaArmado: { num: 0, den: 0, excluidos: 0, pct: null } },
    pacientes: { activos: 0, ubicacionesActivas: 0, solicitudes: 0, entrevistaAgendada: 0, enAdmision: 0, enBusca: 0, sobrepoe: true },
    horas: { totais: 0, aPreencher: 0, ativas: 0, ativasConSchedule: 0, ativasSinSchedule: 0, coberturaConSchedule: 0, coberturaSinSchedule: 0 },
    prioridades: { completosEsperandoAgendamiento: 0, registrosIncompletos: 0, bloqueadosAlPostularse: 0 },
    funnelPorPrestador: {
      total: 0, recorte: 'vagas-vivas', periodoDias: null, bloqueados: 0,
      porEtapa: { somavel: false, colunas: { INVITED: 0, INICIADO: 0, PRE_SCREENING: 0, IN_PROGRESS: 0, COMPLETED: 0, CONFIRMED: 0, SELECTED: 0, REJECTED: 0 } },
      consolidado: { somavel: true, colunas: { INVITED: 0, INICIADO: 0, PRE_SCREENING: 0, IN_PROGRESS: 0, COMPLETED: 0, CONFIRMED: 0, SELECTED: 0, REJECTED: 0 } },
    },
    funnel: { invitados: 0, bloqueados: 0, preScreening: 0, completos: 0, agendados: 0, seleccionados: 0, rechazados: 0 },
    encuadres: { agendadosEstaSemana: 0, semDataRegistrada: 0 },
    cadastros: { leads: 0, completos: 0, alocados: 0, alocadosActivos: 0, alocadosCubriendoGuardias: 0, incompletos: 0, nuevosCompletosMes: 0 },
  };
}

vi.mock('@infrastructure/http/ManagementDashboardApiService', () => ({
  ManagementDashboardApiService: { getManagementDashboard: vi.fn() },
}));

describe('ManagementDashboardPage — seletor de país (PR-9, L9-4)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ator multi-país (AR+BR): o seletor lista AS DUAS, sem Portugal nem qualquer terceiro código', async () => {
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockResolvedValue(payloadWith(['AR', 'BR']));
    render(<ManagementDashboardPage />);

    await waitFor(() => expect(screen.getByTestId('mgmt-country-filter')).toBeInTheDocument());
    const select = within(screen.getByTestId('mgmt-country-filter')).getByRole('combobox');
    const optionTexts = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);

    expect(optionTexts).toContain('Argentina');
    expect(optionTexts).toContain('Brasil');
    expect(optionTexts).not.toContain('Portugal');
    // Só as 2 jurisdições do ator + o placeholder "Todos" — nunca uma 4ª opção.
    expect(optionTexts).toHaveLength(3);
  });

  it('ator SÓ com AR (multi-país sem grant documentado, ou simplesmente 1 país): 1 opção só, sem BR', async () => {
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockResolvedValue(payloadWith(['AR'], 'ALL'));
    render(<ManagementDashboardPage />);

    await waitFor(() => expect(screen.getByTestId('mgmt-country-filter')).toBeInTheDocument());
    const select = within(screen.getByTestId('mgmt-country-filter')).getByRole('combobox');
    const optionTexts = Array.from(select.querySelectorAll('option')).map((o) => o.textContent);

    expect(optionTexts).toContain('Argentina');
    expect(optionTexts).not.toContain('Brasil');
  });

  it('trocar o país no seletor refaz a busca com `country=BR` — e a PacientesSection recebe o MESMO país', async () => {
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockResolvedValue(payloadWith(['AR', 'BR']));
    render(<ManagementDashboardPage />);

    await waitFor(() => expect(screen.getByTestId('mgmt-country-filter')).toBeInTheDocument());
    expect(screen.getByTestId('mgmt-pacientes-stub')).toHaveAttribute('data-country', '');

    const select = within(screen.getByTestId('mgmt-country-filter')).getByRole('combobox');
    await userEvent.selectOptions(select, 'BR');

    await waitFor(() => {
      const calls = vi.mocked(ManagementDashboardApiService.getManagementDashboard).mock.calls;
      expect(calls[calls.length - 1]).toEqual([null, 'BR']);
    });
    await waitFor(() => expect(screen.getByTestId('mgmt-pacientes-stub')).toHaveAttribute('data-country', 'BR'));
  });

  it('sem `scope` ainda resolvido (payload não carregado): o seletor não aparece (nunca uma lista vazia visível)', () => {
    vi.mocked(ManagementDashboardApiService.getManagementDashboard).mockReturnValue(new Promise(() => {}));
    render(<ManagementDashboardPage />);
    expect(screen.queryByTestId('mgmt-country-filter')).not.toBeInTheDocument();
  });
});
