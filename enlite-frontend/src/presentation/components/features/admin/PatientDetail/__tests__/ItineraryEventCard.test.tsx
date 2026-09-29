/**
 * ItineraryEventCard — D445.3/D445.4 (nó Figma 11340:76255). Data + dia, horário, endereço de
 * ENTRADA (D445.6), quem cobre e a marca substituto/descoberto; cancelar/trocar SÓ com
 * `absenceId` (uma ausência aberta) — evento sem ausência é só informativo.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { PatientItineraryEvent } from '@domain/entities/PatientItinerary';
import { ItineraryEventCard } from '../ItineraryEventCard';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

beforeEach(() => {
  useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
});

function event(over: Partial<PatientItineraryEvent> = {}): PatientItineraryEvent {
  return {
    date: '2026-09-27',
    weekday: 0,
    serviceId: 'svc-1',
    slotId: 'slot-1',
    assignmentId: 'assign-1',
    startTime: '09:00',
    endTime: '13:00',
    titularWorkerId: 'w-titular',
    titularDisplayName: 'Alberto Marquez',
    status: 'covered',
    workerId: 'w-titular',
    workerDisplayName: 'Alberto Marquez',
    substituteWorkerId: null,
    substituteDisplayName: null,
    absenceId: null,
    ...over,
  };
}

function renderCard(over: Partial<PatientItineraryEvent> = {}) {
  const onLoadSubstituteOptions = vi.fn();
  const onChangeSubstitute = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ItineraryEventCard
      event={event(over)}
      addressLabel="Rua Augusta, 975"
      substituteOptions={null}
      onLoadSubstituteOptions={onLoadSubstituteOptions}
      onChangeSubstitute={onChangeSubstitute}
      onCancel={onCancel}
    />,
  );
  return { ...utils, onLoadSubstituteOptions, onChangeSubstitute, onCancel };
}

describe('ItineraryEventCard', () => {
  it('evento covered: mostra data, horário, endereço e o titular; sem ação de cancelar/trocar', () => {
    renderCard();
    const wrapper = screen.getByTestId('itinerario-evento-assign-1-2026-09-27');
    expect(wrapper).toHaveTextContent('27/09');
    expect(wrapper).toHaveTextContent('domingo');
    expect(screen.getByTestId('itinerario-evento-horario-assign-1-2026-09-27')).toHaveTextContent('09:00 - 13:00');
    expect(screen.getByTestId('itinerario-evento-prestador-assign-1-2026-09-27')).toHaveTextContent('Alberto Marquez');
    expect(screen.queryByTestId('itinerario-evento-status-assign-1-2026-09-27')).toBeNull();
    expect(screen.queryByTestId('itinerario-evento-trocar-abs-1')).toBeNull();
  });

  it('evento uncovered: marca "Sin cobertura" e workerId nulo', () => {
    renderCard({ status: 'uncovered', workerId: null, workerDisplayName: null, absenceId: 'abs-1' });
    expect(screen.getByTestId('itinerario-evento-status-assign-1-2026-09-27')).toHaveTextContent('Sin cobertura');
    expect(screen.getByTestId('itinerario-evento-prestador-assign-1-2026-09-27')).toHaveTextContent('Sin cobertura');
  });

  it('evento substituted: marca "Sustituido" e mostra o substituto', () => {
    renderCard({ status: 'substituted', workerId: 'w-sub', workerDisplayName: 'Paula Antonia', substituteWorkerId: 'w-sub', substituteDisplayName: 'Paula Antonia', absenceId: 'abs-1' });
    expect(screen.getByTestId('itinerario-evento-status-assign-1-2026-09-27')).toHaveTextContent('Sustituido');
    expect(screen.getByTestId('itinerario-evento-prestador-assign-1-2026-09-27')).toHaveTextContent('Paula Antonia');
  });

  it('com absenceId: "Cambiar sustituto"/"Cancelar" aparecem; clicar Cambiar chama onLoadSubstituteOptions', () => {
    const { onLoadSubstituteOptions } = renderCard({ absenceId: 'abs-1', status: 'uncovered', workerId: null });
    expect(screen.getByTestId('itinerario-evento-trocar-abs-1')).toBeInTheDocument();
    expect(screen.getByTestId('itinerario-evento-cancelar-abs-1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('itinerario-evento-trocar-abs-1'));
    expect(onLoadSubstituteOptions).toHaveBeenCalledTimes(1);
  });

  it('clicar Cancelar chama onCancel', () => {
    const { onCancel } = renderCard({ absenceId: 'abs-1' });
    fireEvent.click(screen.getByTestId('itinerario-evento-cancelar-abs-1'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('D445.6: NENHUM texto "Regular" ou "Final de semana" no card', () => {
    renderCard();
    expect(screen.queryByText(/^Regular$/)).toBeNull();
    expect(screen.queryByText(/Final de semana|Fin de semana/i)).toBeNull();
  });
});
