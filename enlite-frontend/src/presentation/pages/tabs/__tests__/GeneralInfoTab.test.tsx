import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, screen, act } from '@testing-library/react';
import { GeneralInfoTab } from '../GeneralInfoTab';
import { Toaster } from '@presentation/components/molecules/Toaster';
import { useToastStore } from '@presentation/stores/toastStore';
import { useAutoSave } from '@presentation/hooks/useAutoSave';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';
import { ApiError } from '@infrastructure/http/ApiError';

// i18n determinístico: t(key, defaultValue) → defaultValue (texto amigável).
// Mantém os demais exports (ex.: initReactI18next, usado por config.ts).
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, def?: string) => def ?? key,
      i18n: { language: 'es', changeLanguage: vi.fn() },
    }),
  };
});

const mockTriggerSave = vi.fn();
// A rota agora devolve o cadastro COMO O BANCO FICOU (escrita confirmada).
// O mock precisa refletir isso: um save que não devolve estado é o defeito
// que este contrato eliminou, não um cenário a simular.
const serverAfterSave = {
  id: 'worker-1', authUid: 'auth-1', email: 'a@b.c',
  country: 'AR', timezone: 'America/Argentina/Buenos_Aires',
  createdAt: '2026-01-01', updatedAt: '2026-01-01',
  phone: '+5491151265663',
  missingFields: [] as string[],
};
const mockSaveGeneralInfo = vi.fn().mockResolvedValue(serverAfterSave);
const mockGetProgress = vi.fn().mockResolvedValue({
  firstName: 'John',
  lastName: 'Doe',
  email: 'john@test.com',
  phone: '+5411999999',
  birthDate: '1990-01-01',
  sex: 'male',
  gender: 'male',
  documentType: 'DNI',
  documentNumber: '12345678',
  languages: ['es'],
  profession: 'AT',
  knowledgeLevel: 'SECONDARY',
  experienceTypes: ['adicciones'],
  yearsExperience: '0_2',
  preferredTypes: ['psicosis'],
  preferredAgeRange: 'adults',
  profilePhotoUrl: null,
  titleCertificate: 'ABC-123',
});

vi.mock('@presentation/hooks/useAutoSave', () => ({
  useAutoSave: vi.fn(),
}));

vi.mock('@presentation/hooks/useWorkerApi', () => ({
  useWorkerApi: vi.fn(),
}));

vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (values: any) => ({ values, errors: {} }),
}));

// Estado do store configurável por teste (simula o que o hydrateFromServer já
// deixou no store antes da aba montar — inclusive valores preservados quando o
// backend devolve null).
const mockUpdateGeneralInfo = vi.fn();
const mockHydrateFromServer = vi.fn();
function setStoreGeneralInfo(overrides: Record<string, unknown> = {}): void {
  const state = {
    data: {
      generalInfo: {
        profilePhoto: null, fullName: '', lastName: '', cpf: '', phone: '',
        email: '', birthDate: '', sex: '', gender: '', documentType: 'DNI',
        professionalLicense: '', languages: [], profession: '', knowledgeLevel: '',
        experienceTypes: [], yearsExperience: '', preferredTypes: [], preferredAgeRange: '',
        ...overrides,
      },
      serviceAddress: { serviceRadius: 10, address: '', complement: '', acceptsRemoteService: false },
      availability: { schedule: [] },
    },
    isFieldReadonly: () => false,
    updateGeneralInfo: mockUpdateGeneralInfo,
    hydrateFromServer: mockHydrateFromServer,
  };
  vi.mocked(useWorkerRegistrationStore).mockImplementation((selector: (s: any) => any) => selector(state));
}

vi.mock('@presentation/stores/workerRegistrationStore', () => ({
  useWorkerRegistrationStore: vi.fn(),
}));

vi.mock('@presentation/components/shared/PhoneInputIntl', () => ({
  PhoneInputIntl: () => null,
}));

