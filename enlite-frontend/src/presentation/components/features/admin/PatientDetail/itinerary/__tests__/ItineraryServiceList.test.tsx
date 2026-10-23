/**
 * ItineraryServiceList + ItineraryServiceCard — spec 069, US1/B1 (mockup desktop-light.png): o estado
 * ESTRUTURAL ("Faltan cubrir X h de Y"/"Completo") e o aviso TEMPORÁRIO ("N turnos sin cubrir en los
 * próximos {horizonDays} días", só com N > 0) são coisas separadas. O horizonte vem do GET — nunca 7 fixo.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import type { PatientItineraryService } from '@domain/entities/PatientItinerary';
import { initI18n, i18n } from './i18nSetup';
import { expectNoRawEnumLeaks } from '../../../../../../../test/rawEnumLeakGuard';
import { ItineraryServiceList } from '../ItineraryServiceList';
import { ItineraryServiceCard } from '../ItineraryServiceCard';

beforeAll(async () => {
  await initI18n('es');
});

function service(over: Partial<PatientItineraryService> = {}): PatientItineraryService {
  return {
    contractedServiceId: 'svc-1',
    scheduleHours: 24,
    cobertas: 24,
    reserve: { count: 3, minimum: 10 },
    providersNeeded: null,
    uncoveredShifts: 0,
    slots: [
      { id: 's-mon', weekday: 1, startTime: '09:00', endTime: '17:00', durationMinutes: 480, assignments: [] },
      { id: 's-sun', weekday: 0, startTime: '09:00', endTime: '17:00', durationMinutes: 480, assignments: [] },
      { id: 's-tue', weekday: 2, startTime: '09:00', endTime: '17:00', durationMinutes: 480, assignments: [] },
    ],
    ...over,
  };
}

function renderCard(over: Partial<PatientItineraryService> = {}, horizonDays = 7) {
  const onOpen = vi.fn();
  const utils = render(<ItineraryServiceCard service={service(over)} label="Cuidador" addressLabel="Av. Colón 1234, Córdoba" horizonDays={horizonDays} onOpen={onOpen} />);
  return { ...utils, onOpen };
}

describe('ItineraryServiceCard — estado estrutural', () => {
  it('completo: "Completo", nome, endereço, dias (segunda → domingo), reserva e "Organizar agenda"', () => {
    const { container, onOpen } = renderCard();
    const card = screen.getByTestId('itinerario-cartao-svc-1');
    expect(card).toHaveTextContent('Cuidador');
    expect(card).toHaveTextContent('Av. Colón 1234, Córdoba');
    expect(screen.getByTestId('itinerario-cartao-dias-svc-1')).toHaveTextContent('Lun · Mar · Dom');
    expect(screen.getByTestId('itinerario-cartao-estado-svc-1')).toHaveTextContent('Completo');
    expect(screen.getByTestId('itinerario-cartao-reserva-svc-1')).toHaveTextContent('Equipo de Respuesta Rápida: 3 de 10');
    fireEvent.click(screen.getByTestId('itinerario-cartao-abrir-svc-1'));
    expect(onOpen).toHaveBeenCalledWith('svc-1');
    expectNoRawEnumLeaks(container);
  });

  it('faltando horas: "Faltan cubrir 4 h de 20" (mesma conta cobertas ÷ horário)', () => {
    renderCard({ scheduleHours: 20, cobertas: 16 });
    expect(screen.getByTestId('itinerario-cartao-estado-svc-1')).toHaveTextContent('Faltan cubrir 4 h de 20');
  });

  it('horas fracionadas não vazam ponto flutuante', () => {
    renderCard({ scheduleHours: 10.5, cobertas: 0.1 + 0.2 });
    expect(screen.getByTestId('itinerario-cartao-estado-svc-1')).toHaveTextContent('Faltan cubrir 10.2 h de 10.5');
  });

  it('serviço sem faixa nenhuma: "Sin franjas horarias cargadas" (não "Completo") e sem linha de dias', () => {
    renderCard({ scheduleHours: 0, cobertas: 0, slots: [] });
    expect(screen.getByTestId('itinerario-cartao-estado-svc-1')).toHaveTextContent('Sin franjas horarias cargadas');
    expect(screen.queryByTestId('itinerario-cartao-dias-svc-1')).toBeNull();
  });

  it('sem vaga viva: "Equipo de Respuesta Rápida: sin vacante" (nunca 0)', () => {
    renderCard({ reserve: null });
    expect(screen.getByTestId('itinerario-cartao-reserva-svc-1')).toHaveTextContent('sin vacante');
  });
});

describe('ItineraryServiceCard — aviso temporário (FR-03)', () => {
  it('uncoveredShifts = 0 → o aviso NÃO existe', () => {
    renderCard({ uncoveredShifts: 0 });
    expect(screen.queryByTestId('itinerario-cartao-sem-cobrir-svc-1')).toBeNull();
  });

  it('1 turno (singular) e N turnos (plural), SEPARADOS do estado estrutural', () => {
    const a = renderCard({ uncoveredShifts: 1 });
    expect(screen.getByTestId('itinerario-cartao-sem-cobrir-svc-1')).toHaveTextContent('1 turno sin cubrir en los próximos 7 días');
    expect(screen.getByTestId('itinerario-cartao-estado-svc-1')).not.toHaveTextContent('sin cubrir');
    a.unmount();
    renderCard({ uncoveredShifts: 3 });
    expect(screen.getByTestId('itinerario-cartao-sem-cobrir-svc-1')).toHaveTextContent('3 turnos sin cubrir en los próximos 7 días');
    expect(screen.getByTestId('itinerario-cartao-sem-cobrir-svc-1')).toHaveAttribute('role', 'status');
  });

  it('T514 (sabotagem prevista): o número de dias vem de `horizonDays` — com 5 mostra "5", nunca "7" fixo', () => {
    renderCard({ uncoveredShifts: 2 }, 5);
    const aviso = screen.getByTestId('itinerario-cartao-sem-cobrir-svc-1');
    expect(aviso).toHaveTextContent('2 turnos sin cubrir en los próximos 5 días');
    expect(aviso).not.toHaveTextContent('7');
  });

  it('pt-BR: "2 turnos sem cobertura nos próximos 5 dias"', async () => {
    await act(async () => {
      await i18n.changeLanguage('pt-BR');
    });
    renderCard({ uncoveredShifts: 2 }, 5);
    expect(screen.getByTestId('itinerario-cartao-sem-cobrir-svc-1')).toHaveTextContent('2 turnos sem cobertura nos próximos 5 dias');
    expect(screen.getByTestId('itinerario-cartao-estado-svc-1')).toHaveTextContent('Completo');
    await act(async () => {
      await i18n.changeLanguage('es');
    });
  });
});

describe('ItineraryServiceList', () => {
  it('um cartão por serviço, na ordem da API, com o título da pergunta; "Organizar agenda" abre o serviço certo', () => {
    const onOpen = vi.fn();
    render(
      <ItineraryServiceList
        items={[
          { service: service({ contractedServiceId: 'svc-1' }), label: 'Cuidador', addressLabel: 'Av. Colón 1234' },
          { service: service({ contractedServiceId: 'svc-2', scheduleHours: 20, cobertas: 16 }), label: 'Acompañante Terapéutico', addressLabel: 'San Martín 560' },
        ]}
        horizonDays={7}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByRole('heading', { name: '¿Qué servicio querés organizar?' })).toBeInTheDocument();
    const cards = screen.getAllByTestId(/^itinerario-cartao-svc-/);
    expect(cards.map((c) => c.getAttribute('data-testid'))).toEqual(['itinerario-cartao-svc-1', 'itinerario-cartao-svc-2']);
    fireEvent.click(within(cards[1]).getByRole('button', { name: /Organizar agenda/ }));
    expect(onOpen).toHaveBeenCalledWith('svc-2');
  });
});
