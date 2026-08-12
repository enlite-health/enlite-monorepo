import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { FunnelTotalsSection } from '../FunnelTotalsSection';
import type { FunnelColumnCounts } from '@domain/entities/ManagementDashboard';

// i18n mock — interpola {{total}} para provar que o aviso de somabilidade carrega o número.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, number>) => {
      if (!opts) return key;
      let out = key;
      for (const [k, v] of Object.entries(opts)) out += ` ${k}=${v}`;
      return out;
    },
  }),
}));

vi.mock('lucide-react', () => {
  const Stub = (props: Record<string, unknown>) => <svg {...props} />;
  return { Filter: Stub, Users: Stub, AlertTriangle: Stub, Info: Stub, CalendarCheck: Stub, ShieldAlert: Stub, HelpCircle: Stub, X: Stub };
});

function counts(partial: Partial<FunnelColumnCounts>): FunnelColumnCounts {
  return {
    INVITED: 0, INICIADO: 0, PRE_SCREENING: 0, IN_PROGRESS: 0,
    COMPLETED: 0, CONFIRMED: 0, SELECTED: 0, REJECTED: 0,
    ...partial,
  };
}

// Números reais de produção (30/07/2026) — a tela tem que aguentar o dado de verdade.
const funnelPorPrestador = {
  total: 2575,
  recorte: 'vagas-vivas' as const,
  periodoDias: null,
  bloqueados: 355,
  porEtapa: {
    somavel: false as const,
    colunas: counts({
      INVITED: 466, INICIADO: 181, PRE_SCREENING: 49, IN_PROGRESS: 1347,
      COMPLETED: 604, CONFIRMED: 27, SELECTED: 10, REJECTED: 626,
    }),
  },
  consolidado: {
    somavel: true as const,
    colunas: counts({
      INVITED: 303, INICIADO: 83, PRE_SCREENING: 23, IN_PROGRESS: 1173,
      COMPLETED: 585, CONFIRMED: 27, SELECTED: 10, REJECTED: 371,
    }),
  },
};

const encuadres = { agendadosEstaSemana: 3, semDataRegistrada: 12 };

describe('FunnelTotalsSection', () => {
  it('mostra o total de PESSOAS no funil, não a soma de cards', () => {
    render(<FunnelTotalsSection funnelPorPrestador={funnelPorPrestador} encuadres={encuadres} />);
    expect(screen.getByText('2575')).toBeInTheDocument();
  });

  it('renderiza as DUAS vistas, cada uma com suas colunas', () => {
    render(<FunnelTotalsSection funnelPorPrestador={funnelPorPrestador} encuadres={encuadres} />);

    const consolidado = screen.getByTestId('mgmt-funnel-consolidado');
    const porEtapa = screen.getByTestId('mgmt-funnel-por-etapa');

    // Mesma coluna, números diferentes: é o ponto das duas vistas existirem.
    expect(within(consolidado).getByTestId('mgmt-funnel-consolidado-IN_PROGRESS')).toHaveTextContent('1173');
    expect(within(porEtapa).getByTestId('mgmt-funnel-por-etapa-IN_PROGRESS')).toHaveTextContent('1347');
  });

  it('exibe IN_PROGRESS — a maior coluna do Kanban, que não existia no painel', () => {
    render(<FunnelTotalsSection funnelPorPrestador={funnelPorPrestador} encuadres={encuadres} />);
    expect(screen.getAllByTestId(/mgmt-funnel-(consolidado|por-etapa)-IN_PROGRESS/)).toHaveLength(2);
  });

  it('declara qual vista soma e qual não soma, com o total junto', () => {
    render(<FunnelTotalsSection funnelPorPrestador={funnelPorPrestador} encuadres={encuadres} />);

    expect(
      within(screen.getByTestId('mgmt-funnel-consolidado')).getByText(/sumsToTotal total=2575/),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('mgmt-funnel-por-etapa')).getByText(/doesNotSum total=2575/),
    ).toBeInTheDocument();
  });

  it('mostra entrevistas da semana e expõe quantos estão sem data (adoção da captura)', () => {
    render(<FunnelTotalsSection funnelPorPrestador={funnelPorPrestador} encuadres={encuadres} />);

    expect(screen.getByText('3')).toBeInTheDocument();
    const aviso = screen.getByTestId('mgmt-encuadres-sem-data');
    expect(within(aviso).getByText(/semData count=12/)).toBeInTheDocument();
  });

  it('não polui a tela com o aviso quando todos os agendados têm data', () => {
    render(
      <FunnelTotalsSection
        funnelPorPrestador={funnelPorPrestador}
        encuadres={{ agendadosEstaSemana: 5, semDataRegistrada: 0 }}
      />,
    );

    expect(screen.queryByTestId('mgmt-encuadres-sem-data')).toBeNull();
  });

  it('mostra "Bloqueados" FORA das colunas — tentativa barrada não tem candidatura', () => {
    render(<FunnelTotalsSection funnelPorPrestador={funnelPorPrestador} encuadres={encuadres} />);

    // Aparece como card próprio, não como 9ª coluna: somá-lo quebraria o total.
    expect(screen.getByText('355')).toBeInTheDocument();
    expect(screen.queryByTestId('mgmt-funnel-consolidado-BLOQUEADO')).toBeNull();
    expect(screen.queryByTestId('mgmt-funnel-por-etapa-BLOQUEADO')).toBeNull();
  });

  it('mostra zero como 0 em coluna vazia (nunca célula em branco)', () => {
    const vazio = {
      ...funnelPorPrestador,
      total: 0,
      porEtapa: { somavel: false as const, colunas: counts({}) },
      consolidado: { somavel: true as const, colunas: counts({}) },
    };
    render(<FunnelTotalsSection funnelPorPrestador={vazio} encuadres={encuadres} />);

    expect(screen.getByTestId('mgmt-funnel-consolidado-SELECTED')).toHaveTextContent('0');
  });

  it('seletor de período: só aparece com callback, e clicar chama onPeriodChange', () => {
    const onPeriodChange = vi.fn();
    const { rerender } = render(
      <FunnelTotalsSection funnelPorPrestador={funnelPorPrestador} encuadres={encuadres} />,
    );
    // Sem callback (ex.: consumidor antigo) o filtro não renderiza.
    expect(screen.queryByTestId('mgmt-funnel-period-filter')).not.toBeInTheDocument();

    rerender(
      <FunnelTotalsSection
        funnelPorPrestador={funnelPorPrestador}
        encuadres={encuadres}
        period={null}
        onPeriodChange={onPeriodChange}
      />,
    );
    fireEvent.click(screen.getByTestId('mgmt-funnel-period-7'));
    expect(onPeriodChange).toHaveBeenCalledWith(7);
    fireEvent.click(screen.getByTestId('mgmt-funnel-period-todo'));
    expect(onPeriodChange).toHaveBeenCalledWith(null);
  });
});
