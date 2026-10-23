/**
 * FixedScheduleTab — "Horario fijo": a agenda de hoje (7 cards de dia) filtrada ao serviço, sem mudança de comportamento.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { PatientItineraryService } from '@domain/entities/PatientItinerary';
import { initI18n } from './i18nSetup';
import { FixedScheduleTab } from '../FixedScheduleTab';

beforeAll(async () => {
  await initI18n('es');
});

const SERVICE: PatientItineraryService = {
  contractedServiceId: 'svc-1',
  scheduleHours: 8,
  cobertas: 0,
  reserve: null,
  providersNeeded: null,
  uncoveredShifts: 0,
  slots: [{ id: 'slot-mon', weekday: 1, startTime: '09:00', endTime: '17:00', durationMinutes: 480, assignments: [] }],
};

describe('FixedScheduleTab', () => {
  it('embrulha a ItinerarySection do serviço (7 dias) e repassa o clique da faixa ao editor', () => {
    const onEditSlot = vi.fn();
    render(<FixedScheduleTab service={SERVICE} serviceCode="AT" addressLabel="Rua A, 1" asOf="2026-11-02" actionError={null} onEditSlot={onEditSlot} />);
    expect(screen.getByTestId('itinerario-horario-fijo')).toBeInTheDocument();
    expect(screen.getByTestId('itinerario-servico-svc-1')).toBeInTheDocument();
    expect(screen.getAllByTestId(/^itinerario-dia-svc-1-/)).toHaveLength(7);
    fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-mon'));
    expect(onEditSlot).toHaveBeenCalledWith('slot-mon');
  });
});
