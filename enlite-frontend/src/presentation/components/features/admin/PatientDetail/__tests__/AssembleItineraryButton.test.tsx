/**
 * AssembleItineraryButton — Fase 3 (C8, "Itinerario listo"). ActionButton REAL (gate de célula) e i18n
 * real (es); só o service HTTP é dublê. Cobre: sem célula com enforcement `on` não renderiza; montado
 * mostra o texto com a data (fuso de Buenos Aires, não o do processo); 422 mostra a mensagem do CÓDIGO
 * e nunca o id de serviço cru; sucesso chama `onAssembled`; `assembledAt` nulo/ausente não quebra.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import ptBRJson from '@infrastructure/i18n/locales/pt-BR.json';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { AuthzContract } from '@domain/entities/Authz';
import { AssembleItineraryButton } from '../AssembleItineraryButton';
import { ContractedServiceApiError } from '@infrastructure/http/AdminContractedServicesApiService';

const mockAssemble = vi.fn();
vi.mock('@infrastructure/http/AdminContractedServicesApiService', () => {
  class ContractedServiceApiError extends Error {
    readonly status: number;
    readonly code?: string;
    readonly details?: Record<string, unknown>;
    constructor(message: string, status: number, body?: { code?: string; details?: Record<string, unknown> }) {
      super(message);
      this.status = status;
      this.code = body?.code;
      this.details = body?.details;
    }
  }
  return {
    AdminContractedServicesApiService: { assembleItinerary: (...args: unknown[]) => mockAssemble(...args) },
    ContractedServiceApiError,
  };
});

const PATIENT_ID = '11111111-1111-4111-8111-111111111111';
const SERVICE_ID_CRU = '22222222-2222-4222-8222-222222222222';

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']): void {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: { uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement } as AuthzContract,
  });
}

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
  vi.clearAllMocks();
  useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
});

describe('AssembleItineraryButton', () => {
  it('(i) 🔴 sem a célula patient_itinerary:update, com enforcement on, o botão NÃO renderiza (nem o texto de montado)', () => {
    comEnforcement(['patient_itinerary:read'], 'on');
    render(<AssembleItineraryButton patientId={PATIENT_ID} assembledAt={null} onAssembled={vi.fn()} />);
    expect(screen.queryByTestId('itinerario-montar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('itinerario-montado')).not.toBeInTheDocument();
  });

  it('(i-controle) com a célula update e enforcement on, o botão existe com o rótulo "Itinerario listo"', () => {
    comEnforcement(['patient_itinerary:update'], 'on');
    render(<AssembleItineraryButton patientId={PATIENT_ID} assembledAt={null} onAssembled={vi.fn()} />);
    expect(screen.getByTestId('itinerario-montar')).toHaveTextContent('Itinerario listo');
  });

  it('(ii) montado → texto "Itinerario listo desde dd/mm" no lugar do botão; a data é a de Buenos Aires (02:30Z de 01/10 ainda é 30/09)', () => {
    comEnforcement(['patient_itinerary:update'], 'on');
    render(<AssembleItineraryButton patientId={PATIENT_ID} assembledAt="2026-10-01T02:30:00.000Z" onAssembled={vi.fn()} />);
    expect(screen.getByTestId('itinerario-montado')).toHaveTextContent('Itinerario listo desde 30/09');
    expect(screen.queryByTestId('itinerario-montar')).not.toBeInTheDocument();
  });

  it('(iii) 422 SERVICE_WITHOUT_SLOT → mensagem do código; o id de serviço que a API manda NÃO aparece na tela', async () => {
    comEnforcement([], 'off');
    mockAssemble.mockRejectedValue(
      new ContractedServiceApiError('SERVICE_WITHOUT_SLOT', 422, { code: 'SERVICE_WITHOUT_SLOT', details: { services: [{ serviceId: SERVICE_ID_CRU }] } }),
    );
    const onAssembled = vi.fn();
    const { container } = render(<AssembleItineraryButton patientId={PATIENT_ID} assembledAt={null} onAssembled={onAssembled} />);

    fireEvent.click(screen.getByTestId('itinerario-montar'));

    const erro = await screen.findByTestId('itinerario-montar-erro');
    expect(erro).toHaveTextContent(esJson.admin.patients.detail.itinerary.assemble.errors.SERVICE_WITHOUT_SLOT);
    expect(container.textContent).not.toContain(SERVICE_ID_CRU);
    expect(mockAssemble).toHaveBeenCalledWith(PATIENT_ID);
    expect(onAssembled).not.toHaveBeenCalled();
  });

  it('422 NO_SERVICE_WITH_VACANCY → mensagem do código; código desconhecido e erro sem código → genérica', async () => {
    comEnforcement([], 'off');
    mockAssemble.mockRejectedValueOnce(new ContractedServiceApiError('x', 422, { code: 'NO_SERVICE_WITH_VACANCY' }));
    render(<AssembleItineraryButton patientId={PATIENT_ID} assembledAt={null} onAssembled={vi.fn()} />);

    fireEvent.click(screen.getByTestId('itinerario-montar'));
    expect(await screen.findByTestId('itinerario-montar-erro')).toHaveTextContent(
      esJson.admin.patients.detail.itinerary.assemble.errors.NO_SERVICE_WITH_VACANCY,
    );

    mockAssemble.mockRejectedValueOnce(new ContractedServiceApiError('x', 422, { code: 'ALGO_NOVO' }));
    fireEvent.click(screen.getByTestId('itinerario-montar'));
    await waitFor(() =>
      expect(screen.getByTestId('itinerario-montar-erro')).toHaveTextContent(esJson.admin.patients.detail.itinerary.assemble.errors.generic),
    );

    mockAssemble.mockRejectedValueOnce(new Error('rede caiu'));
    fireEvent.click(screen.getByTestId('itinerario-montar'));
    await waitFor(() =>
      expect(screen.getByTestId('itinerario-montar-erro')).toHaveTextContent(esJson.admin.patients.detail.itinerary.assemble.errors.generic),
    );
  });

  it('sucesso → chama onAssembled 1× e não mostra erro', async () => {
    comEnforcement([], 'off');
    mockAssemble.mockResolvedValue({ patientId: PATIENT_ID, assembledAt: '2026-09-30T18:00:00.000Z' });
    const onAssembled = vi.fn();
    render(<AssembleItineraryButton patientId={PATIENT_ID} assembledAt={null} onAssembled={onAssembled} />);

    fireEvent.click(screen.getByTestId('itinerario-montar'));

    await waitFor(() => expect(onAssembled).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('itinerario-montar-erro')).not.toBeInTheDocument();
  });

  it('guarda de null: assembledAt ausente (API velha) e data ilegível não quebram', () => {
    comEnforcement([], 'off');
    const { rerender } = render(<AssembleItineraryButton patientId={PATIENT_ID} assembledAt={undefined} onAssembled={vi.fn()} />);
    expect(screen.getByTestId('itinerario-montar')).toBeInTheDocument();

    rerender(<AssembleItineraryButton patientId={PATIENT_ID} assembledAt="lixo" onAssembled={vi.fn()} />);
    expect(screen.getByTestId('itinerario-montado')).toHaveTextContent('Itinerario listo desde —');

    rerender(<AssembleItineraryButton patientId="" assembledAt={null} onAssembled={vi.fn()} />);
    expect(screen.queryByTestId('itinerario-montar')).not.toBeInTheDocument();
  });
});
