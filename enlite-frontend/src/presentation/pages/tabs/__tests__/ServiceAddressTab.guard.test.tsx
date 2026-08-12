import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { ServiceAddressTab, type BeforeNextGuard } from '../ServiceAddressTab';
import { useAutoSave } from '@presentation/hooks/useAutoSave';
import { useWorkerApi } from '@presentation/hooks/useWorkerApi';

/**
 * Gate do Siguiente na aba de endereço: sem dirección o guard devolve false
 * (o wizard não avança) e traz o campo à vista; com dirección devolve true.
 */

const mockGetProgress = vi.fn().mockResolvedValue({});

// Endereço "atual" do formulário — mutável por teste (defaultValues vêm da store).
let storeAddress = '';

vi.mock('@presentation/hooks/useAutoSave', () => ({
  useAutoSave: vi.fn(),
}));

vi.mock('@presentation/hooks/useWorkerApi', () => ({
  useWorkerApi: vi.fn(),
}));

vi.mock('@hookform/resolvers/zod', () => ({
  // Reproduz a regra real (address obrigatório) sem depender do i18n do schema.
  zodResolver: () => async (values: Record<string, unknown>) =>
    values.address
      ? { values, errors: {} }
      : {
          values: {},
          errors: { address: { type: 'too_small', message: 'La dirección es obligatoria' } },
        },
}));

vi.mock('@presentation/stores/workerRegistrationStore', () => ({
  useWorkerRegistrationStore: vi.fn((selector: (state: unknown) => unknown) => {
    const state = {
      data: {
        generalInfo: {},
        serviceAddress: {
          serviceRadius: 10,
          address: storeAddress,
          complement: '',
          acceptsRemoteService: false,
        },
        availability: { schedule: [] },
      },
      isFieldReadonly: () => false,
    };
    return selector(state);
  }),
}));

vi.mock('@presentation/components/molecules', () => ({
  GooglePlacesAutocomplete: () => (
    <input data-testid="address-autocomplete-input" readOnly />
  ),
  AddressField: () => null,
  InputWithIcon: () => null,
  ServiceAreaMap: () => null,
}));

vi.mock('@presentation/components/shared/DistanceSlider', () => ({
  DistanceSlider: () => null,
}));

vi.mock('@application/use-cases/extractAddressComponents', () => ({
  extractAddressComponents: vi.fn().mockReturnValue({}),
}));

describe('ServiceAddressTab — gate do Siguiente (registerBeforeNextGuard)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeAddress = '';
    vi.mocked(useAutoSave).mockReturnValue(vi.fn());
    vi.mocked(useWorkerApi).mockReturnValue({
      saveServiceArea: vi.fn(),
      getProgress: mockGetProgress,
    } as unknown as ReturnType<typeof useWorkerApi>);
    Element.prototype.scrollIntoView = vi.fn();
  });

  function renderWithGuard(): { getGuard: () => BeforeNextGuard; register: ReturnType<typeof vi.fn> } {
    const register = vi.fn();
    render(<ServiceAddressTab registerBeforeNextGuard={register} />);
    return {
      register,
      getGuard: () => {
        const guards = register.mock.calls
          .map((c) => c[0] as BeforeNextGuard | null)
          .filter((g): g is BeforeNextGuard => g !== null);
        expect(guards.length).toBeGreaterThan(0);
        return guards[guards.length - 1];
      },
    };
  }

  it('registra o guard ao montar e desregistra (null) ao desmontar', () => {
    const register = vi.fn();
    const { unmount } = render(<ServiceAddressTab registerBeforeNextGuard={register} />);

    expect(register).toHaveBeenCalledWith(expect.any(Function));

    unmount();
    expect(register).toHaveBeenLastCalledWith(null);
  });

  it('bloqueia o avanço (false) com endereço vazio e traz o campo à vista', async () => {
    const { getGuard } = renderWithGuard();

    const allowed = await getGuard()();

    expect(allowed).toBe(false);
    await waitFor(() => {
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    });
  });

  it('libera o avanço (true) quando o endereço está preenchido', async () => {
    storeAddress = 'Av. Corrientes 1234, CABA';
    const { getGuard } = renderWithGuard();

    const allowed = await getGuard()();

    expect(allowed).toBe(true);
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
