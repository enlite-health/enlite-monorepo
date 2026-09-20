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
 *
 * ⚠️ SNAPSHOT DATADO — não atualizar os números para "acompanhar" produção. O payload é
 * de 30/07/2026 e é ANTERIOR à mudança de 16/08/2026, quando a capacidade semanal de
 * encuadres (ENCUADRE_WEEKLY_CAPACITY) passou de 80 para 30. Por isso
 * `pctCapacidadeSemana.capacidade` segue 80 aqui: é o valor que prod devolvia naquele dia.
 * Trocar por 30 falsificaria o snapshot. Quem quiser um payload atual, capture um novo.
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
  // PR-9 (`lex` #9): payload de 30/07/2026 é ANTERIOR ao filtro de país — não
  // dá pra "capturar" um scope real de época. AR+ALL é o caso trivial (ator
  // de 1 país só), consistente com o snapshot datado do resto do payload.
  scope: { countries: ['AR'], requested: 'ALL' },
  bigNumbers: {
    equiposArmados: 0,
    equiposPorArmar: 84,
    pacientesActivos: 190,
    vacantesAbiertas: 144,
    vacantesPausadas: 21,
  },
  equipoArmada: {
    armados: 0, porArmar: 84, semConfig: 3, pendenteClasificacao: 57,
    // 0% honesto: nenhum caso medível com 10 substitutos; 60 casos fora do denominador.
    pctRespostaRapidaArmado: { num: 0, den: 84, excluidos: 60, pct: 0 },
  },
  // Linha RODANDO + CHEGANDO (payload real de 31/07: prova da task 1.0)
  pacientes: {
    activos: 190, ubicacionesActivas: 339,
    solicitudes: 0, entrevistaAgendada: 1, enAdmision: 5, enBusca: 112,
    sobrepoe: true as const,
  },
  horas: { totais: 3763.7, aPreencher: 2155, ativas: 987.5, ativasConSchedule: 38, ativasSinSchedule: 12, coberturaConSchedule: 118, coberturaSinSchedule: 26 },
  // registrosIncompletos = worker.incompletos (mesma fonte de cadastros.incompletos, 6735).
  // bloqueadosAlPostularse = pessoas distintas em vaga viva, mesma fonte de
  // funnelPorPrestador.bloqueados (355) neste payload.
  prioridades: { completosEsperandoAgendamiento: 569, registrosIncompletos: 6735, bloqueadosAlPostularse: 355 },
  funnelPorPrestador: {
    total: 2576,
    recorte: 'vagas-vivas',
    periodoDias: null,
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
  encuadres: {
    agendadosEstaSemana: 0,
    semDataRegistrada: 37,
    pctCapacidadeSemana: { agendados: 0, capacidade: 80, pct: 0 },
  },
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

  it('números clave no desenho do Diego: percentuais, RODANDO e CHEGANDO (sem soma entre linhas)', async () => {
    render(<ManagementDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('mgmt-big-numbers')).toBeInTheDocument());

    // Percentuais em linha própria (call 02:01), com as partes visíveis.
    const pcts = screen.getByTestId('mgmt-percentuais');
    // % RR honesto (0/84) e % capacidade (0/80) — os DOIS cards, cada um com as partes.
    expect(within(pcts).getAllByText('0%')).toHaveLength(2);
    expect(within(pcts).getByText(/num=0 den=84 excluidos=60/)).toBeInTheDocument();
    expect(within(pcts).getByText(/agendados=0 capacidade=80/)).toBeInTheDocument();

    // RODANDO: ubicaciones deduplicadas + horas ativas.
    const rodando = screen.getByTestId('mgmt-rodando');
    expect(within(rodando).getByText('339')).toBeInTheDocument();
    expect(within(rodando).getByText('987.5')).toBeInTheDocument();

    // CHEGANDO: os 4 estados do Diego, com os números provados contra prod (1.0).
    const chegando = screen.getByTestId('mgmt-chegando');
    expect(within(chegando).getByText('112')).toBeInTheDocument(); // Em Busca
    expect(within(chegando).getByText('5')).toBeInTheDocument(); // Em Admissão
  });

  it('ordem das seções: Registros de prestadores vem ANTES da Totalización (call 02:21)', async () => {
    render(<ManagementDashboardPage />);
    await waitFor(() => expect(screen.getByTestId('mgmt-content')).toBeInTheDocument());

    const cadastros = screen.getByTestId('mgmt-cadastros');
    const funnel = screen.getByTestId('mgmt-funnel');
    // DOCUMENT_POSITION_FOLLOWING (4): funnel vem DEPOIS de cadastros no DOM.
    expect(cadastros.compareDocumentPosition(funnel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
