/**
 * PatientItineraryTab — Fase 12, DX-12.10. A aba só orquestra: estados de carga pelo hook
 * (mockado — a busca tem suíte própria), uma seção por serviço, abrir o modal busca as opções 1×
 * e confirmar chama `allocate(serviceId, slotId, workerId)` e fecha. i18n real (es).
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientContractedServiceDetail, PatientDetail } from '@domain/entities/PatientDetail';
import type { PatientItinerary } from '@domain/entities/PatientItinerary';
import type { AllocationOptionsLoad, UsePatientItineraryResult } from '@hooks/admin/usePatientItinerary';
import { PatientItineraryTab } from '../PatientItineraryTab';
import { patientDetailFixture } from './patientDetailFixture';

const mockUsePatientItinerary = vi.fn<[string], UsePatientItineraryResult>();
vi.mock('@hooks/admin/usePatientItinerary', () => ({
  usePatientItinerary: (patientId: string) => mockUsePatientItinerary(patientId),
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: 'es',
    fallbackLng: 'es',
    resources: { es: { translation: esJson }, 'pt-BR': { translation: ptBRJson } },
    interpolation: { escapeValue: false },
    initImmediate: false,
  });
});

const PATIENT: PatientDetail = {
  ...patientDetailFixture,
  contractedServices: [
    { id: 'svc-1', serviceCode: 'AT' },
    { id: 'svc-2', serviceCode: 'AT' },
  ] as PatientContractedServiceDetail[],
};

const ITINERARY: PatientItinerary = {
  patientId: PATIENT.id,
  asOf: '2026-09-28',
  alerts: [],
  services: [
    {
      contractedServiceId: 'svc-1',
      contratadas: { weekly: 20, authorized: 20 },
      cobertas: 0,
      slots: [{ id: 'slot-1', weekday: 1, startTime: '08:00', endTime: '12:00', active: true, assignments: [] }],
    },
    {
      contractedServiceId: 'svc-2',
      contratadas: { weekly: 10, authorized: 10 },
      cobertas: 0,
      slots: [{ id: 'slot-2', weekday: 2, startTime: '09:00', endTime: '11:00', active: true, assignments: [] }],
    },
  ],
};

let loadOptions: ReturnType<typeof vi.fn<[string], Promise<AllocationOptionsLoad>>>;
let allocate: ReturnType<typeof vi.fn<[string, string, string], Promise<void>>>;

function hookState(over: Partial<UsePatientItineraryResult> = {}): UsePatientItineraryResult {
  return { itinerary: ITINERARY, status: 'ok', loadOptions, allocate, actionError: null, refreshError: false, ...over };
}

beforeEach(() => {
  loadOptions = vi.fn<[string], Promise<AllocationOptionsLoad>>().mockResolvedValue({
    status: 'ok',
    options: [{ workerId: 'w-opt-1', displayName: 'Dana Fixture', vacancyId: 'vac-1' }],
  });
  allocate = vi.fn<[string, string, string], Promise<void>>().mockResolvedValue(undefined);
  mockUsePatientItinerary.mockReset();
});

describe('PatientItineraryTab — a aba do itinerário', () => {
  it('loading → skeleton, sem seção', () => {
    mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: null, status: 'loading' }));
    render(<PatientItineraryTab patient={PATIENT} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('itinerario-servico-svc-1')).toBeNull();
    expect(mockUsePatientItinerary).toHaveBeenCalledWith(PATIENT.id);
  });

  it.each(['error', 'forbidden'] as const)('%s → itinerario-erro (alert)', (status) => {
    mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: null, status }));
    render(<PatientItineraryTab patient={PATIENT} />);
    expect(screen.getByTestId('itinerario-erro')).toHaveAttribute('role', 'alert');
  });

  it('sem serviços → itinerario-sem-servicos', () => {
    mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: { ...ITINERARY, services: [] } }));
    render(<PatientItineraryTab patient={PATIENT} />);
    expect(screen.getByTestId('itinerario-sem-servicos')).toHaveTextContent('Este paciente no tiene servicios contratados activos.');
  });

  it('2 serviços → 2 seções, na ordem da API', () => {
    mockUsePatientItinerary.mockReturnValue(hookState());
    const { container } = render(<PatientItineraryTab patient={PATIENT} />);
    const ids = Array.from(container.querySelectorAll('section[data-testid^="itinerario-servico-"]')).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['itinerario-servico-svc-1', 'itinerario-servico-svc-2']);
  });

  it('refreshError → itinerario-refresh-erro', () => {
    mockUsePatientItinerary.mockReturnValue(hookState({ refreshError: true }));
    render(<PatientItineraryTab patient={PATIENT} />);
    expect(screen.getByTestId('itinerario-refresh-erro')).toHaveAttribute('role', 'alert');
  });

  it('abrir o modal chama loadOptions 1× com o serviço; confirmar chama allocate(serviceId, slotId, workerId) e fecha', async () => {
    mockUsePatientItinerary.mockReturnValue(hookState());
    render(<PatientItineraryTab patient={PATIENT} />);
    fireEvent.click(screen.getByTestId('itinerario-slot-asignar-slot-2'));
    expect(loadOptions).toHaveBeenCalledTimes(1);
    expect(loadOptions).toHaveBeenCalledWith('svc-2');
    const modal = screen.getByTestId('itinerario-alocar-modal');
    await waitFor(() => expect(within(modal).getByTestId('itinerario-alocar-prestador')).toBeEnabled());

    fireEvent.click(within(modal).getByTestId('itinerario-alocar-prestador'));
    fireEvent.click(screen.getByRole('option', { name: 'Dana Fixture' }));
    fireEvent.click(screen.getByTestId('itinerario-alocar-confirmar'));
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(allocate).toHaveBeenCalledWith('svc-2', 'slot-2', 'w-opt-1');
    expect(screen.queryByTestId('itinerario-alocar-modal')).toBeNull();
  });

  it('cancelar fecha o modal sem allocate; resposta atrasada das opções não reabre', async () => {
    let resolve: (v: AllocationOptionsLoad) => void = () => undefined;
    loadOptions.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    mockUsePatientItinerary.mockReturnValue(hookState());
    render(<PatientItineraryTab patient={PATIENT} />);
    fireEvent.click(screen.getByTestId('itinerario-slot-asignar-slot-1'));
    expect(screen.getByTestId('itinerario-alocar-prestador')).toBeDisabled();
    fireEvent.click(screen.getByTestId('itinerario-alocar-cancelar'));
    resolve({ status: 'ok', options: [] });
    await waitFor(() => expect(screen.queryByTestId('itinerario-alocar-modal')).toBeNull());
    expect(allocate).not.toHaveBeenCalled();
  });

  it('opções não carregam → modal fecha e o erro genérico aparece SÓ na seção do serviço', async () => {
    loadOptions.mockResolvedValueOnce({ status: 'error' });
    mockUsePatientItinerary.mockReturnValue(hookState());
    render(<PatientItineraryTab patient={PATIENT} />);
    fireEvent.click(screen.getByTestId('itinerario-slot-asignar-slot-1'));
    const alert = await screen.findByTestId('itinerario-acao-erro');
    expect(alert).toHaveTextContent('No se pudo asignar el prestador.');
    expect(within(screen.getByTestId('itinerario-servico-svc-1')).getByTestId('itinerario-acao-erro')).toBe(alert);
    expect(screen.queryByTestId('itinerario-alocar-modal')).toBeNull();
  });

  it('actionError do hook vai só para a seção em que a ação foi feita', async () => {
    mockUsePatientItinerary.mockReturnValue(hookState({ actionError: { code: 'SLOT_INACTIVE' } }));
    const { rerender } = render(<PatientItineraryTab patient={PATIENT} />);
    expect(screen.queryByTestId('itinerario-acao-erro')).toBeNull();
    fireEvent.click(screen.getByTestId('itinerario-slot-asignar-slot-2'));
    await waitFor(() => expect(screen.getByTestId('itinerario-alocar-prestador')).toBeEnabled());
    rerender(<PatientItineraryTab patient={PATIENT} />);
    expect(within(screen.getByTestId('itinerario-servico-svc-2')).getByTestId('itinerario-acao-erro')).toHaveTextContent(
      'Esta franja ya no está activa.',
    );
    expect(within(screen.getByTestId('itinerario-servico-svc-1')).queryByTestId('itinerario-acao-erro')).toBeNull();
  });
});
