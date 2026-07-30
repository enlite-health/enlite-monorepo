import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { ManagementDashboardPage } from '../ManagementDashboardPage';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';

/**
 * A página inteira montada com o PAYLOAD REAL DE PRODUÇÃO.
 *
 * Os números abaixo são a saída literal de `GetManagementDashboardUseCase` rodando contra o
 * banco de produção em 30/07/2026 (worker-functions/scripts/funnel-por-prestador-proof.ts).
 * Teste com número inventado prova que a tela renderiza; com número real prova que ela
 * aguenta o dado que vai receber — inclusive os casos que só existem em produção
 * (consolidado fechando com o total, 37 agendados sem data, semana zerada).
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (!opts) return key;
      let out = key;
      for (const [k, v] of Object.entries(opts)) out += ` ${k}=${String(v)}`;
      return out;
    },
  }),
}));

// Sem mock de ícones: a página usa dezenas deles, e enumerar a lista à mão só cria um
// teste que quebra quando alguém troca um ícone. Aqui o módulo real é barato.

const PROD_PAYLOAD: ManagementDashboardData = {
  bigNumbers: {
    equiposArmados: 0,
    equiposPorArmar: 84,
    pacientesActivos: 190,
    vacantesAbiertas: 144,
    vacantesPausadas: 21,
  },
  equipoArmada: { armados: 0, porArmar: 84, semConfig: 3, pendenteClasificacao: 57 },
  horas: { totais: 3763.7, aPreencher: 2155, coberturaConSchedule: 118, coberturaSinSchedule: 26 },
  prioridades: { completosEsperandoAgendamiento: 569, profesionalesBloqueados: 6735 },
  funnelPorPrestador: {
    total: 2576,
    recorte: 'vagas-vivas',
    bloqueados: 355,
    porEtapa: {
      somavel: false,
      colunas: {
        INVITED: 466, INICIADO: 182, PRE_SCREENING: 49, IN_PROGRESS: 1347,
        COMPLETED: 604, CONFIRMED: 27, SELECTED: 10, REJECTED: 626,
      },
    },
    consolidado: {
      somavel: true,
      colunas: {
        INVITED: 303, INICIADO: 84, PRE_SCREENING: 23, IN_PROGRESS: 1173,
        COMPLETED: 585, CONFIRMED: 27, SELECTED: 10, REJECTED: 371,
      },
    },
  },
  funnel: {
    invitados: 2615, bloqueados: 668, preScreening: 93, completos: 4,
    agendados: 37, seleccionados: 10, rechazados: 2557,
  },
  encuadres: { agendadosEstaSemana: 0, semDataRegistrada: 37 },
  cadastros: {
    leads: 7029, completos: 293, alocados: 61, alocadosActivos: 49,
    alocadosCubriendoGuardias: 12, incompletos: 6735, nuevosCompletosMes: 41,
  },
};

vi.mock('@infrastructure/http/ManagementDashboardApiService', () => ({
  ManagementDashboardApiService: {
    getManagementDashboard: vi.fn(async () => PROD_PAYLOAD),
  },
}));

// ZoneAnalyticsSection busca sozinha; fora do escopo deste teste.
vi.mock('@presentation/components/features/admin/ManagementDashboard/ZoneAnalyticsSection', () => ({
  ZoneAnalyticsSection: () => <div data-testid="mgmt-zone-stub" />,
}));

describe('ManagementDashboardPage — payload real de produção (30/07/2026)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('monta a tela inteira sem quebrar', async () => {
    render(<ManagementDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('mgmt-content')).toBeInTheDocument());
    expect(screen.queryByTestId('mgmt-error')).toBeNull();
  });

  it('mostra o funil por PESSOA, com as duas vistas e o total que fecha', async () => {
    render(<ManagementDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('mgmt-funnel')).toBeInTheDocument());

    expect(screen.getByText('2576')).toBeInTheDocument();

    const consolidado = screen.getByTestId('mgmt-funnel-consolidado');
    const soma = Object.values(PROD_PAYLOAD.funnelPorPrestador.consolidado.colunas).reduce(
      (a, b) => a + b,
      0,
    );
    expect(soma).toBe(PROD_PAYLOAD.funnelPorPrestador.total); // invariante do contrato
    expect(within(consolidado).getByText(/sumsToTotal total=2576/)).toBeInTheDocument();

    // A mesma coluna com números diferentes nas duas vistas — o ponto de existirem duas.
    expect(within(consolidado).getByTestId('mgmt-funnel-consolidado-IN_PROGRESS')).toHaveTextContent('1173');
    expect(
      within(screen.getByTestId('mgmt-funnel-por-etapa')).getByTestId('mgmt-funnel-por-etapa-IN_PROGRESS'),
    ).toHaveTextContent('1347');
  });

  it('mostra IN_PROGRESS, a maior coluna do Kanban que não existia no painel', async () => {
    render(<ManagementDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('mgmt-funnel')).toBeInTheDocument());

    expect(screen.getAllByTestId(/mgmt-funnel-(consolidado|por-etapa)-IN_PROGRESS/)).toHaveLength(2);
  });

  it('admite a lacuna da agenda em vez de exibir zero mudo', async () => {
    render(<ManagementDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('mgmt-funnel')).toBeInTheDocument());

    expect(within(screen.getByTestId('mgmt-encuadres-sem-data')).getByText(/semData count=37/))
      .toBeInTheDocument();
  });

  it('mostra pacientes activos corrigido (190, não 192)', async () => {
    render(<ManagementDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('mgmt-content')).toBeInTheDocument());

    expect(screen.getByText('190')).toBeInTheDocument();
    expect(screen.queryByText('192')).toBeNull();
  });
});
