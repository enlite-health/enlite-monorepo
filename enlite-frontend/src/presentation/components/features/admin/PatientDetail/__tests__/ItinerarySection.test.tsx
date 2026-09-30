/**
 * ItinerarySection — Fase 12, DX-12.10/12.10b. Uma seção por serviço: rótulo do quadro C, par de
 * horas da fonte única, 7 dias em ordem e a recusa DITA (o número da folga vem sempre do erro).
 * i18n real (es).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { coverageHoursPair, type ItineraryOverlapDetail, type PatientItineraryService } from '@domain/entities/PatientItinerary';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';
import { ItinerarySection } from '../ItinerarySection';

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const ASOF = '2026-09-28';

const SERVICE: PatientItineraryService = {
  contractedServiceId: 'svc-1',
  contratadas: { weekly: 20, authorized: 20 },
  cobertas: 4,
  slots: [
    { id: 'slot-mon', weekday: 1, startTime: '08:00', endTime: '12:00', active: true, assignments: [] },
    { id: 'slot-wed', weekday: 3, startTime: '14:00', endTime: '18:00', active: true, assignments: [] },
  ],
};

function overlapOf(minGapMinutes: number | null): ItineraryOverlapDetail {
  return {
    existing: { serviceId: 'svc-other', weekday: 1, startTime: '07:00', endTime: '09:00' },
    requested: { serviceId: 'svc-1', weekday: 1, startTime: '08:00', endTime: '12:00' },
    sameAddress: minGapMinutes === null,
    minGapMinutes,
  };
}

function renderSection(props: Partial<Parameters<typeof ItinerarySection>[0]> = {}) {
  const onEditSlot = vi.fn();
  const utils = render(
    <ItinerarySection
      service={SERVICE}
      serviceCode="AT"
      addressLabel="Rua Augusta, 975"
      asOf={ASOF}
      actionError={null}
      onEditSlot={onEditSlot}
      {...props}
    />,
  );
  return { ...utils, onEditSlot };
}

describe('ItinerarySection — a agenda de um serviço', () => {
  it('7 cards de dia em ordem 0→6 (domingo → sábado)', () => {
    const { container } = renderSection();
    const ids = Array.from(container.querySelectorAll('[data-testid^="itinerario-dia-svc-1-"]')).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual([0, 1, 2, 3, 4, 5, 6].map((w) => `itinerario-dia-svc-1-${w}`));
    expect(screen.getAllByTestId(/^itinerario-dia-vazio-svc-1-/)).toHaveLength(5);
    expectNoRawEnumLeaks(container);
  });

  it('o título é o rótulo de serviceTypes.<code> — o mesmo do quadro C', () => {
    renderSection();
    const expected = i18n.t('admin.patients.detail.contractedServicesCard.serviceTypes.AT');
    expect(expected).not.toBe('admin.patients.detail.contractedServicesCard.serviceTypes.AT');
    expect(screen.getByRole('heading')).toHaveTextContent(expected);
  });

  it('o par de horas sai de coverageHoursPair', () => {
    renderSection();
    expect(screen.getByTestId('itinerario-servico-par-svc-1')).toHaveTextContent(
      `Horas cubiertas/contratadas: ${coverageHoursPair(4, 20)}`,
    );
  });

  it('sem horas semanais contratadas → "4/—"', () => {
    renderSection({ service: { ...SERVICE, contratadas: { weekly: null, authorized: null } } });
    expect(screen.getByTestId('itinerario-servico-par-svc-1')).toHaveTextContent('Horas cubiertas/contratadas: 4/—');
  });

  it('clicar numa faixa repassa o slotId (D445.3: a linha inteira abre "Editar agendamiento")', () => {
    const { onEditSlot } = renderSection();
    fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-wed'));
    expect(onEditSlot).toHaveBeenCalledWith('slot-wed');
  });

  it('409 com folga → os 2 horários e a folga com o número VINDO do erro', () => {
    const gap = overlapOf(37);
    renderSection({ actionError: { code: 'ITINERARY_OVERLAP', overlap: gap } });
    const alert = screen.getByTestId('itinerario-sobreposicao-erro');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveClass('text-red-600');
    expect(alert).toHaveTextContent('el prestador ya atiende lunes 07:00-09:00 y el pedido es lunes 08:00-12:00.');
    expect(alert).toHaveTextContent(`un intervalo de ${gap.minGapMinutes} min.`);
    expect(screen.queryByTestId('itinerario-acao-erro')).toBeNull();
  });

  it('409 com minGapMinutes null → sem a frase da folga', () => {
    renderSection({ actionError: { code: 'ITINERARY_OVERLAP', overlap: overlapOf(null) } });
    const alert = screen.getByTestId('itinerario-sobreposicao-erro');
    expect(alert).toHaveTextContent('Conflicto de horario');
    expect(alert).not.toHaveTextContent('intervalo');
  });

  it('outro código conhecido → itinerario-acao-erro com o texto do código', () => {
    renderSection({ actionError: { code: 'SLOT_INACTIVE' } });
    const alert = screen.getByTestId('itinerario-acao-erro');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Esta franja ya no está activa.');
    expect(screen.queryByTestId('itinerario-sobreposicao-erro')).toBeNull();
  });

  it('código desconhecido → o texto genérico, nunca o código cru', () => {
    renderSection({ actionError: { code: 'SOMETHING_NEW' } });
    const alert = screen.getByTestId('itinerario-acao-erro');
    expect(alert).toHaveTextContent('No se pudo asignar el prestador.');
    expect(alert).not.toHaveTextContent('SOMETHING_NEW');
  });

  it('sem erro → nenhum alerta', () => {
    renderSection();
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });
});
