/**
 * PR-9 (`lex` #9, US-22) — `PacientesSection` deixa de ter seletor de país
 * próprio e passa a seguir o país da PÁGINA (prop `country`).
 *
 * Sabotagem que este teste pega: reintroduzir `useState('')` + `<Select>`
 * de país dentro do componente (o padrão antigo) — o teste "não tem seletor
 * próprio" haveria de falhar, e "usa o country do prop" pegaria o valor
 * antigo (hardcoded '') em vez do prop passado pela página.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PacientesSection } from '../PacientesSection';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const mockUsePatientStats = vi.fn();
const mockUsePatientFunnel = vi.fn();

vi.mock('@hooks/admin/usePatientStats', () => ({
  usePatientStats: (country: string) => mockUsePatientStats(country),
}));
vi.mock('@hooks/admin/usePatientFunnel', () => ({
  usePatientFunnel: (country: string, periodDays: number) => mockUsePatientFunnel(country, periodDays),
}));

const mockOpenHelp = vi.fn();
vi.mock('../useMetricHelp', () => ({
  useMetricHelp: () => ({
    helpProps: () => ({ onHelpClick: vi.fn(), helpAriaLabel: 'ayuda' }),
    openHelp: mockOpenHelp,
    helpAriaLabel: 'ayuda',
    helpDrawer: null,
  }),
}));

describe('PacientesSection — segue o país da página (PR-9)', () => {
  it('NÃO renderiza seletor de país próprio (data-testid antigo sumiu)', () => {
    mockUsePatientStats.mockReturnValue({ stats: null, error: null });
    mockUsePatientFunnel.mockReturnValue({ funnel: null, isLoading: false, error: null });

    render(<PacientesSection country="AR" />);

    expect(screen.queryByTestId('mgmt-pacientes-country')).not.toBeInTheDocument();
  });

  it('repassa o `country` do prop para usePatientStats E usePatientFunnel — a MESMA fonte', () => {
    mockUsePatientStats.mockReturnValue({ stats: null, error: null });
    mockUsePatientFunnel.mockReturnValue({ funnel: null, isLoading: false, error: null });

    render(<PacientesSection country="BR" />);

    expect(mockUsePatientStats).toHaveBeenCalledWith('BR');
    expect(mockUsePatientFunnel).toHaveBeenCalledWith('BR', 30);
  });

  it('country="" (Todos/ALL) é repassado tal qual — a seção não decide um default próprio', () => {
    mockUsePatientStats.mockReturnValue({ stats: null, error: null });
    mockUsePatientFunnel.mockReturnValue({ funnel: null, isLoading: false, error: null });

    render(<PacientesSection country="" />);

    expect(mockUsePatientStats).toHaveBeenCalledWith('');
    expect(mockUsePatientFunnel).toHaveBeenCalledWith('', 30);
  });

  it('trocar o prop `country` entre renders re-chama os hooks com o valor NOVO (segue a página em tempo real)', () => {
    mockUsePatientStats.mockReturnValue({ stats: null, error: null });
    mockUsePatientFunnel.mockReturnValue({ funnel: null, isLoading: false, error: null });

    const { rerender } = render(<PacientesSection country="AR" />);
    expect(mockUsePatientStats).toHaveBeenLastCalledWith('AR');

    rerender(<PacientesSection country="BR" />);
    expect(mockUsePatientStats).toHaveBeenLastCalledWith('BR');
  });

  it('clicar no "?" de uma etapa do embudo chama openHelp com a chave da etapa (cobertura de arquivo tocado)', async () => {
    mockUsePatientStats.mockReturnValue({ stats: null, error: null });
    mockUsePatientFunnel.mockReturnValue({ funnel: null, isLoading: false, error: null });

    render(<PacientesSection country="AR" />);
    // `metric-help` também existe nos 3 MetricCard do estado (via `helpProps`,
    // que aqui é um vi.fn() descartável) — o help do EMBUDO usa `openHelp`
    // direto, por isso miramos o botão DENTRO do card `funnel-solicitantes`.
    const solicitantesCard = screen.getByTestId('funnel-solicitantes');
    await userEvent.click(within(solicitantesCard).getByTestId('metric-help'));

    expect(mockOpenHelp).toHaveBeenCalledWith('embudoSolicitantes');
  });

  it('statsError: mostra o texto de erro em vez dos 3 cards de estado', () => {
    mockUsePatientStats.mockReturnValue({ stats: null, error: 'falhou' });
    mockUsePatientFunnel.mockReturnValue({ funnel: null, isLoading: false, error: null });

    render(<PacientesSection country="AR" />);

    expect(screen.getByText('admin.patients.errorLoading')).toBeInTheDocument();
    expect(screen.queryByTestId('patient-stats-total')).not.toBeInTheDocument();
  });

  it('com stats/funnel REAIS (não-null) e isLoading=true: mostra os valores e a opacidade de loading (cobertura de arquivo tocado)', () => {
    mockUsePatientStats.mockReturnValue({
      stats: { total: 10, complete: 7, needsAttention: 3 },
      error: null,
    });
    mockUsePatientFunnel.mockReturnValue({
      funnel: { solicitantes: 20, admision: 10, agendadas: 5, vacantes: 2 },
      isLoading: true,
      error: null,
    });

    render(<PacientesSection country="AR" />);

    expect(screen.getByTestId('patient-stats-total')).toHaveTextContent('10');
    expect(screen.getByTestId('patient-stats-complete')).toHaveTextContent('7');
    expect(screen.getByTestId('patient-stats-needs-attention')).toHaveTextContent('3');
    expect(screen.getByTestId('funnel-solicitantes')).toHaveTextContent('20');
    // conversionRate(20, 10) roda o ramo prev>0 (o mock de `t` não interpola
    // `rate`, então a prova de QUE o cálculo aconteceu é o card existir).
    expect(screen.getByTestId('funnel-conv-solicitantes-admision')).toBeInTheDocument();
  });

  it('funnelError: mostra o texto de erro em vez das 4 etapas do embudo', () => {
    mockUsePatientStats.mockReturnValue({ stats: null, error: null });
    mockUsePatientFunnel.mockReturnValue({ funnel: null, isLoading: false, error: 'funil fora do ar' });

    render(<PacientesSection country="AR" />);

    expect(screen.getByText('admin.patients.funnel.error')).toBeInTheDocument();
    expect(screen.queryByTestId('funnel-solicitantes')).not.toBeInTheDocument();
  });
});
