/**
 * PatientItineraryTab — spec 069: a aba é o ROTEADOR (lista B1 ↔ tela do serviço B2). Estados de carga
 * pelo hook (mockado); `?serviceId=` da URL abre o serviço (atalho da vacante/e-mail); um serviço só pula
 * a lista; `serviceId` de outro paciente cai na lista. As escritas de alocação ("Editar agendamiento",
 * "Quitar del itinerario") seguem pelo "Horario fijo" — comportamento igual ao da D445/Fase 4.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { MemoryRouter, useLocation } from 'react-router-dom';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import type { PatientContractedServiceDetail, PatientDetail } from '@domain/entities/PatientDetail';
import type { PatientItinerary } from '@domain/entities/PatientItinerary';
import type { AllocationOptionsLoad, UsePatientItineraryResult } from '@hooks/admin/usePatientItinerary';
import { PatientItineraryTab } from '../PatientItineraryTab';
import { patientDetailFixture } from './patientDetailFixture';
import { expectNoRawEnumLeaks } from '../../../../../../test/rawEnumLeakGuard';

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
const mockEndAllocation = vi.fn();
vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => ({
  AdminContractedServicesApiService: {
    getAllocationOptions: (...args: unknown[]) => mockGetAllocationOptions(...args),
    getItineraryEvents: (...args: unknown[]) => mockGetItineraryEvents(...args),
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
  horizonDays: 7,
  assembledAt: null,
  services: [
    {
      contractedServiceId: 'svc-1',
      scheduleHours: 20,
      reserve: null,
      cobertas: 0,
      providersNeeded: null,
      uncoveredShifts: 2,
      slots: [{ id: 'slot-1', weekday: 1, startTime: '08:00', endTime: '12:00', durationMinutes: 240, assignments: [] }],
    },
    {
      contractedServiceId: 'svc-2',
      scheduleHours: 10,
      reserve: null,
      cobertas: 0,
      providersNeeded: null,
      uncoveredShifts: 0,
      slots: [{ id: 'slot-2', weekday: 2, startTime: '09:00', endTime: '11:00', durationMinutes: 120, assignments: [] }],
    },
  ],
};

/** Um serviço só: a lista é pulada. */
const SINGLE: PatientItinerary = { ...ITINERARY, services: [ITINERARY.services[0]] };

let loadOptions: ReturnType<typeof vi.fn<[string], Promise<AllocationOptionsLoad>>>;
let allocate: ReturnType<typeof vi.fn<[string, string, string], Promise<void>>>;
let refresh: ReturnType<typeof vi.fn<[], void>>;

function hookState(over: Partial<UsePatientItineraryResult> = {}): UsePatientItineraryResult {
  return { itinerary: ITINERARY, status: 'ok', loadOptions, allocate, actionError: null, refreshError: false, refresh, ...over };
}

function UrlProbe(): JSX.Element {
  const { search } = useLocation();
  return <span data-testid="url-probe">{search}</span>;
}

function renderTab(search = '', patient: PatientDetail = PATIENT) {
  return render(
    <MemoryRouter initialEntries={[`/admin/patients/${patient.id}${search}`]}>
      <PatientItineraryTab patient={patient} />
      <UrlProbe />
    </MemoryRouter>,
  );
}

/** Abre o serviço pelo roteador e a aba "Horario fijo" (onde mora o editor de faixa). */
function abrirHorarioFijo(serviceId = 'svc-1') {
  const result = renderTab(`?tab=itinerary&serviceId=${serviceId}`);
  fireEvent.click(screen.getByTestId('itinerario-aba-fixed'));
  return result;
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
  mockGetItineraryEvents.mockReset().mockResolvedValue({ patientId: PATIENT.id, from: '2026-09-28', to: '2026-10-04', events: [] });
  mockEndAllocation.mockReset();
});

