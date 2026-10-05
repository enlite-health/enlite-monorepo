/**
 * 041 R2 — marca de estado do prestador na lista do itinerário: verde = em atendimento, azul = Equipe de
 * Resposta Rápida, SEM bolinha = Selecionado; a ordem vem da API e a tela não reordena.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { AllocationOptionStatus } from '../AllocationOptionStatus';
import { ItineraryEditAppointmentModal } from '../ItineraryEditAppointmentModal';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

describe('AllocationOptionStatus', () => {
  it('IN_SERVICE: bolinha verde + "En atención"', () => {
    render(<AllocationOptionStatus status="IN_SERVICE" data-testid="s" />);
    const dot = within(screen.getByTestId('s')).getByTestId('allocation-option-dot');
    expect(dot.className).toContain('bg-green-600');
    expect(dot.className).not.toContain('bg-blue');
    expect(screen.getByTestId('s')).toHaveTextContent('En atención');
  });

  it('QUICK_RESPONSE: bolinha azul + "Equipo de Respuesta Rápida"', () => {
    render(<AllocationOptionStatus status="QUICK_RESPONSE" data-testid="s" />);
    const dot = within(screen.getByTestId('s')).getByTestId('allocation-option-dot');
    expect(dot.className).toContain('bg-blue-600');
    expect(screen.getByTestId('s')).toHaveTextContent('Equipo de Respuesta Rápida');
  });

  it('SELECTED: nenhuma bolinha, só o rótulo "Seleccionado"', () => {
    render(<AllocationOptionStatus status="SELECTED" data-testid="s" />);
    expect(screen.queryByTestId('allocation-option-dot')).toBeNull();
    expect(screen.getByTestId('s')).toHaveTextContent('Seleccionado');
  });

  it('o modal de edição preserva a ordem da API e marca cada cartão', () => {
    const options = [
      { workerId: 'w-a', displayName: 'Ana', vacancyId: 'v', status: 'IN_SERVICE' as const },
      { workerId: 'w-b', displayName: 'Bia', vacancyId: 'v', status: 'QUICK_RESPONSE' as const },
      { workerId: 'w-c', displayName: 'Caio', vacancyId: 'v', status: 'SELECTED' as const },
    ];
    render(
      <MemoryRouter>
        <ItineraryEditAppointmentModal
          slot={{ weekday: 1, startTime: '08:00', endTime: '12:00' }}
          addressLabel="x"
          options={options}
          vacancyId="v"
          currentWorkerId={null}
          onSubmit={() => undefined}
          onCancel={() => undefined}
        />
      </MemoryRouter>,
    );
    const cards = screen.getByTestId('itinerario-editar-preselecionados').children;
    expect(Array.from(cards).map((c) => c.getAttribute('data-testid'))).toEqual([
      'itinerario-editar-card-w-a',
      'itinerario-editar-card-w-b',
      'itinerario-editar-card-w-c',
    ]);
    expect(within(screen.getByTestId('itinerario-editar-status-w-a')).getByTestId('allocation-option-dot').className).toContain('bg-green-600');
    expect(within(screen.getByTestId('itinerario-editar-status-w-b')).getByTestId('allocation-option-dot').className).toContain('bg-blue-600');
    expect(within(screen.getByTestId('itinerario-editar-status-w-c')).queryByTestId('allocation-option-dot')).toBeNull();
  });
});
