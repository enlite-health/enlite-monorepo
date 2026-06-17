import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';
import { GeneralInfoTab } from '../GeneralInfoTab';
import { useAutoSave } from '@presentation/hooks/useAutoSave';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
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
const mockSaveGeneralInfo = vi.fn().mockResolvedValue(undefined);
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

vi.mock('@presentation/stores/workerRegistrationStore', () => ({
  useWorkerRegistrationStore: vi.fn((selector: (state: any) => any) => {
    const state = {
      data: {
        generalInfo: {
          profilePhoto: null, fullName: '', lastName: '', cpf: '', phone: '',
          email: '', birthDate: '', sex: '', gender: '', documentType: 'DNI',
          professionalLicense: '', languages: [], profession: '', knowledgeLevel: '',
          experienceTypes: [], yearsExperience: '', preferredTypes: [], preferredAgeRange: '',
        },
        serviceAddress: { serviceRadius: 10, address: '', complement: '', acceptsRemoteService: false },
        availability: { schedule: [] },
      },
      isFieldReadonly: () => false,
    };
    return selector(state);
  }),
}));

vi.mock('@presentation/components/shared/PhoneInputIntl', () => ({
  PhoneInputIntl: () => null,
}));

vi.mock('@presentation/utils/imageCompression', () => ({
  compressImage: vi.fn((data: string) => Promise.resolve(data)),
}));

describe('GeneralInfoTab - Auto Save & Scroll', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('should trigger auto-save when an input field blurs', () => {
    const { container } = render(<GeneralInfoTab />);
    const input = container.querySelector('input#fullName')!;
    fireEvent.blur(input);
    expect(mockTriggerSave).toHaveBeenCalled();
  });

  it('should call saveGeneralInfo when auto-save function executes', async () => {
    render(<GeneralInfoTab />);
    const saveFn = vi.mocked(useAutoSave).mock.calls[0][0];
    await saveFn();
    expect(mockSaveGeneralInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        termsAccepted: true,
        privacyAccepted: true,
      }),
    );
  });

  it('should scroll to top on successful manual save', async () => {
    mockSaveGeneralInfo.mockResolvedValueOnce(undefined);
    const { container } = render(<GeneralInfoTab />);

    await waitFor(() => expect(mockGetProgress).toHaveBeenCalled());

    const form = container.querySelector('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'start',
      });
    });
  });

  it('should scroll to top on save error', async () => {
    mockSaveGeneralInfo.mockRejectedValueOnce(new Error('Save failed'));
    const { container } = render(<GeneralInfoTab />);

    await waitFor(() => expect(mockGetProgress).toHaveBeenCalled());

    const form = container.querySelector('form')!;
    fireEvent.submit(form);

    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'start',
      });
    });
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
      mockSaveGeneralInfo.mockRejectedValueOnce(apiError);

      const { container } = render(<GeneralInfoTab />);
      await waitFor(() => expect(mockGetProgress).toHaveBeenCalled());

      fireEvent.submit(container.querySelector('form')!);

      const errorBox = await waitFor(() => {
        const el = container.querySelector('.bg-red-50');
        expect(el).not.toBeNull();
        return el!;
      });

      expect(errorBox.textContent).toContain('no puede ser utilizado');
      // Garantia central: jamais expor detalhes de SQL/constraint.
      expect(errorBox.textContent?.toLowerCase()).not.toContain('duplicate key');
      expect(errorBox.textContent?.toLowerCase()).not.toContain('constraint');
      expect(errorBox.textContent?.toLowerCase()).not.toContain('idx_workers_phone_unique');
    });
  });
});
