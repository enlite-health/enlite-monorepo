import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { GeneralInfoTab } from '../GeneralInfoTab';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';
import { useWorkerRegistrationStore } from '@presentation/stores/workerRegistrationStore';

/**
 * A guarda do laço das 129 — a metade do conserto que NÃO tinha teste.
 *
 * O gate (rodada 2 do frontend) sabotou `form.reset({...values, phone: saved.phone ?? ''})`
 * de volta para `form.reset(values)` — que é LITERALMENTE o defeito que travou
 * 129 cadastros — e a suíte inteira ficou verde: 5.784/5.784. A linha
 * EXECUTAVA (cobertura verde) e nenhuma asserção lia o resultado. Cobertura de
 * linha não é cobertura de comportamento.
 *
 * O que se prova aqui: quando o servidor NÃO persiste o telefone, o campo
 * continua "sujo" e o PRÓXIMO autosave o reenvia. Rebaselinar com o payload
 * enviado dava por gravado o que não foi, e o número nunca mais era mandado.
 *
 * Este arquivo NÃO mocka `PhoneInputIntl` (o `GeneralInfoTab.test.tsx` mocka, e
 * foi assim que o defeito original escapou de 5.779 testes): sem o input real
 * não há como o campo ficar sujo, e o teste viraria teatro.
 */

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (k: string, d?: string) => d ?? k,
      i18n: { language: 'es', changeLanguage: vi.fn() },
    }),
  };
});
vi.mock('@presentation/hooks/useWorkerApi', () => ({ useWorkerApi: vi.fn() }));
vi.mock('@presentation/stores/workerRegistrationStore', () => ({
  useWorkerRegistrationStore: vi.fn(),
}));
vi.mock('@hookform/resolvers/zod', () => ({
  zodResolver: () => async (values: unknown) => ({ values, errors: {} }),
}));
vi.mock('@presentation/utils/imageCompression', () => ({
  compressImage: vi.fn((d: string) => Promise.resolve(d)),
}));

const mockSave = vi.fn();

/** Resposta de perfil SEM telefone — o backend não persistiu o número. */
const perfilSemTelefone = {
  id: 'w1',
  authUid: 'a1',
  email: 'ana@example.com',
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  missingFields: ['phone'],
};

function montarStore(): void {
  const state = {
    data: {
      generalInfo: {
        profilePhoto: null, fullName: 'Ana', lastName: 'Perez', cpf: '20304050',
        phone: '', email: 'ana@example.com', birthDate: '', sex: 'female',
        gender: 'female', documentType: 'CUIL_CUIT', professionalLicense: 'X-1',
        languages: ['es'], profession: 'AT', knowledgeLevel: 'SECONDARY',
        experienceTypes: ['adicciones'], yearsExperience: '0_2',
        preferredTypes: ['psicosis'], preferredAgeRange: ['adults'],
      },
      serviceAddress: { serviceRadius: 10, address: '', complement: '', acceptsRemoteService: false },
      availability: { schedule: [] },
    },
    isFieldReadonly: () => false,
    updateGeneralInfo: vi.fn(),
    hydrateFromServer: vi.fn(),
  };
  vi.mocked(useWorkerRegistrationStore).mockImplementation(
    (sel: (s: never) => unknown) => sel(state as never),
  );
}

describe('telefone recusado pelo servidor continua sendo reenviado', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSave.mockResolvedValue(perfilSemTelefone);
    montarStore();
    vi.mocked(useWorkerApi).mockReturnValue({
      saveGeneralInfo: mockSave, getProgress: vi.fn(), initWorker: vi.fn(),
      saveStep: vi.fn(), saveServiceArea: vi.fn(), saveAvailability: vi.fn(),
    } as never);
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('REGRESSÃO — o 2º autosave reenvia o telefone que o servidor não gravou', async () => {
    const { container } = render(<GeneralInfoTab />);
    const input = container.querySelector('#phone input') as HTMLInputElement;
    expect(input, 'o input real de telefone tem de existir — sem ele o teste é teatro').toBeTruthy();

    // A prestadora digita o número e sai do campo.
    fireEvent.change(input, { target: { value: '1151265663' } });
    fireEvent.blur(container.querySelector('form')!);
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });

    const primeiro = mockSave.mock.calls[mockSave.mock.calls.length - 1]?.[0];
    expect(primeiro, 'o 1º save tem de levar o telefone').toHaveProperty('phone');

    // O servidor respondeu SEM telefone: não persistiu. Ela mexe noutro campo.
    const select = container.querySelector('select#profession') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'CAREGIVER' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });

    const segundo = mockSave.mock.calls[mockSave.mock.calls.length - 1]?.[0];
    expect(mockSave.mock.calls.length).toBeGreaterThan(1);
    // O ponto: rebaselinar com o payload ENVIADO daria o número por gravado e
    // ele nunca mais seria mandado. Rebaselinando com o que o SERVIDOR devolveu
    // (vazio), o campo segue sujo e vai de novo.
    expect(segundo, 'o telefone recusado tem de ser REENVIADO').toHaveProperty('phone');
  });

  it('CONTROLE — telefone aceito pelo servidor NÃO é reenviado à toa', async () => {
    // Sem este caso, a asserção acima passaria com um "manda phone sempre",
    // que traz de volta o 409 por round-trip que o gate de `dirty` existe para
    // evitar.
    mockSave.mockResolvedValue({ ...perfilSemTelefone, phone: '+541151265663', missingFields: [] });

    const { container } = render(<GeneralInfoTab />);
    const input = container.querySelector('#phone input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1151265663' } });
    fireEvent.blur(container.querySelector('form')!);
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });

    const select = container.querySelector('select#profession') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'CAREGIVER' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 700)); });

    const segundo = mockSave.mock.calls[mockSave.mock.calls.length - 1]?.[0];
    expect(segundo).not.toHaveProperty('phone');
  });
});
