/**
 * useVacancyModalFlow — unit tests
 *
 * Cobre o regression que motivou a hidratação síncrona do `selectedAddressId`:
 * em edit mode (CreateVacancyPage `/admin/vacancies/:id/edit`), o botão
 * Continuar ficava travado em disabled enquanto o Promise.all do
 * `selectCase` não resolvia, porque o gate `formComplete` em
 * VacancyFormSection lia `!!selectedAddressId === false`.
 *
 * O fix garante que quando `preferredAddressId` é passado, o
 * `selectedAddressId` é setado imediatamente no setState inicial,
 * não esperando pelo fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useVacancyModalFlow } from '../useVacancyModalFlow';

vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    getPatientById: vi.fn(),
    listPatientAddresses: vi.fn(),
  },
}));

import { AdminApiService } from '@infrastructure/http/AdminApiService';

const mockGetPatient = vi.mocked(AdminApiService.getPatientById);
const mockListAddresses = vi.mocked(AdminApiService.listPatientAddresses);

const PATIENT = {
  id: 'pat-1',
  firstName: 'Ana',
  lastName: 'García',
  dependencyLevel: 'SEVERE',
};

const ADDRESS_1 = {
  id: 'addr-1',
  patient_id: 'pat-1',
  address_formatted: 'Av. Italia 736, Tigre, Buenos Aires, Argentina',
  address_raw: 'Av. Italia 736',
  display_order: 1,
  source: 'manual',
  complement: null,
  lat: -34.4,
  lng: -58.5,
};

const ADDRESS_2 = {
  ...ADDRESS_1,
  id: 'addr-2',
  address_formatted: 'Carlos Gardel 2466, Olivos, Buenos Aires, Argentina',
  display_order: 2,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPatient.mockResolvedValue(PATIENT as any);
  mockListAddresses.mockResolvedValue([ADDRESS_1, ADDRESS_2] as any);
});

describe('useVacancyModalFlow — selectCase sem preferredAddressId', () => {
  it('estado inicial é vazio', () => {
    const { result } = renderHook(() => useVacancyModalFlow());
    expect(result.current.selectedCaseNumber).toBeNull();
    expect(result.current.selectedAddressId).toBeNull();
    expect(result.current.addresses).toEqual([]);
  });

  it('auto-seleciona o primeiro endereço após o fetch resolver', async () => {
    const { result } = renderHook(() => useVacancyModalFlow());

    act(() => {
      result.current.selectCase(42, 'pat-1');
    });

    await waitFor(() => {
      expect(result.current.isLoadingPatient).toBe(false);
    });

    expect(result.current.addresses).toHaveLength(2);
    expect(result.current.selectedAddressId).toBe(ADDRESS_1.id);
    expect(result.current.dependencyLevel).toBe('SEVERE');
  });
});

describe('useVacancyModalFlow — selectCase com preferredAddressId (edit mode)', () => {
  it('seta selectedAddressId IMEDIATAMENTE no setState inicial — antes do Promise.all resolver', () => {
    // Esse é o regression que causava o botão Continuar travado em disabled:
    // VacancyFormSection.isComplete lia `!!selectedAddressId` durante a janela
    // entre selectCase e a resolução do fetch. Sem essa hidratação síncrona,
    // o gate `formComplete` em CreateVacancyPage ficava false.
    let pendingResolve: ((v: any) => void) | undefined;
    mockListAddresses.mockReturnValue(
      new Promise((resolve) => {
        pendingResolve = resolve;
      }) as any,
    );

    const { result } = renderHook(() => useVacancyModalFlow());

    act(() => {
      result.current.selectCase(42, 'pat-1', ADDRESS_2.id);
    });

    // ANTES do Promise.all resolver, selectedAddressId já tem que estar setado
    expect(result.current.selectedAddressId).toBe(ADDRESS_2.id);
    expect(result.current.isLoadingPatient).toBe(true);
    expect(result.current.addresses).toEqual([]);

    // resolve pra evitar warning de "act"
    act(() => {
      pendingResolve?.([ADDRESS_1, ADDRESS_2]);
    });
  });

  it('mantém o preferredAddressId quando ele existe na lista fetchada', async () => {
    const { result } = renderHook(() => useVacancyModalFlow());

    act(() => {
      result.current.selectCase(42, 'pat-1', ADDRESS_2.id);
    });

    await waitFor(() => {
      expect(result.current.isLoadingPatient).toBe(false);
    });

    expect(result.current.selectedAddressId).toBe(ADDRESS_2.id);
    expect(result.current.addresses).toHaveLength(2);
  });

  it('faz fallback para addresses[0] quando o preferred id não existe na lista (ex: endereço deletado)', async () => {
    const { result } = renderHook(() => useVacancyModalFlow());

    act(() => {
      result.current.selectCase(42, 'pat-1', 'addr-deletado-9999');
    });

    await waitFor(() => {
      expect(result.current.isLoadingPatient).toBe(false);
    });

    // Fallback pro primeiro da lista
    expect(result.current.selectedAddressId).toBe(ADDRESS_1.id);
  });

  it('cai pra null quando o paciente não tem endereço algum', async () => {
    mockListAddresses.mockResolvedValue([] as any);
    const { result } = renderHook(() => useVacancyModalFlow());

    act(() => {
      result.current.selectCase(42, 'pat-1', 'addr-x');
    });

    await waitFor(() => {
      expect(result.current.isLoadingPatient).toBe(false);
    });

    expect(result.current.selectedAddressId).toBeNull();
    expect(result.current.addresses).toEqual([]);
  });
});

describe('useVacancyModalFlow — selectAddress / reset / error', () => {
  it('selectAddress troca o selectedAddressId', async () => {
    const { result } = renderHook(() => useVacancyModalFlow());

    act(() => {
      result.current.selectCase(42, 'pat-1');
    });
    await waitFor(() => expect(result.current.isLoadingPatient).toBe(false));
    expect(result.current.selectedAddressId).toBe(ADDRESS_1.id);

    act(() => {
      result.current.selectAddress(ADDRESS_2.id);
    });
    expect(result.current.selectedAddressId).toBe(ADDRESS_2.id);
  });

  it('reset volta tudo pro estado inicial', async () => {
    const { result } = renderHook(() => useVacancyModalFlow());

    act(() => {
      result.current.selectCase(42, 'pat-1');
    });
    await waitFor(() => expect(result.current.isLoadingPatient).toBe(false));
    expect(result.current.selectedCaseNumber).toBe(42);

    act(() => {
      result.current.reset();
    });
    expect(result.current.selectedCaseNumber).toBeNull();
    expect(result.current.selectedPatientId).toBeNull();
    expect(result.current.selectedAddressId).toBeNull();
    expect(result.current.addresses).toEqual([]);
  });

  it('expõe patientError quando o fetch falha', async () => {
    mockGetPatient.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useVacancyModalFlow());

    act(() => {
      result.current.selectCase(42, 'pat-1');
    });

    await waitFor(() => {
      expect(result.current.isLoadingPatient).toBe(false);
    });

    expect(result.current.patientError).toBe('boom');
    expect(result.current.addresses).toEqual([]);
  });
});
