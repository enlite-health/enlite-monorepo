import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { GeneralInfoTab } from '../GeneralInfoTab';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';
import { WorkerApiService } from '@infrastructure/http/WorkerApiService';
import { ApiError } from '@infrastructure/http/ApiError';

/**
 * Emenda 077 §6 (AC-16): o telefone da aba Información General é só leitura, com selo
 * lido do servidor; o autosave NÃO manda `phone`; a colisão abre pelo `PHONE_IN_USE`
 * do `start` da verificação.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, d?: string | Record<string, string>) => (typeof d === 'string' ? d : k),
      i18n: { language: 'es', changeLanguage: vi.fn() },
    }),
  };
});
vi.mock('@presentation/hooks/useWorkerApi', () => ({ useWorkerApi: vi.fn() }));
vi.mock('@presentation/stores/workerRegistrationStore', () => ({ useWorkerRegistrationStore: vi.fn() }));
vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (values: unknown) => ({ values, errors: {} }),
}));
vi.mock('@presentation/utils/imageCompression', () => ({ compressImage: vi.fn((d: string) => Promise.resolve(d)) }));
vi.mock('@presentation/components/shared/PhoneConflictModal/PhoneConflictModal', () => ({
  PhoneConflictModal: ({ phoneEntered }: { phoneEntered: string }) => (
    <div data-testid="phone-conflict-stub">{phoneEntered}</div>
  ),
}));
vi.mock('@infrastructure/http/WorkerApiService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@infrastructure/http/WorkerApiService')>();
  return {
    ...actual,
    WorkerApiService: {
      startPhoneVerification: vi.fn(),
      confirmPhoneVerification: vi.fn(),
      lookupAccountLink: vi.fn(),
      getProgress: vi.fn(),
    },
  };
});

const mockSave = vi.fn();

type Verification = { state: 'no_phone' | 'unverified' | 'verified'; phoneMasked: string | null; verifiedAt: string | null } | null;

function montarStore(phone: string, phoneVerification: Verification): void {
  const state = {
    data: {
      generalInfo: {
        profilePhoto: null, fullName: 'Ana', lastName: 'Perez', cpf: '20304050', phone,
        email: 'ana@example.com', birthDate: '', sex: 'female', gender: 'female',
        documentType: 'CUIL_CUIT', professionalLicense: 'X-1', languages: ['es'], profession: 'AT',
        knowledgeLevel: 'SECONDARY', experienceTypes: ['adicciones'], yearsExperience: '0_2',
        preferredTypes: ['psicosis'], preferredAgeRange: ['adults'],
      },
      serviceAddress: { serviceRadius: 10, address: '', complement: '', acceptsRemoteService: false },
      availability: { schedule: [] },
    },
    phoneVerification,
    isFieldReadonly: () => false,
    updateGeneralInfo: vi.fn(),
    hydrateFromServer: vi.fn(),
  };
  vi.mocked(useWorkerRegistrationStore).mockImplementation((sel: (s: never) => unknown) => sel(state as never));
}

const verif = (state: 'no_phone' | 'unverified' | 'verified'): Verification => ({
  state,
  phoneMasked: state === 'no_phone' ? null : '+54 9 11 ****-5663',
  verifiedAt: state === 'verified' ? '2026-11-24T00:00:00Z' : null,
});

describe('GeneralInfoTab — celular verificado (web)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSave.mockResolvedValue({ message: 'General info saved', missingFields: null });
    vi.mocked(useWorkerApi).mockReturnValue({
      saveGeneralInfo: mockSave, getProgress: vi.fn(), initWorker: vi.fn(),
      saveStep: vi.fn(), saveServiceArea: vi.fn(), saveAvailability: vi.fn(),
    } as never);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('T-F3c-145 o selo reflete phoneVerification (sem número, sem verificar, verificado)', () => {
    const estados: Array<[string, Verification, string]> = [
      ['', verif('no_phone'), 'no_phone'],
      ['5491151265663', verif('unverified'), 'unverified'],
      ['5491151265663', verif('verified'), 'verified'],
    ];
    for (const [phone, v, esperado] of estados) {
      montarStore(phone, v);
      const { unmount } = render(<GeneralInfoTab />);
      expect(screen.getByTestId('phone-badge').getAttribute('data-state')).toBe(esperado);
      expect((screen.getByTestId('phone-readonly') as HTMLInputElement).readOnly).toBe(true);
      unmount();
    }
    // "não apurei" (null) com número: sem selo, nunca "verificado"
    montarStore('5491151265663', null);
    render(<GeneralInfoTab />);
    expect(screen.queryByTestId('phone-badge')).toBeNull();
  });

  it('T-F3c-145 os botões "Verificar" e "Cambiar número" existem', () => {
    montarStore('5491151265663', verif('unverified'));
    render(<GeneralInfoTab />);
    expect(screen.getByTestId('phone-verify-button').textContent).toBe('phoneVerification.verifyButton');
    expect(screen.getByTestId('phone-change-button').textContent).toBe('phoneVerification.changeButton');
  });

  it('T-F3c-145 o payload do autosave NÃO tem phone (AC-16)', async () => {
    montarStore('5491151265663', verif('unverified'));
    const { container } = render(<GeneralInfoTab />);
    fireEvent.change(container.querySelector('#lastName') as HTMLInputElement, { target: { value: 'Gomez' } });
    fireEvent.blur(container.querySelector('form')!);
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });

    expect(mockSave.mock.calls.length, 'o autosave tem de ter rodado').toBeGreaterThan(0);
    const payload = mockSave.mock.calls[mockSave.mock.calls.length - 1][0];
    expect(payload).toHaveProperty('lastName', 'Gomez');
    expect(payload).not.toHaveProperty('phone');
  });

  it('T-F3c-145 PHONE_IN_USE do start abre o vínculo (PhoneConflictModal) pelo número informado', async () => {
    montarStore('5491151265663', verif('unverified'));
    vi.mocked(WorkerApiService.startPhoneVerification).mockRejectedValue(
      new ApiError({ success: false, error: 'PHONE_IN_USE', code: 'PHONE_IN_USE' }, 409),
    );
    vi.mocked(WorkerApiService.lookupAccountLink).mockResolvedValue({ otherEmailMasked: 'o***@x.com', phoneMasked: '+54 ****' });
    render(<GeneralInfoTab />);

    fireEvent.click(screen.getByTestId('phone-verify-button'));
    fireEvent.click(await screen.findByTestId('phone-verification-send'));

    const stub = await screen.findByTestId('phone-conflict-stub');
    expect(stub.textContent).toBe('5491151265663');
    expect(WorkerApiService.lookupAccountLink).toHaveBeenCalledWith('5491151265663');
    await waitFor(() => expect(screen.queryByTestId('phone-verification-send')).toBeNull());
  });

  it('T-F3c-145 saveGeneralInfo (cliente HTTP) não manda phone', async () => {
    const real = (await vi.importActual<typeof import('@infrastructure/http/WorkerApiService')>(
      '@infrastructure/http/WorkerApiService',
    )).WorkerApiService;
    vi.spyOn(real['authService'], 'getIdToken').mockResolvedValue('tok');
    const fetchMock = vi.fn().mockResolvedValue({ status: 200, json: async () => ({ success: true, data: { id: 'w1' } }) });
    vi.stubGlobal('fetch', fetchMock);

    await real.saveGeneralInfo({ firstName: 'Ana', phone: '+5491151265663' });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({ firstName: 'Ana' });
    vi.unstubAllGlobals();
  });
});
