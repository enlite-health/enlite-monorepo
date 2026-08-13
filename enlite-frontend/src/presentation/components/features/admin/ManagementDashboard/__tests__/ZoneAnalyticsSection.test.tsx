/**
 * ZoneAnalyticsSection — prova de que os dados do backend chegam na tela
 * (fidelidade request -> DOM) e que o filtro de profissão nunca vaza enum cru
 * (AT/CAREGIVER/NURSE/KINESIOLOGIST/PSYCHOLOGIST sempre traduzidos via i18n
 * real, ver CLAUDE.md). Enum é o mesmo SSOT de WORKER_PROFESSIONS — labels
 * reusadas de admin.vacancyDetail.vacancyForm.professionOptions.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';

import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { ZoneAnalyticsSection } from '../ZoneAnalyticsSection';
import { useZoneAnalytics } from '@hooks/admin/useZoneAnalytics';

vi.mock('@hooks/admin/useZoneAnalytics');
const mockUseZoneAnalytics = vi.mocked(useZoneAnalytics);

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

beforeEach(() => {
  vi.clearAllMocks();
  i18n.changeLanguage('es');
});

const POPULATED = {
  zones: [
    { zone: 'Palermo', patients: 41, workersMale: 7, workersFemale: 13, demand: 55, availability: 9 },
    { zone: 'Não informado', patients: 3, workersMale: 0, workersFemale: 1, demand: 2, availability: 1 },
  ],
  unresolvedCount: 4,
};

describe('ZoneAnalyticsSection', () => {
  it('estado de loading mostra o skeleton', () => {
    mockUseZoneAnalytics.mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
      refetch: vi.fn(),
    });

    render(<ZoneAnalyticsSection />);
    expect(screen.getByTestId('mgmt-zone-analytics-loading')).toBeInTheDocument();
  });

  it('estado de erro mostra alerta e o retry chama refetch', () => {
    const refetch = vi.fn();
    mockUseZoneAnalytics.mockReturnValue({
      data: null,
      isLoading: false,
      error: 'HTTP 500',
      refetch,
    });

    render(<ZoneAnalyticsSection />);
    expect(screen.getByTestId('mgmt-zone-analytics-error')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reintentar/i }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('estado vazio (zones=[]) mostra a mensagem de empty state', () => {
    mockUseZoneAnalytics.mockReturnValue({
      data: { zones: [], unresolvedCount: 0 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<ZoneAnalyticsSection />);
    expect(screen.getByText(/Todavía no hay datos de zona/)).toBeInTheDocument();
  });

  it('populado: números do mock chegam nas células da tabela (fidelidade request -> DOM)', () => {
    mockUseZoneAnalytics.mockReturnValue({
      data: POPULATED,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    const { container } = render(<ZoneAnalyticsSection />);

    // Zona + números de Palermo chegam intactos no DOM.
    expect(screen.getByText('Palermo')).toBeInTheDocument();
    expect(screen.getByText('41')).toBeInTheDocument(); // patients
    expect(screen.getByText('7')).toBeInTheDocument(); // workersMale
    expect(screen.getByText('13')).toBeInTheDocument(); // workersFemale
    expect(screen.getByText('55')).toBeInTheDocument(); // demand
    expect(screen.getByText('9')).toBeInTheDocument(); // availability

    // Nota de "Não informado" (unresolvedCount) é sinalizada, não some.
    expect(screen.getByTestId('mgmt-zone-analytics-unresolved-note')).toHaveTextContent('4');

    expectNoRawEnumLeaks(container);
  });

  it('nota de "Não informado" pluraliza corretamente: singular (count=1) vs plural (count>1)', () => {
    mockUseZoneAnalytics.mockReturnValue({
      data: { zones: [{ zone: 'Palermo', patients: 1, workersMale: 0, workersFemale: 0, demand: 1, availability: 0 }], unresolvedCount: 1 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    const { rerender } = render(<ZoneAnalyticsSection />);
    // count=1 → forma singular ("1 registro", sem "s").
    expect(screen.getByTestId('mgmt-zone-analytics-unresolved-note')).toHaveTextContent(
      '1 registro sin zona identificada',
    );
    expect(screen.getByTestId('mgmt-zone-analytics-unresolved-note')).not.toHaveTextContent(
      '1 registros',
    );

    mockUseZoneAnalytics.mockReturnValue({
      data: { zones: [], unresolvedCount: 4 },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    rerender(<ZoneAnalyticsSection />);
    // count>1 → forma plural ("4 registros").
    expect(screen.getByTestId('mgmt-zone-analytics-unresolved-note')).toHaveTextContent(
      '4 registros sin zona identificada',
    );
  });

  it('filtro de profissão: opções mostram rótulo traduzido, nunca o enum cru', () => {
    mockUseZoneAnalytics.mockReturnValue({
      data: POPULATED,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<ZoneAnalyticsSection />);

    expect(screen.getByRole('option', { name: 'Acompañante Terapéutico' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Cuidador/a' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Enfermero/a' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Kinesiólogo/a' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Psicólogo/a' })).toBeInTheDocument();
    expect(screen.queryByText('CAREGIVER')).not.toBeInTheDocument();
    expect(screen.queryByText('NURSE')).not.toBeInTheDocument();
    expect(screen.queryByText('KINESIOLOGIST')).not.toBeInTheDocument();
    expect(screen.queryByText('PSYCHOLOGIST')).not.toBeInTheDocument();
  });

  it('selecionar profissão dispara o hook com o novo valor; "Todas" limpa de volta', () => {
    mockUseZoneAnalytics.mockReturnValue({
      data: POPULATED,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<ZoneAnalyticsSection />);

    expect(mockUseZoneAnalytics).toHaveBeenLastCalledWith(undefined);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'CAREGIVER' } });
    expect(mockUseZoneAnalytics).toHaveBeenLastCalledWith('CAREGIVER');

    fireEvent.click(screen.getByRole('button', { name: 'Todas' }));
    expect(mockUseZoneAnalytics).toHaveBeenLastCalledWith(undefined);
  });

  it('selecionar o valor vazio direto no <select> (voltar pro placeholder) também limpa o filtro', () => {
    mockUseZoneAnalytics.mockReturnValue({
      data: POPULATED,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });

    render(<ZoneAnalyticsSection />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'CAREGIVER' } });
    expect(mockUseZoneAnalytics).toHaveBeenLastCalledWith('CAREGIVER');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    expect(mockUseZoneAnalytics).toHaveBeenLastCalledWith(undefined);
  });
});
