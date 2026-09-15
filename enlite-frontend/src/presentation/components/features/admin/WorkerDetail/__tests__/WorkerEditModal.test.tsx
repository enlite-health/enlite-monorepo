import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorkerEditModal } from '../WorkerEditModal';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { useAdminAuthStore } from '@presentation/stores/adminAuthStore';
import type { WorkerDetail } from '@domain/entities/Worker';
import type { AuthzContract } from '@domain/entities/Authz';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, opts?: any) => opts?.defaultValue ?? k }) }));

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    updateWorkerProfile: vi.fn(),
    updateWorkerServiceArea: vi.fn(),
  },
}));

// GooglePlacesAutocomplete depends on the Maps JS SDK — swapped for a
// controllable stub that exposes onChange/onPlaceSelected via test ids, same
// pattern as ServiceAddressTab.test.tsx (mock as inert) but interactive here
// because WorkerEditModal's address branch needs to be exercised too.
vi.mock('@presentation/components/molecules/GooglePlacesAutocomplete', () => ({
  GooglePlacesAutocomplete: ({ value, onChange, onPlaceSelected, onValidationChange, error }: any) => (
    <div>
      <input
        data-testid="gpa-input"
        value={value}
        onChange={(e) => { onValidationChange(false); onChange(e.target.value); }}
      />
      <button
        type="button"
        data-testid="gpa-select-place"
        onClick={() => {
          onValidationChange(true);
          onPlaceSelected({ geometry: { location: { lat: () => -34.6, lng: () => -58.4 } }, address_components: [] });
        }}
      >
        select place
      </button>
      {/* Resposta da API do Google sem geometry — branch defensivo de `handlePlaceSelected`. */}
      <button
        type="button"
        data-testid="gpa-select-place-no-geometry"
        onClick={() => onPlaceSelected({})}
      >
        select place (sem geometry)
      </button>
      {error && <span data-testid="gpa-error">{error}</span>}
    </div>
  ),
}));

function comEnforcement(permissions: string[], enforcement: AuthzContract['enforcement']) {
  useAdminAuthStore.setState({
    authzStatus: 'ready',
    authz: {
      uid: 'u', tenantId: 't', status: 'ACTIVE', permissions, countries: [], groups: [], features: {}, enforcement,
    } as AuthzContract,
  });
}

const baseWorker: WorkerDetail = {
  id: 'w1',
  email: 'worker@example.com',
  phone: null,
  whatsappPhone: null,
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  status: 'REGISTERED',
  overallStatus: null,
  availabilityStatus: null,
  dataSources: [],
  platform: 'app',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  firstName: 'Juana',
  lastName: 'Pérez',
  sex: null,
  gender: null,
  birthDate: null,
  documentType: 'DNI',
  documentNumber: '12345678',
  profilePhotoUrl: null,
  profession: 'AT',
  occupation: null,
  knowledgeLevel: null,
  titleCertificate: null,
  experienceTypes: [],
  yearsExperience: null,
  preferredTypes: [],
  preferredAgeRange: [],
  languages: [],
  sexualOrientation: null,
  race: null,
  religion: null,
  weightKg: null,
  heightCm: null,
  hobbies: [],
  diagnosticPreferences: [],
  linkedinUrl: null,
  isMatchable: true,
  isActive: true,
  isTest: false,
  documents: null,
  serviceAreas: [{ id: 'sa1', address: 'Av. Corrientes 1234', serviceRadiusKm: 10, lat: -34.6, lng: -58.4 }],
  location: null,
  encuadres: [],
};

/**
 * Worker com todos os campos opcionais ausentes — cobre o lado `??`/fallback
 * de cada default value (o `baseWorker` acima cobre o lado "valor presente").
 * `as unknown as WorkerDetail` porque em runtime a API pode devolver `null`/
 * `undefined` mesmo em campos que o tipo do domínio marca como sempre-array.
 */
