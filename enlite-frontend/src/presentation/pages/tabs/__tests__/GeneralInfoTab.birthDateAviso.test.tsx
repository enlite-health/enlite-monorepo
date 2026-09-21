/**
 * GeneralInfoTab.birthDateAviso.test.tsx
 *
 * Spec 025, decisão do Gabriel 21/09 (opção A): worker REGISTERED com data de
 * nascimento gravada inválida (não-ISO) vê um AVISO no app pedindo pra
 * recadastrar — sem WhatsApp/Luz, só UI. O sinal vem do store
 * (`birthDateInvalid`), que o `hydrateFromServer` liga/desliga a partir de
 * `WorkerProgressResponse.birthDateStatus`.
 *
 * Este teste cobre só o CONTRATO de UI: aviso aparece quando o store diz
 * `birthDateInvalid: true`, some quando `false`. A hidratação em si (por que o
 * flag liga/desliga) já está coberta em `workerRegistrationStore.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GeneralInfoTab } from '../GeneralInfoTab';
import { useAutoSave } from '@presentation/hooks/useAutoSave';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';

const WARNING_TEXT_ES = 'Tu fecha de nacimiento no es válida. Cargala de nuevo.';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, def?: string) => {
        if (key === 'workerRegistration.generalInfo.birthDateInvalidWarning') {
          return WARNING_TEXT_ES;
        }
        return def ?? key;
      },
      i18n: { language: 'es', changeLanguage: vi.fn() },
    }),
  };
});

vi.mock('@presentation/hooks/useAutoSave', () => ({ useAutoSave: vi.fn() }));
vi.mock('@presentation/hooks/useWorkerApi', () => ({ useWorkerApi: vi.fn() }));
vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (values: any) => ({ values, errors: {} }),
}));
vi.mock('@presentation/components/shared/PhoneInputIntl', () => ({ PhoneInputIntl: () => null }));
vi.mock('@presentation/utils/imageCompression', () => ({
  compressImage: vi.fn((data: string) => Promise.resolve(data)),
}));
vi.mock('@presentation/stores/workerRegistrationStore', () => ({
  useWorkerRegistrationStore: vi.fn(),
}));

function baseGeneralInfo(overrides: Record<string, unknown> = {}) {
  return {
    profilePhoto: null, fullName: '', lastName: '', cpf: '', phone: '',
    email: '', birthDate: '', sex: '', gender: '', documentType: 'DNI',
    professionalLicense: '', languages: [], profession: '', knowledgeLevel: '',
    experienceTypes: [], yearsExperience: '', preferredTypes: [], preferredAgeRange: '',
    ...overrides,
  };
}

function setStore(birthDateInvalid: boolean, generalInfoOverrides: Record<string, unknown> = {}): void {
  const state = {
    data: {
      generalInfo: baseGeneralInfo(generalInfoOverrides),
      serviceAddress: { serviceRadius: 10, address: '', complement: '', acceptsRemoteService: false },
      availability: { schedule: [] },
    },
    isFieldReadonly: () => false,
    updateGeneralInfo: vi.fn(),
    hydrateFromServer: vi.fn(),
    birthDateInvalid,
  };
  vi.mocked(useWorkerRegistrationStore).mockImplementation((selector: (s: any) => any) => selector(state));
}

describe('GeneralInfoTab — aviso de data de nascimento inválida (spec 025, opção A)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useAutoSave).mockReturnValue(vi.fn());
    vi.mocked(useWorkerApi).mockReturnValue({
      saveGeneralInfo: vi.fn().mockResolvedValue({}),
      getProgress: vi.fn().mockResolvedValue({}),
      initWorker: vi.fn(),
      saveStep: vi.fn(),
      saveServiceArea: vi.fn(),
      saveAvailability: vi.fn(),
    } as any);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('birthDateInvalid=true → mostra o aviso em es-AR e destaca o campo', () => {
    setStore(true);
    render(<GeneralInfoTab />);

    expect(screen.getByText(WARNING_TEXT_ES)).toBeInTheDocument();

    const input = screen.getByTestId('birthDate-input') as HTMLInputElement;
    // InputWithIcon: `error` presente → borda vermelha no wrapper.
    expect(input.closest('div')?.className).toContain('border-red-500');
  });

  it('birthDateInvalid=false → NÃO mostra o aviso', () => {
    setStore(false);
    render(<GeneralInfoTab />);

    expect(screen.queryByText(WARNING_TEXT_ES)).not.toBeInTheDocument();

    const input = screen.getByTestId('birthDate-input') as HTMLInputElement;
    expect(input.closest('div')?.className).not.toContain('border-red-500');
  });
});
