/**
 * PatientItineraryTab — D445 (layout de 2 colunas do Figma, nó 11340:76163). A aba só orquestra:
 * estados de carga pelo hook (mockado), uma `ItinerarySection` por serviço na coluna direita, o
 * painel "Próximos eventos/Substitución" na esquerda (`getItineraryEvents` mockado — suíte própria
 * do hook não existe ainda aqui, é cobertura de integração deste teste), abrir uma faixa chama
 * `loadOptions` 1× e "Editar agendamiento" confirma com `allocate(serviceId, slotId, workerId)`.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientContractedServiceDetail, PatientDetail } from '@domain/entities/PatientDetail';
import type { PatientItinerary } from '@domain/entities/PatientItinerary';
import type { AllocationOptionsLoad, UsePatientItineraryResult } from '@hooks/admin/usePatientItinerary';
import { PatientItineraryTab } from '../PatientItineraryTab';
import { patientDetailFixture } from './patientDetailFixture';
import { nextDatesOfWeekday } from '../substitutionDates';

// Catálogo de motivos de saída (Fase 2): o diálogo de motivo lê `useServiceExitReasonOptions`; aqui um catálogo fixo.
vi.mock('@hooks/admin/useServiceExitReasonOptions', () => ({
  useServiceExitReasonOptions: () => ({
    options: [
      { code: 'OTHER', label: 'Otro' },
      { code: 'NOVO_DO_ADMIN', label: 'Cambio de disponibilidad' },
    ],
    status: 'ok',
  }),
}));


const mockUsePatientItinerary = vi.fn<[string], UsePatientItineraryResult>();
vi.mock('@hooks/admin/usePatientItinerary', () => ({
  usePatientItinerary: (patientId: string) => mockUsePatientItinerary(patientId),
}));

const mockGetAllocationOptions = vi.fn();
const mockGetItineraryEvents = vi.fn();
const mockRegisterAbsence = vi.fn();
const mockReplaceAllocation = vi.fn();
const mockSetAbsenceSubstitute = vi.fn();
const mockCancelAbsence = vi.fn();
const mockEndAllocation = vi.fn();
vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: {
    getAllocationOptions: (...args: unknown[]) => mockGetAllocationOptions(...args),
    getItineraryEvents: (...args: unknown[]) => mockGetItineraryEvents(...args),
    registerAbsence: (...args: unknown[]) => mockRegisterAbsence(...args),
    replaceAllocation: (...args: unknown[]) => mockReplaceAllocation(...args),
    setAbsenceSubstitute: (...args: unknown[]) => mockSetAbsenceSubstitute(...args),
    cancelAbsence: (...args: unknown[]) => mockCancelAbsence(...args),
    endAllocation: (...args: unknown[]) => mockEndAllocation(...args),
  },
  ContractedServiceApiError: class ContractedServiceApiError extends Error {},
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
  addresses: [
    { id: 'addr-1', addressType: null, addressTypeOther: null, addressFormatted: 'Rua Augusta, 975', addressRaw: null } as PatientDetail['addresses'][number],
  ],
  contractedServices: [
    { id: 'svc-1', serviceCode: 'AT', addressId: 'addr-1' },
    { id: 'svc-2', serviceCode: 'AT', addressId: 'addr-1' },
  ] as PatientContractedServiceDetail[],
};

const ITINERARY: PatientItinerary = {
  patientId: PATIENT.id,
  asOf: '2026-09-28',
  alerts: [],
  assembledAt: null,
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
let refresh: ReturnType<typeof vi.fn<[], void>>;

function hookState(over: Partial<UsePatientItineraryResult> = {}): UsePatientItineraryResult {
  return { itinerary: ITINERARY, status: 'ok', loadOptions, allocate, actionError: null, refreshError: false, refresh, ...over };
}

function renderTab() {
  return render(
    <MemoryRouter>
      <PatientItineraryTab patient={PATIENT} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  loadOptions = vi.fn<[string], Promise<AllocationOptionsLoad>>().mockResolvedValue({
    status: 'ok',
    options: [{ workerId: 'w-opt-1', displayName: 'Dana Fixture', vacancyId: 'vac-1' }],
  });
  allocate = vi.fn<[string, string, string], Promise<void>>().mockResolvedValue(undefined);
  refresh = vi.fn();
  mockUsePatientItinerary.mockReset();
  mockGetAllocationOptions.mockReset().mockResolvedValue({ serviceId: 'svc-1', vacancyId: 'vac-1', options: [] });
  mockGetItineraryEvents.mockReset().mockResolvedValue({ patientId: PATIENT.id, from: '2026-09-28', to: '2026-10-11', events: [] });
  mockRegisterAbsence.mockReset().mockResolvedValue({ absenceId: 'ab-1', allocationId: 'alloc-1', date: '2026-09-29', substituteWorkerId: null, status: 'OPEN' });
  mockReplaceAllocation.mockReset();
  mockSetAbsenceSubstitute.mockReset();
  mockCancelAbsence.mockReset();
  mockEndAllocation.mockReset();
});

describe('PatientItineraryTab — a aba do itinerário (D445)', () => {
  it('loading → skeleton, sem seção', () => {
    mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: null, status: 'loading' }));
    renderTab();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('itinerario-servico-svc-1')).toBeNull();
    expect(mockUsePatientItinerary).toHaveBeenCalledWith(PATIENT.id);
  });

  it.each(['error', 'forbidden'] as const)('%s → itinerario-erro (alert)', (status) => {
    mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: null, status }));
    renderTab();
    expect(screen.getByTestId('itinerario-erro')).toHaveAttribute('role', 'alert');
  });

  it('Fase 3: "Itinerario listo" entra no TOPO, ACIMA de itinerario-colunas; montado troca o botão pelo texto', () => {
    mockUsePatientItinerary.mockReturnValue(hookState());
    const { unmount } = renderTab();
    const botao = screen.getByTestId('itinerario-montar');
    const colunas = screen.getByTestId('itinerario-colunas');
    expect(botao.compareDocumentPosition(colunas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    unmount();

    mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: { ...ITINERARY, assembledAt: '2026-09-30T18:00:00.000Z' } }));
    renderTab();
    expect(screen.queryByTestId('itinerario-montar')).toBeNull();
    expect(screen.getByTestId('itinerario-montado')).toHaveTextContent('Itinerario listo desde 30/09');
  });

  it('sem serviços → itinerario-sem-servicos', () => {
    mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: { ...ITINERARY, services: [] } }));
    renderTab();
    expect(screen.getByTestId('itinerario-sem-servicos')).toHaveTextContent('Este paciente no tiene servicios contratados activos.');
  });

  it('2 serviços → 2 seções na coluna direita, na ordem da API; painel de eventos na esquerda', async () => {
    mockUsePatientItinerary.mockReturnValue(hookState());
    const { container } = renderTab();
    const ids = Array.from(container.querySelectorAll('section[data-testid^="itinerario-servico-"]')).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['itinerario-servico-svc-1', 'itinerario-servico-svc-2']);
    expect(screen.getByTestId('itinerario-eventos-painel')).toBeInTheDocument();
    await waitFor(() => expect(mockGetItineraryEvents).toHaveBeenCalled());
  });

  it('ABAC sem célula de endereço (addresses: null) → a aba renderiza, sem lançar', async () => {
    mockUsePatientItinerary.mockReturnValue(hookState());
    const semEnderecos = { ...PATIENT, addresses: null } as unknown as PatientDetail;
    render(
      <MemoryRouter>
        <PatientItineraryTab patient={semEnderecos} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('itinerario-aba')).toBeInTheDocument();
    expect(screen.getByTestId('itinerario-servico-svc-1')).toBeInTheDocument();
    await waitFor(() => expect(mockGetItineraryEvents).toHaveBeenCalled());
  });

  it('refreshError → itinerario-refresh-erro', () => {
    mockUsePatientItinerary.mockReturnValue(hookState({ refreshError: true }));
    renderTab();
    expect(screen.getByTestId('itinerario-refresh-erro')).toHaveAttribute('role', 'alert');
  });

  it('abrir uma faixa chama loadOptions 1× com o serviço; "Guardar" chama allocate(serviceId, slotId, workerId) e fecha', async () => {
    mockUsePatientItinerary.mockReturnValue(hookState());
    renderTab();
    fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-2'));
    expect(loadOptions).toHaveBeenCalledTimes(1);
    expect(loadOptions).toHaveBeenCalledWith('svc-2');
    const modal = screen.getByTestId('itinerario-editar-modal');
    await waitFor(() => expect(within(modal).getByTestId('itinerario-editar-prestador')).toBeEnabled());

    fireEvent.click(within(modal).getByTestId('itinerario-editar-prestador'));
    fireEvent.click(within(screen.getByRole('listbox')).getByText('Dana Fixture'));
    fireEvent.click(screen.getByTestId('itinerario-editar-guardar'));
    expect(allocate).toHaveBeenCalledTimes(1);
    expect(allocate).toHaveBeenCalledWith('svc-2', 'slot-2', 'w-opt-1');
    expect(screen.queryByTestId('itinerario-editar-modal')).toBeNull();
  });

  it('Esc fecha o painel sem allocate', async () => {
    mockUsePatientItinerary.mockReturnValue(hookState());
    renderTab();
    fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('itinerario-editar-modal')).toBeNull());
    expect(allocate).not.toHaveBeenCalled();
  });

  it('opções não carregam → o erro genérico aparece SÓ na seção do serviço', async () => {
    loadOptions.mockResolvedValueOnce({ status: 'error' });
    mockUsePatientItinerary.mockReturnValue(hookState());
    renderTab();
    fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
    const alert = await screen.findByTestId('itinerario-acao-erro');
    expect(alert).toHaveTextContent('No se pudo asignar el prestador.');
    expect(within(screen.getByTestId('itinerario-servico-svc-1')).getByTestId('itinerario-acao-erro')).toBe(alert);
  });

  it('actionError do hook vai só para a seção em que a ação foi feita', async () => {
    mockUsePatientItinerary.mockReturnValue(hookState({ actionError: { code: 'SLOT_INACTIVE' } }));
    const { rerender } = renderTab();
    expect(screen.queryByTestId('itinerario-acao-erro')).toBeNull();
    fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-2'));
    await waitFor(() => expect(screen.getByTestId('itinerario-editar-prestador')).toBeEnabled());
    rerender(
      <MemoryRouter>
        <PatientItineraryTab patient={PATIENT} />
      </MemoryRouter>,
    );
    expect(within(screen.getByTestId('itinerario-servico-svc-2')).getByTestId('itinerario-acao-erro')).toHaveTextContent(
      'Esta franja ya no está activa.',
    );
    expect(within(screen.getByTestId('itinerario-servico-svc-1')).queryByTestId('itinerario-acao-erro')).toBeNull();
  });

  it('"Nuevo" abre o modal de nova substituição; confirmar Complementar chama registerAbsence e fecha (D445.4)', async () => {
    const withAssignment: PatientItinerary = {
      ...ITINERARY,
      services: [
        {
          ...ITINERARY.services[0],
          slots: [
            {
              ...ITINERARY.services[0].slots[0],
              assignments: [
                {
                  workerId: 'w-titular',
                  applicationId: 'app-1',
                  validFrom: '2026-09-01',
                  validTo: null,
                  status: 'ACTIVE',
                  allocationId: 'alloc-1',
                  displayName: 'Ana Fixture',
                },
              ],
            },
          ],
        },
        ITINERARY.services[1],
      ],
    };
    mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: withAssignment }));
    renderTab();
    fireEvent.click(screen.getByTestId('itinerario-novo-btn'));
    const modal = await screen.findByTestId('itinerario-novo-servico');
    fireEvent.change(modal, { target: { value: 'svc-1' } });
    await waitFor(() => expect(screen.getByTestId('substitution-slot')).toBeInTheDocument());

    const firstDate = nextDatesOfWeekday(ITINERARY.asOf, 1, 8)[0];
    fireEvent.change(screen.getByTestId('substitution-date'), { target: { value: firstDate } });
    fireEvent.change(screen.getByTestId('substitution-reason'), { target: { value: 'NOVO_DO_ADMIN' } });
    fireEvent.click(screen.getByTestId('substitution-confirm'));

    await waitFor(() => expect(mockRegisterAbsence).toHaveBeenCalledTimes(1));
    expect(mockRegisterAbsence.mock.calls[0][1]).toBe('svc-1');
    expect(mockRegisterAbsence.mock.calls[0][3]).toMatchObject({ reasonCategory: 'NOVO_DO_ADMIN' });
    expect(refresh).toHaveBeenCalled();
  });

  describe('Fase 4 — "Quitar del itinerario"', () => {
    const WITH_TITULAR: PatientItinerary = {
      ...ITINERARY,
      services: [
        {
          ...ITINERARY.services[0],
          slots: [
            {
              ...ITINERARY.services[0].slots[0],
              assignments: [
                { workerId: 'w-titular', applicationId: 'app-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE', allocationId: 'alloc-1', displayName: 'Ana Fixture' },
              ],
            },
          ],
        },
        ITINERARY.services[1],
      ],
    };

    async function openQuitarPanel() {
      fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
      fireEvent.click(await screen.findByTestId('itinerario-quitar-w-titular'));
      fireEvent.change(screen.getByTestId('itinerario-quitar-motivo'), { target: { value: 'NOVO_DO_ADMIN' } });
    }

    it('confirmar chama endAllocation(paciente, serviço, alocação, { motivo, destino }), faz refresh + recarrega os eventos e fecha o modal', async () => {
      mockEndAllocation.mockResolvedValue({ allocationId: 'alloc-1', status: 'ENDED', validTo: '2026-09-28', destination: 'RESERVE' });
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: WITH_TITULAR }));
      renderTab();
      await waitFor(() => expect(mockGetItineraryEvents).toHaveBeenCalledTimes(1));
      await openQuitarPanel();
      fireEvent.click(screen.getByTestId('itinerario-quitar-destino-RESERVE'));
      fireEvent.click(screen.getByTestId('itinerario-quitar-confirmar'));

      await waitFor(() => expect(mockEndAllocation).toHaveBeenCalledTimes(1));
      expect(mockEndAllocation).toHaveBeenCalledWith(PATIENT.id, 'svc-1', 'alloc-1', { reasonCategory: 'NOVO_DO_ADMIN', destination: 'RESERVE' });
      expect(refresh).toHaveBeenCalled();
      await waitFor(() => expect(mockGetItineraryEvents.mock.calls.length).toBeGreaterThan(1));
      await waitFor(() => expect(screen.queryByTestId('itinerario-editar-modal')).toBeNull());
      expect(screen.queryByTestId('itinerario-quitar-painel')).toBeNull();
    });

    it('422 por CÓDIGO: agendamento → mensagem de produto no painel (sem id cru) e o painel continua aberto', async () => {
      mockEndAllocation.mockRejectedValue(Object.assign(new Error('x'), { code: 'SERVICE_TEAM_WORKER_ALLOCATED', status: 422 }));
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: WITH_TITULAR }));
      renderTab();
      await openQuitarPanel();
      fireEvent.click(screen.getByTestId('itinerario-quitar-destino-LEAVE_SERVICE'));
      fireEvent.click(screen.getByTestId('itinerario-quitar-confirmar'));

      const erro = await screen.findByTestId('itinerario-quitar-erro');
      expect(erro).toHaveTextContent('tiene atenciones agendadas; cancele antes');
      expect(erro.textContent).not.toMatch(/w-titular|alloc-1|svc-1|SERVICE_TEAM_WORKER_ALLOCATED/);
      expect(screen.getByTestId('itinerario-quitar-painel')).toBeInTheDocument();
    });

    it('erro sem código conhecido cai na mensagem genérica do painel', async () => {
      mockEndAllocation.mockRejectedValue(new Error('rede'));
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: WITH_TITULAR }));
      renderTab();
      await openQuitarPanel();
      fireEvent.click(screen.getByTestId('itinerario-quitar-destino-RESERVE'));
      fireEvent.click(screen.getByTestId('itinerario-quitar-confirmar'));
      expect(await screen.findByTestId('itinerario-quitar-erro')).toHaveTextContent('No se pudo quitar al prestador del itinerario');
    });

    it('faixa sem prestador vigente: nenhuma ação de quitar', async () => {
      mockUsePatientItinerary.mockReturnValue(hookState());
      renderTab();
      fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
      await screen.findByTestId('itinerario-editar-modal');
      expect(screen.queryByTestId('itinerario-quitar-w-titular')).toBeNull();
    });
  });
});