vi.mock('@presentation/utils/imageCompression', () => ({
  compressImage: vi.fn((data: string) => Promise.resolve(data)),
}));

describe('GeneralInfoTab - Auto Save & Toast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useToastStore.setState({ toasts: [] });
    setStoreGeneralInfo();
    vi.mocked(useAutoSave).mockReturnValue(mockTriggerSave);
    vi.mocked(useWorkerApi).mockReturnValue({
      saveGeneralInfo: mockSaveGeneralInfo,
      getProgress: mockGetProgress,
      initWorker: vi.fn(),
      saveStep: vi.fn(),
      saveServiceArea: vi.fn(),
      saveAvailability: vi.fn(),
    } as any);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('should call useAutoSave with a save function', () => {
    render(<GeneralInfoTab />);
    expect(useAutoSave).toHaveBeenCalledWith(expect.any(Function), 500, expect.any(Function));
  });

  it('should trigger auto-save on form blur', () => {
    const { container } = render(<GeneralInfoTab />);
    const form = container.querySelector('form')!;
    fireEvent.blur(form);
    expect(mockTriggerSave).toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Regressão 31/08 — cada <select> tem de disparar o autosave SOZINHO.
  //
  // A tela não tem botão Guardar. Quem entra para corrigir UM dropdown e sai
  // nunca gera blur dentro do form: sem `triggerSave` no `onChange`, o PUT
  // simplesmente não acontece e o valor some no reload. Foi o que travou 50
  // prestadoras. Este teste é a rede de unidade; a de integração
  // (worker-profile-fields-persist) confere o mesmo no banco, com stack real.
  // ───────────────────────────────────────────────────────────────────────────
  it.each([
    ['sex', 'female'],
    ['gender', 'female'],
    ['profession', 'CAREGIVER'],
    ['knowledgeLevel', 'TERTIARY'],
    ['yearsExperience', '3_5'],
  ])('mudar o select #%s dispara o autosave sem precisar de blur', (id, value) => {
    const { container } = render(<GeneralInfoTab />);
    const select = container.querySelector(`select#${id}`) as HTMLSelectElement;
    expect(select, `select#${id} existe na tela`).toBeTruthy();

    // Zera DEPOIS do render. Sem isto a asserção é vácua: a montagem da tela já
    // chama `triggerSave` por conta própria, e o teste passaria idêntico com o
    // bug de volta — medido, foi o que aconteceu na primeira versão deste caso.
    mockTriggerSave.mockClear();

    // SÓ o change. Nenhum blur, nenhum clique em campo vizinho — é assim que a
    // prestadora usa a tela quando volta para corrigir um campo só.
    fireEvent.change(select, { target: { value } });

    expect(mockTriggerSave).toHaveBeenCalledTimes(1);
  });

  it('should trigger auto-save when an input field blurs', () => {
    const { container } = render(<GeneralInfoTab />);
    const input = container.querySelector('input#fullName')!;
    fireEvent.blur(input);
    expect(mockTriggerSave).toHaveBeenCalled();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // REGRESSÃO do bug "os campos aparecem e somem" (reproduzido em prod
  // 2026-06-29 na conta do próprio dono): o worker tinha o nome preservado no
  // store (hydrateFromServer mantém o valor local quando o backend devolve
  // null), mas a aba fazia `getProgress()` + `reset({ fullName: x || '' })` e
  // ZERAVA o campo. O fix removeu esse reset — o form é populado SÓ pelos
  // defaultValues (store). Este teste prova que o campo carrega e NÃO some.
  // ───────────────────────────────────────────────────────────────────────────
  it('mantém os campos preenchidos quando vêm do store (não some)', async () => {
    setStoreGeneralInfo({ fullName: 'Gabriel', lastName: 'Stein', cpf: '20-12345678-9' });
    // Mesmo que o backend devolvesse null, não pode haver wipe.
    mockGetProgress.mockResolvedValue({ firstName: null, lastName: null, documentNumber: null });

    const { container } = render(<GeneralInfoTab />);
    const fullName = container.querySelector('input#fullName') as HTMLInputElement;
    const lastName = container.querySelector('input#lastName') as HTMLInputElement;

    expect(fullName.value).toBe('Gabriel');
    expect(lastName.value).toBe('Stein');

    // Espera além de qualquer microtask/effect — se houvesse reset, zeraria aqui.
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

    expect((container.querySelector('input#fullName') as HTMLInputElement).value).toBe('Gabriel');
    expect((container.querySelector('input#lastName') as HTMLInputElement).value).toBe('Stein');
    // A aba não deve buscar do backend nem dar reset.
    expect(mockGetProgress).not.toHaveBeenCalled();
  });

  it('should call saveGeneralInfo when auto-save function executes', async () => {
    render(<GeneralInfoTab />);
    const saveFn = vi.mocked(useAutoSave).mock.calls[0][0];
    await act(async () => { await saveFn(); });
    expect(mockSaveGeneralInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        termsAccepted: true,
        privacyAccepted: true,
      }),
    );
  });

  // ── Escrita confirmada (incidente 08/09/2026) ────────────────────────────
  //
  // O store passou a ser sincronizado com a RESPOSTA DO SERVIDOR, nunca com o
  // payload enviado. Era o eco do próprio envio que mantinha na tela — e no
  // localStorage — um telefone que o banco nunca gravou.
  it('sincroniza o store com a RESPOSTA do servidor, não com o payload enviado', async () => {
    setStoreGeneralInfo({ fullName: 'Gabriel', lastName: 'Stein' });
    render(<GeneralInfoTab />);
    const saveFn = vi.mocked(useAutoSave).mock.calls[0][0];
    await act(async () => { await saveFn(); });

    expect(mockHydrateFromServer).toHaveBeenCalledWith(serverAfterSave, { authoritative: true });
    // O caminho antigo (gravar o que mandamos) não pode voltar.
    expect(mockUpdateGeneralInfo).not.toHaveBeenCalled();
  });

  it('shows a success toast when auto-save succeeds', async () => {
    render(<><GeneralInfoTab /><Toaster /></>);

    const saveFn = vi.mocked(useAutoSave).mock.calls[0][0];
    await act(async () => { await saveFn(); });

    expect(await screen.findByTestId('toast-success')).toBeTruthy();
  });

  it('shows an error toast when auto-save fails', async () => {
    render(<><GeneralInfoTab /><Toaster /></>);

    const onError = vi.mocked(useAutoSave).mock.calls[0][2]!;
    act(() => onError(new Error('Save failed')));

    expect(await screen.findByTestId('toast-error')).toBeTruthy();
  });

  // Regressão: o erro de telefone duplicado NUNCA pode mostrar SQL cru ao worker.
  describe('erro de telefone (PHONE_NOT_AVAILABLE)', () => {
    it('mostra mensagem amigável e NUNCA o SQL cru quando o backend retorna code PHONE_NOT_AVAILABLE', async () => {
      const apiError = new ApiError(
        {
          success: false,
          // mesmo que o backend mandasse uma mensagem feia, o code manda:
          error: 'El teléfono ingresado no puede ser utilizado.',
          code: 'PHONE_NOT_AVAILABLE',
        },
        409,
      );

      render(<><GeneralInfoTab /><Toaster /></>);

      // O autosave traduz o erro via onError → toast amigável (nunca SQL cru).
      const onError = vi.mocked(useAutoSave).mock.calls[0][2]!;
      act(() => onError(apiError));

      const toast = await screen.findByTestId('toast-error');

      expect(toast.textContent).toContain('no puede ser utilizado');
      // Garantia central: jamais expor detalhes de SQL/constraint.
      expect(toast.textContent?.toLowerCase()).not.toContain('duplicate key');
      expect(toast.textContent?.toLowerCase()).not.toContain('constraint');
      expect(toast.textContent?.toLowerCase()).not.toContain('idx_workers_phone_unique');
    });
  });
});