const minimalWorker = {
  ...baseWorker,
  firstName: null,
  lastName: null,
  email: null,
  documentType: null,
  documentNumber: null,
  profession: null,
  occupation: null,
  knowledgeLevel: null,
  titleCertificate: null,
  yearsExperience: null,
  linkedinUrl: null,
  experienceTypes: undefined,
  preferredTypes: undefined,
  preferredAgeRange: undefined,
  languages: undefined,
} as unknown as WorkerDetail;

describe('WorkerEditModal', () => {
  beforeEach(() => {
    vi.mocked(AdminApiService.updateWorkerProfile).mockReset().mockResolvedValue({} as any);
    vi.mocked(AdminApiService.updateWorkerServiceArea).mockReset().mockResolvedValue(undefined as any);
    useAdminAuthStore.setState({ authz: null, authzStatus: 'idle' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  function renderModal(onClose = vi.fn(), onSaved = vi.fn()) {
    render(<WorkerEditModal worker={baseWorker} onClose={onClose} onSaved={onSaved} />);
    return { onClose, onSaved };
  }

  it('renders the drawer with the worker current values', () => {
    renderModal();
    expect(screen.getByTestId('worker-edit-modal')).toBeInTheDocument();
    expect(screen.getByTestId('we-firstName')).toHaveValue('Juana');
    expect(screen.getByTestId('we-lastName')).toHaveValue('Pérez');
    expect(screen.getByTestId('we-email')).toHaveValue('worker@example.com');
  });

  it('D269 — enforcement=on sem worker:write: "Guardar" NÃO existe', () => {
    comEnforcement([], 'on');
    renderModal();
    expect(screen.queryByTestId('we-save')).not.toBeInTheDocument();
  });

  it('D269 — enforcement=on com worker:write: "Guardar" existe', () => {
    comEnforcement(['worker:update'], 'on');
    renderModal();
    expect(screen.getByTestId('we-save')).toBeInTheDocument();
  });

  it('sem alterações: fecha sem chamar a API', async () => {
    const { onClose, onSaved } = renderModal();
    fireEvent.click(screen.getByTestId('we-save'));
    await vi.advanceTimersByTimeAsync(400);
    expect(AdminApiService.updateWorkerProfile).not.toHaveBeenCalled();
    expect(AdminApiService.updateWorkerServiceArea).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('email inválido: mostra erro e não salva', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('we-email'), { target: { value: 'not-an-email' } });
    fireEvent.click(screen.getByTestId('we-save'));
    expect(await screen.findByText('E-mail inválido')).toBeInTheDocument();
    expect(AdminApiService.updateWorkerProfile).not.toHaveBeenCalled();
  });

  it('altera firstName: chama updateWorkerProfile com o patch e fecha', async () => {
    const { onClose, onSaved } = renderModal();
    fireEvent.change(screen.getByTestId('we-firstName'), { target: { value: 'Juana Maria' } });
    fireEvent.click(screen.getByTestId('we-save'));
    await waitFor(() => expect(AdminApiService.updateWorkerProfile).toHaveBeenCalledWith('w1', { firstName: 'Juana Maria' }));
    expect(onSaved).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(400);
    expect(onClose).toHaveBeenCalled();
  });

  it('endereço alterado sem selecionar da lista: mostra erro e não salva', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('gpa-input'), { target: { value: 'Nueva dirección 999' } });
    fireEvent.click(screen.getByTestId('we-save'));
    await waitFor(() => expect(screen.getByTestId('gpa-error')).toBeInTheDocument());
    expect(AdminApiService.updateWorkerServiceArea).not.toHaveBeenCalled();
  });

  it('endereço alterado e selecionado da lista: chama updateWorkerServiceArea', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('gpa-input'), { target: { value: 'Nueva dirección 999' } });
    fireEvent.click(screen.getByTestId('gpa-select-place'));
    fireEvent.click(screen.getByTestId('we-save'));
    await waitFor(() => expect(AdminApiService.updateWorkerServiceArea).toHaveBeenCalled());
    const payload = vi.mocked(AdminApiService.updateWorkerServiceArea).mock.calls[0][1];
    expect(payload.address).toBe('Nueva dirección 999');
    expect(payload.lat).toBe(-34.6);
    expect(payload.lng).toBe(-58.4);
  });

  it('raio alterado (sem mudar endereço nem profile): salva a área de serviço com o endereço atual', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('we-radius'), { target: { value: '20' } });
    fireEvent.click(screen.getByTestId('we-save'));
    await waitFor(() => expect(AdminApiService.updateWorkerServiceArea).toHaveBeenCalled());
    const payload = vi.mocked(AdminApiService.updateWorkerServiceArea).mock.calls[0][1];
    expect(payload.serviceRadiusKm).toBe(20);
    expect(payload.address).toBe('Av. Corrientes 1234');
  });

  it('erro da API: mostra a mensagem de falha e não fecha', async () => {
    vi.mocked(AdminApiService.updateWorkerProfile).mockRejectedValue(new Error('falhou ao salvar'));
    const { onClose } = renderModal();
    fireEvent.change(screen.getByTestId('we-firstName'), { target: { value: 'Outro Nome' } });
    fireEvent.click(screen.getByTestId('we-save'));
    expect(await screen.findByText('falhou ao salvar')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape fecha o modal', async () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(document, { key: 'Escape' });
    await vi.advanceTimersByTimeAsync(400);
    expect(onClose).toHaveBeenCalled();
  });

  it('clique no backdrop fecha o modal', async () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByTestId('worker-edit-modal-backdrop'));
    await vi.advanceTimersByTimeAsync(400);
    expect(onClose).toHaveBeenCalled();
  });

  it('botão X fecha o modal', async () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByLabelText('Cerrar'));
    await vi.advanceTimersByTimeAsync(400);
    expect(onClose).toHaveBeenCalled();
  });

  it('altera documentType e profession: envia ambos no patch', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('we-documentType'), { target: { value: 'PASSPORT' } });
    fireEvent.change(screen.getByTestId('we-profession'), { target: { value: 'CAREGIVER' } });
    fireEvent.click(screen.getByTestId('we-save'));
    await waitFor(() => expect(AdminApiService.updateWorkerProfile).toHaveBeenCalledWith(
      'w1',
      { documentType: 'PASSPORT', profession: 'CAREGIVER' },
    ));
  });

  it('sem serviceAreas: usa radius default 10 e endereço vazio', () => {
    render(<WorkerEditModal worker={{ ...baseWorker, serviceAreas: [] }} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('we-radius')).toHaveValue('10');
    expect(screen.getByTestId('gpa-input')).toHaveValue('');
  });

  it('worker com todos os campos opcionais ausentes: renderiza com defaults vazios', () => {
    render(<WorkerEditModal worker={minimalWorker} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByTestId('we-firstName')).toHaveValue('');
    expect(screen.getByTestId('we-documentType')).toHaveValue('');
    expect(screen.getByTestId('we-profession')).toHaveValue('');
  });

  it('preenche um campo do worker mínimo: envia só o patch daquele campo', async () => {
    render(<WorkerEditModal worker={minimalWorker} onClose={vi.fn()} onSaved={vi.fn()} />);
    fireEvent.change(screen.getByTestId('we-firstName'), { target: { value: 'Nueva' } });
    fireEvent.click(screen.getByTestId('we-save'));
    await waitFor(() => expect(AdminApiService.updateWorkerProfile).toHaveBeenCalledWith('w1', { firstName: 'Nueva' }));
  });

  it('preenche TODOS os campos escalares e de array do worker mínimo: cada um entra no patch (cobre os fallbacks `worker.X ?? \'\'`/`?? []` quando worker.X é null/undefined)', async () => {
    const { container } = render(<WorkerEditModal worker={minimalWorker} onClose={vi.fn()} onSaved={vi.fn()} />);

    // MultiSelects (experienceTypes/preferredTypes/preferredAgeRange/languages)
    // não têm data-testid próprio — o `id` está no wrapper; abre e marca a
    // primeira opção de cada um.
    for (const wrapperId of ['we-experienceTypes', 'we-preferredTypes', 'we-ageRange', 'we-languages']) {
      const wrapper = container.querySelector(`#${wrapperId}`)!;
      fireEvent.click(wrapper.querySelector('button')!);
      fireEvent.click(wrapper.querySelectorAll('[role="option"] button')[0]);
    }

    fireEvent.change(screen.getByTestId('we-lastName'), { target: { value: 'Gómez' } });
    fireEvent.change(screen.getByTestId('we-email'), { target: { value: 'nueva@example.com' } });
    fireEvent.change(screen.getByTestId('we-documentNumber'), { target: { value: '99999999' } });
    fireEvent.change(screen.getByTestId('we-documentType'), { target: { value: 'PASSPORT' } });
    fireEvent.change(screen.getByTestId('we-profession'), { target: { value: 'CAREGIVER' } });
    fireEvent.change(screen.getByTestId('we-occupation'), { target: { value: 'CAREGIVER' } });
    fireEvent.change(screen.getByTestId('we-knowledge'), { target: { value: 'SECONDARY' } });
    fireEvent.change(screen.getByTestId('we-years'), { target: { value: '3_5' } });
    fireEvent.change(screen.getByTestId('we-title'), { target: { value: 'Título X' } });
    fireEvent.change(screen.getByTestId('we-linkedin'), { target: { value: 'https://linkedin.com/in/x' } });
    fireEvent.change(screen.getByTestId('we-complement'), { target: { value: 'Piso 3' } });
    fireEvent.click(screen.getByTestId('gpa-select-place'));
    fireEvent.click(screen.getByTestId('we-save'));
    await waitFor(() => expect(AdminApiService.updateWorkerProfile).toHaveBeenCalled());
    const patch = vi.mocked(AdminApiService.updateWorkerProfile).mock.calls[0][1];
    expect(patch.lastName).toBe('Gómez');
    expect(patch.email).toBe('nueva@example.com');
    expect(patch.documentNumber).toBe('99999999');
    expect(patch.documentType).toBe('PASSPORT');
    expect(patch.profession).toBe('CAREGIVER');
    expect(patch.occupation).toBe('CAREGIVER');
    expect(patch.knowledgeLevel).toBe('SECONDARY');
    expect(patch.yearsExperience).toBe('3_5');
    expect(patch.titleCertificate).toBe('Título X');
    expect(patch.linkedinUrl).toBe('https://linkedin.com/in/x');
    expect(patch.experienceTypes).toHaveLength(1);
    expect(patch.preferredTypes).toHaveLength(1);
    expect(patch.preferredAgeRange).toHaveLength(1);
    expect(patch.languages).toHaveLength(1);
  });

  it('resposta do Google sem geometry: não define coordenadas nem marca endereço válido', async () => {
    renderModal();
    fireEvent.click(screen.getByTestId('gpa-select-place-no-geometry'));
    fireEvent.change(screen.getByTestId('gpa-input'), { target: { value: 'Otra dirección' } });
    fireEvent.click(screen.getByTestId('we-save'));
    await waitFor(() => expect(screen.getByTestId('gpa-error')).toBeInTheDocument());
    expect(AdminApiService.updateWorkerServiceArea).not.toHaveBeenCalled();
  });

  it('erro não-Error (ex: rejeição com string): mostra a mensagem default de falha', async () => {
    vi.mocked(AdminApiService.updateWorkerProfile).mockRejectedValue('falha crua');
    renderModal();
    fireEvent.change(screen.getByTestId('we-firstName'), { target: { value: 'Outro Nome' } });
    fireEvent.click(screen.getByTestId('we-save'));
    expect(await screen.findByText('Error al guardar')).toBeInTheDocument();
  });
});
