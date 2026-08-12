/**
 * Drawer "¿Qué es este número?" com i18n REAL (recursos es de produção):
 * o botão "?" de um card abre o painel lateral com o documento do indicador
 * formatado (título + seções + bullets), e o backdrop fecha.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { HelpDrawer } from '../HelpDrawer';
import { BigNumbersSection } from '../BigNumbersSection';
import type { ManagementDashboardData } from '@domain/entities/ManagementDashboard';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: {
      es: { translation: esJson },
      'pt-BR': { translation: ptBRJson },
    },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const esHelp = (esJson as unknown as { admin: { managementDashboard: { help: Record<string, { title: string }> } } })
  .admin.managementDashboard.help;

describe('HelpDrawer (i18n real, es)', () => {
  it('renderiza título e as quatro seções do documento', () => {
    render(<HelpDrawer helpKey="equiposArmados" onClose={() => undefined} />);

    expect(screen.getByTestId('mgmt-help-drawer')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleName(esHelp.equiposArmados.title);
    for (const section of ['que', 'origen', 'cambia', 'ojo']) {
      expect(screen.getByTestId(`mgmt-help-${section}`)).toBeInTheDocument();
    }
    // bullets do "origen" viram lista de verdade, não um parágrafo com "•"
    expect(screen.getByTestId('mgmt-help-origen').querySelectorAll('li').length).toBeGreaterThan(1);
    expect(screen.getByTestId('mgmt-help-origen').textContent).not.toContain('•');
  });

  it('omite a seção "ojo" quando o indicador não a tem', () => {
    render(<HelpDrawer helpKey="solicitudes" onClose={() => undefined} />);
    expect(screen.getByTestId('mgmt-help-que')).toBeInTheDocument();
    expect(screen.queryByTestId('mgmt-help-ojo')).not.toBeInTheDocument();
  });

  it('clique no backdrop fecha (com o delay da transição)', async () => {
    let closed = false;
    render(<HelpDrawer helpKey="leads" onClose={() => (closed = true)} />);
    fireEvent.click(screen.getByTestId('mgmt-help-backdrop'));
    await waitFor(() => expect(closed).toBe(true), { timeout: 1000 });
  });
});

const dashboardFixture = {
  bigNumbers: {
    equiposArmados: 0,
    equiposPorArmar: 86,
    pacientesActivos: 193,
    vacantesAbiertas: 145,
    vacantesPausadas: 21,
  },
  pacientes: {
    activos: 193,
    ubicacionesActivas: 341,
    solicitudes: 2,
    entrevistaAgendada: 0,
    enAdmision: 5,
    enBusca: 113,
    sobrepoe: true,
  },
  horas: {
    totais: 3866.2,
    aPreencher: 2317.5,
    ativas: 941.1,
    ativasConSchedule: 40,
    ativasSinSchedule: 13,
    coberturaConSchedule: 119,
    coberturaSinSchedule: 26,
  },
  pctRespostaRapida: { num: 0, den: 86, excluidos: 59, pct: 0 },
  pctCapacidade: { agendados: 13, capacidade: 80, pct: 16.3 },
} as unknown as {
  bigNumbers: ManagementDashboardData['bigNumbers'];
  pacientes: ManagementDashboardData['pacientes'];
  horas: ManagementDashboardData['horas'];
  pctRespostaRapida: ManagementDashboardData['equipoArmada']['pctRespostaRapidaArmado'];
  pctCapacidade: ManagementDashboardData['encuadres']['pctCapacidadeSemana'];
};

describe('BigNumbersSection abre a ajuda do card certo', () => {
  it('clicar no "?" de um card abre o drawer com o título daquele indicador', () => {
    render(
      <BigNumbersSection
        data={dashboardFixture.bigNumbers}
        pacientes={dashboardFixture.pacientes}
        horas={dashboardFixture.horas}
        pctRespostaRapida={dashboardFixture.pctRespostaRapida}
        pctCapacidade={dashboardFixture.pctCapacidade}
      />,
    );

    expect(screen.queryByTestId('mgmt-help-drawer')).not.toBeInTheDocument();

    const buttons = screen.getAllByTestId('metric-help');
    // 13 cards com ajuda na seção de números clave
    expect(buttons.length).toBe(13);

    // O primeiro card da seção é o % de resposta rápida
    fireEvent.click(buttons[0]);
    expect(screen.getByTestId('mgmt-help-drawer')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveAccessibleName(esHelp.pctRespostaRapida.title);
  });
});