describe('PatientItineraryTab — a aba do itinerário (spec 069)', () => {
  it('loading → skeleton, sem lista nem serviço', () => {
    mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: null, status: 'loading' }));
    renderTab();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('itinerario-lista-servicos')).toBeNull();
    expect(mockUsePatientItinerary).toHaveBeenCalledWith(PATIENT.id);
  });

  it.each(['error', 'forbidden'] as const)('%s → itinerario-erro (alert)', (status) => {
    mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: null, status }));
    renderTab();
    expect(screen.getByTestId('itinerario-erro')).toHaveAttribute('role', 'alert');
  });

  it('Fase 3: "Itinerario listo" entra no TOPO, ACIMA da lista; montado troca o botão pelo texto', () => {
    mockUsePatientItinerary.mockReturnValue(hookState());
    const { unmount } = renderTab();
    const botao = screen.getByTestId('itinerario-montar');
    const lista = screen.getByTestId('itinerario-lista-servicos');
    expect(botao.compareDocumentPosition(lista) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('refreshError → itinerario-refresh-erro', () => {
    mockUsePatientItinerary.mockReturnValue(hookState({ refreshError: true }));
    renderTab();
    expect(screen.getByTestId('itinerario-refresh-erro')).toHaveAttribute('role', 'alert');
  });

  describe('B1 — a lista (US1)', () => {
    it('2 serviços: abre na LISTA, 1 cartão por serviço na ordem da API, aviso do horizonte só no que tem turnos sin cubrir', () => {
      mockUsePatientItinerary.mockReturnValue(hookState());
      const { container } = renderTab();
      const cards = screen.getAllByTestId(/^itinerario-cartao-svc-\d$/);
      expect(cards.map((c) => c.getAttribute('data-testid'))).toEqual(['itinerario-cartao-svc-1', 'itinerario-cartao-svc-2']);
      expect(screen.queryByTestId('itinerario-servico-tela-svc-1')).toBeNull();
      expect(screen.getByTestId('itinerario-cartao-sem-cobrir-svc-1')).toHaveTextContent('2 turnos sin cubrir en los próximos 7 días');
      expect(screen.queryByTestId('itinerario-cartao-sem-cobrir-svc-2')).toBeNull();
      expect(screen.getByTestId('itinerario-cartao-estado-svc-1')).toHaveTextContent('Faltan cubrir 20 h de 20');
      expect(cards[0]).toHaveTextContent('Rua Augusta, 975');
      expectNoRawEnumLeaks(container);
    });

    it('o horizonte do texto vem do GET (horizonDays), nunca 7 fixo', () => {
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: { ...ITINERARY, horizonDays: 5 } }));
      renderTab();
      expect(screen.getByTestId('itinerario-cartao-sem-cobrir-svc-1')).toHaveTextContent('en los próximos 5 días');
    });

    it('"Organizar agenda" abre o serviço pelo `?serviceId=` (preserva os outros parâmetros) e "Volver" limpa só ele', () => {
      mockUsePatientItinerary.mockReturnValue(hookState());
      renderTab('?tab=itinerary');
      fireEvent.click(screen.getByTestId('itinerario-cartao-abrir-svc-2'));
      expect(screen.getByTestId('url-probe')).toHaveTextContent('?tab=itinerary&serviceId=svc-2');
      expect(screen.getByTestId('itinerario-servico-tela-svc-2')).toBeInTheDocument();
      expect(screen.queryByTestId('itinerario-lista-servicos')).toBeNull();

      fireEvent.click(screen.getByTestId('itinerario-voltar-servicos'));
      expect(screen.getByTestId('url-probe')).toHaveTextContent(/^\?tab=itinerary$/);
      expect(screen.getByTestId('itinerario-lista-servicos')).toBeInTheDocument();
    });

    it('atalho da vacante/e-mail: `?tab=itinerary&serviceId=svc-2` abre DIRETO no B2 desse serviço (e "Volver" leva à lista)', () => {
      mockUsePatientItinerary.mockReturnValue(hookState());
      renderTab('?tab=itinerary&serviceId=svc-2');
      expect(screen.getByTestId('itinerario-servico-tela-svc-2')).toBeInTheDocument();
      expect(screen.getByTestId('itinerario-servico-nome')).toHaveTextContent('Acompañante Terapéutico');
      fireEvent.click(screen.getByTestId('itinerario-voltar-servicos'));
      expect(screen.getByTestId('itinerario-lista-servicos')).toBeInTheDocument();
    });

    it('`serviceId` de OUTRO paciente (ou de serviço inativo, que o GET não traz) → cai na lista, sem erro', () => {
      mockUsePatientItinerary.mockReturnValue(hookState());
      renderTab('?tab=itinerary&serviceId=svc-de-outro-paciente');
      expect(screen.getByTestId('itinerario-lista-servicos')).toBeInTheDocument();
      expect(screen.queryByTestId('itinerario-erro')).toBeNull();
    });

    it('UM serviço só: pula a lista, abre o B2 e não tem "Volver a los servicios"', () => {
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: SINGLE }));
      renderTab();
      expect(screen.queryByTestId('itinerario-lista-servicos')).toBeNull();
      expect(screen.getByTestId('itinerario-servico-tela-svc-1')).toBeInTheDocument();
      expect(screen.queryByTestId('itinerario-voltar-servicos')).toBeNull();
    });

    it('UM serviço e `serviceId` de outro: continua direto no único serviço', () => {
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: SINGLE }));
      renderTab('?serviceId=outro');
      expect(screen.getByTestId('itinerario-servico-tela-svc-1')).toBeInTheDocument();
    });

    it('ABAC sem célula de endereço (addresses: null) → a lista renderiza, com o aviso "sin vacante" no lugar do endereço', () => {
      mockUsePatientItinerary.mockReturnValue(hookState());
      renderTab('', { ...PATIENT, addresses: null } as unknown as PatientDetail);
      expect(screen.getByTestId('itinerario-lista-servicos')).toBeInTheDocument();
      expect(screen.getByTestId('itinerario-cartao-svc-1')).toHaveTextContent('Este servicio no tiene una vacante activa.');
    });

    it('serviço do itinerário que o paciente não lista (inconsistência): cartão com o id como rótulo, sem lançar', () => {
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: { ...ITINERARY, services: [{ ...ITINERARY.services[0], contractedServiceId: 'svc-x' }, ITINERARY.services[1]] } }));
      renderTab();
      expect(screen.getByTestId('itinerario-cartao-svc-x')).toHaveTextContent('svc-x');
    });

    it('serviço do itinerário sem registro no paciente, aberto direto: tela sem lançar', () => {
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: { ...SINGLE, services: [{ ...SINGLE.services[0], contractedServiceId: 'svc-x' }] } }));
      renderTab();
      expect(screen.getByTestId('itinerario-servico-nome')).toHaveTextContent('svc-x');
    });
  });

  describe('B2 — intenções do fluxo "Nueva sustitución" (a F6 monta o fluxo)', () => {
    it('"Nueva sustitución" registra a intenção `new`; fechar não há (o ponto de montagem só existe depois de pedir)', () => {
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: SINGLE }));
      renderTab();
      expect(screen.queryByTestId('itinerario-fluxo-ponto-de-montagem')).toBeNull();
      fireEvent.click(screen.getByTestId('itinerario-nova-substituicao'));
      expect(screen.getByTestId('itinerario-fluxo-ponto-de-montagem')).toHaveAttribute('data-intent', 'new');
    });

    it('"Cambiar" e "Asignar" de um turno da tabela registram `change` / `assign`', async () => {
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: SINGLE }));
      const base = { weekday: 1, serviceId: 'svc-1', slotId: 'slot-1', startTime: '08:00', endTime: '12:00', substituteWorkerId: null, substituteDisplayName: null, requestId: null };
      mockGetItineraryEvents.mockResolvedValue({
        patientId: PATIENT.id, from: '2026-09-28', to: '2026-10-04',
        events: [
          { ...base, date: '2026-09-28', assignmentId: 'a-1', titularWorkerId: 'w-1', titularDisplayName: 'Ana Fixture', status: 'covered', workerId: 'w-1', workerDisplayName: 'Ana Fixture', absenceId: null },
          { ...base, date: '2026-10-05', assignmentId: null, titularWorkerId: null, titularDisplayName: null, status: 'uncovered', workerId: null, workerDisplayName: null, absenceId: null },
        ],
      });
      renderTab();
      fireEvent.click(await screen.findByTestId('itinerario-proximo-cambiar-slot-1-2026-09-28'));
      expect(screen.getByTestId('itinerario-fluxo-ponto-de-montagem')).toHaveAttribute('data-intent', 'change');
      expect(mockGetItineraryEvents).toHaveBeenCalledWith(PATIENT.id, '2026-09-28', '2026-10-04', { serviceId: 'svc-1' });
    });

    it('"Asignar" de um turno sin cubrir registra `assign`', async () => {
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: SINGLE }));
      mockGetItineraryEvents.mockResolvedValue({
        patientId: PATIENT.id, from: '2026-09-28', to: '2026-10-04',
        events: [{
          date: '2026-09-30', weekday: 3, serviceId: 'svc-1', slotId: 'slot-1', assignmentId: null, startTime: '08:00', endTime: '12:00', titularWorkerId: null, titularDisplayName: null,
          status: 'uncovered', workerId: null, workerDisplayName: null, substituteWorkerId: null, substituteDisplayName: null, absenceId: null, requestId: null,
        }],
      });
      renderTab();
      fireEvent.click(await screen.findByTestId('itinerario-proximo-asignar-slot-1-2026-09-30'));
      expect(screen.getByTestId('itinerario-fluxo-ponto-de-montagem')).toHaveAttribute('data-intent', 'assign');
    });
  });

  describe('Horario fijo — "Editar agendamiento" (comportamento igual ao de antes)', () => {
    it('abrir uma faixa chama loadOptions 1× com o serviço; "Guardar" chama allocate(serviceId, slotId, workerId) e fecha', async () => {
      mockUsePatientItinerary.mockReturnValue(hookState());
      abrirHorarioFijo('svc-2');
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
      abrirHorarioFijo();
      fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('itinerario-editar-modal')).toBeNull());
      expect(allocate).not.toHaveBeenCalled();
    });

    it('fechar ANTES das respostas chegarem: opções e vaga atrasadas são descartadas (nada pinta no painel seguinte)', async () => {
      let resolveOptions: (v: AllocationOptionsLoad) => void = () => undefined;
      let resolveVacancy: (v: { vacancyId: string | null }) => void = () => undefined;
      loadOptions.mockImplementationOnce(() => new Promise((r) => { resolveOptions = r; }));
      mockGetAllocationOptions.mockImplementationOnce(() => new Promise((r) => { resolveVacancy = r; }));
      mockUsePatientItinerary.mockReturnValue(hookState());
      abrirHorarioFijo();
      fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByTestId('itinerario-editar-modal')).toBeNull());
      resolveOptions({ status: 'error' });
      resolveVacancy({ vacancyId: 'vac-velha' });
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.queryByTestId('itinerario-acao-erro')).toBeNull();
    });

    it('a vaga do serviço não carrega (rejeita): o link "ir a la vacante" só some, a alocação segue funcionando', async () => {
      mockGetAllocationOptions.mockRejectedValueOnce(new Error('rede'));
      mockUsePatientItinerary.mockReturnValue(hookState());
      abrirHorarioFijo();
      fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
      await waitFor(() => expect(screen.getByTestId('itinerario-editar-prestador')).toBeEnabled());
      expect(screen.queryByTestId('itinerario-editar-link-vaga')).toBeNull();
    });

    it('opções não carregam → o erro genérico aparece SÓ na seção do serviço', async () => {
      loadOptions.mockResolvedValueOnce({ status: 'error' });
      mockUsePatientItinerary.mockReturnValue(hookState());
      abrirHorarioFijo();
      fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
      const alert = await screen.findByTestId('itinerario-acao-erro');
      expect(alert).toHaveTextContent('No se pudo asignar el prestador.');
      expect(within(screen.getByTestId('itinerario-servico-svc-1')).getByTestId('itinerario-acao-erro')).toBe(alert);
    });

    it('actionError do hook vai só para o serviço em que a ação foi feita', async () => {
      mockUsePatientItinerary.mockReturnValue(hookState({ actionError: { code: 'SLOT_INACTIVE' } }));
      abrirHorarioFijo('svc-2');
      expect(screen.queryByTestId('itinerario-acao-erro')).toBeNull();
      fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-2'));
      await waitFor(() => expect(screen.getByTestId('itinerario-editar-prestador')).toBeEnabled());
      expect(within(screen.getByTestId('itinerario-servico-svc-2')).getByTestId('itinerario-acao-erro')).toHaveTextContent('Esta franja ya no está activa.');
    });

    it('serviço do itinerário que o paciente não lista (inconsistência): o editor abre, com o endereço em branco, sem lançar', async () => {
      const orfao: PatientItinerary = { ...SINGLE, services: [{ ...SINGLE.services[0], contractedServiceId: 'svc-x' }] };
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: orfao }));
      renderTab();
      fireEvent.click(screen.getByTestId('itinerario-aba-fixed'));
      fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
      expect(await screen.findByTestId('itinerario-editar-modal')).toBeInTheDocument();
    });

    it('FR-40: nenhum texto do Ana Care no modal de edição', async () => {
      mockUsePatientItinerary.mockReturnValue(hookState());
      abrirHorarioFijo();
      fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
      await screen.findByTestId('itinerario-editar-modal');
      expect(screen.queryByText(/Ana Care/i)).toBeNull();
    });
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
      abrirHorarioFijo();
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
      abrirHorarioFijo();
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
      abrirHorarioFijo();
      await openQuitarPanel();
      fireEvent.click(screen.getByTestId('itinerario-quitar-destino-RESERVE'));
      fireEvent.click(screen.getByTestId('itinerario-quitar-confirmar'));
      expect(await screen.findByTestId('itinerario-quitar-erro')).toHaveTextContent('No se pudo quitar al prestador del itinerario');
    });

    const SCHEDULED_409 = () =>
      Object.assign(new Error('x'), {
        code: 'WORKER_HAS_SCHEDULED_ATTENDANCES',
        status: 409,
        details: { substitutionDates: ['2026-10-26', '2026-11-02'], futureEntryFrom: null },
      });

    async function confirmarAteOAviso() {
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: WITH_TITULAR }));
      abrirHorarioFijo();
      await openQuitarPanel();
      fireEvent.click(screen.getByTestId('itinerario-quitar-destino-LEAVE_SERVICE'));
      fireEvent.click(screen.getByTestId('itinerario-quitar-confirmar'));
      return screen.findByTestId('aviso-agendados');
    }

    it('409 WORKER_HAS_SCHEDULED_ATTENDANCES: mostra aviso-agendados com as datas; nenhum erro genérico; o painel continua aberto', async () => {
      mockEndAllocation.mockRejectedValueOnce(SCHEDULED_409());
      const aviso = await confirmarAteOAviso();
      expect(screen.getByTestId('aviso-agendados-datas')).toHaveTextContent('26/10, 02/11');
      expect(aviso).toBeInTheDocument();
      expect(screen.queryByTestId('itinerario-quitar-erro')).toBeNull();
      expect(screen.getByTestId('itinerario-quitar-painel')).toBeInTheDocument();
    });

    it('confirmar o aviso reenvia endAllocation com cancelScheduled: true e fecha o modal', async () => {
      mockEndAllocation.mockRejectedValueOnce(SCHEDULED_409());
      mockEndAllocation.mockResolvedValueOnce({ allocationId: 'alloc-1', status: 'ENDED', validTo: '2026-09-28', destination: 'LEAVE_SERVICE' });
      await confirmarAteOAviso();
      fireEvent.click(screen.getByTestId('aviso-agendados-confirmar'));
      await waitFor(() => expect(mockEndAllocation).toHaveBeenCalledTimes(2));
      expect(mockEndAllocation).toHaveBeenNthCalledWith(2, PATIENT.id, 'svc-1', 'alloc-1', {
        reasonCategory: 'NOVO_DO_ADMIN',
        destination: 'LEAVE_SERVICE',
        cancelScheduled: true,
      });
      await waitFor(() => expect(screen.queryByTestId('itinerario-editar-modal')).toBeNull());
    });

    it('409 WORKER_HAS_SCHEDULED_ATTENDANCES SEM `details` (ou sem `futureEntryFrom`): o aviso abre mesmo assim, com listas vazias', async () => {
      mockEndAllocation.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'WORKER_HAS_SCHEDULED_ATTENDANCES', status: 409 }));
      await confirmarAteOAviso();
      expect(screen.getByTestId('aviso-agendados')).toBeInTheDocument();
      expect(screen.queryByTestId('itinerario-quitar-erro')).toBeNull();
    });

    it('409 WORKER_HAS_SCHEDULED_ATTENDANCES com `details` sem `futureEntryFrom`: usa só as datas', async () => {
      mockEndAllocation.mockRejectedValueOnce(
        Object.assign(new Error('x'), { code: 'WORKER_HAS_SCHEDULED_ATTENDANCES', status: 409, details: { substitutionDates: ['2026-10-26'] } }),
      );
      await confirmarAteOAviso();
      expect(screen.getByTestId('aviso-agendados-datas')).toHaveTextContent('26/10');
    });

    it('Volver do aviso: nenhuma 2ª chamada a endAllocation', async () => {
      mockEndAllocation.mockRejectedValueOnce(SCHEDULED_409());
      await confirmarAteOAviso();
      fireEvent.click(screen.getByTestId('aviso-agendados-cancelar'));
      await waitFor(() => expect(screen.queryByTestId('aviso-agendados')).toBeNull());
      expect(mockEndAllocation).toHaveBeenCalledTimes(1);
    });

    it('faixa sem prestador vigente: nenhuma ação de quitar', async () => {
      mockUsePatientItinerary.mockReturnValue(hookState());
      abrirHorarioFijo();
      fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
      await screen.findByTestId('itinerario-editar-modal');
      expect(screen.queryByTestId('itinerario-quitar-w-titular')).toBeNull();
    });

    const WITH_TWO: PatientItinerary = {
      ...WITH_TITULAR,
      services: [
        {
          ...WITH_TITULAR.services[0],
          providersNeeded: 2,
          slots: [
            {
              ...WITH_TITULAR.services[0].slots[0],
              assignments: [
                { workerId: 'w-titular', applicationId: 'app-1', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE', allocationId: 'alloc-1', displayName: 'Ana Fixture' },
                { workerId: 'w-segundo', applicationId: 'app-2', validFrom: '2026-09-01', validTo: null, status: 'ACTIVE', allocationId: 'alloc-2', displayName: 'Bia Fixture' },
              ],
            },
          ],
        },
        WITH_TITULAR.services[1],
      ],
    };

    it('faixa com 2 vigentes e providersNeeded 2: o modal lista os 2 com Quitar e mostra faixa cheia', async () => {
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: WITH_TWO }));
      abrirHorarioFijo();
      fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
      expect(await screen.findByTestId('itinerario-quitar-w-titular')).toBeInTheDocument();
      expect(screen.getByTestId('itinerario-quitar-w-segundo')).toBeInTheDocument();
      expect(screen.getByTestId('itinerario-faixa-cheia')).toHaveTextContent('Franja completa: ya hay 2 asignados');
    });

    it('quitar o 2º vigente chama endAllocation com a alocação DELE', async () => {
      mockEndAllocation.mockResolvedValue({ allocationId: 'alloc-2', status: 'ENDED', validTo: '2026-09-28', destination: 'RESERVE' });
      mockUsePatientItinerary.mockReturnValue(hookState({ itinerary: WITH_TWO }));
      abrirHorarioFijo();
      fireEvent.click(screen.getByTestId('itinerario-slot-editar-slot-1'));
      fireEvent.click(await screen.findByTestId('itinerario-quitar-w-segundo'));
      fireEvent.change(screen.getByTestId('itinerario-quitar-motivo'), { target: { value: 'NOVO_DO_ADMIN' } });
      fireEvent.click(screen.getByTestId('itinerario-quitar-destino-RESERVE'));
      fireEvent.click(screen.getByTestId('itinerario-quitar-confirmar'));
      await waitFor(() => expect(mockEndAllocation).toHaveBeenCalledTimes(1));
      expect(mockEndAllocation).toHaveBeenCalledWith(PATIENT.id, 'svc-1', 'alloc-2', { reasonCategory: 'NOVO_DO_ADMIN', destination: 'RESERVE' });
    });
  });
});
