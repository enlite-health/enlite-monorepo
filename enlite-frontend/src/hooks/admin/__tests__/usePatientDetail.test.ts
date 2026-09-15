import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { usePatientDetail } from '../usePatientDetail';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import { patientDetailFixture } from '@presentation/components/features/admin/PatientDetail/__tests__/patientDetailFixture';

vi.mock('@infrastructure/http/AdminApiService');

describe('usePatientDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Carregamento inicial ────────────────────────────────────────────────────

  it('isLoading=true no carregamento inicial (troca de patientId)', () => {
    vi.spyOn(AdminApiService, 'getPatientById').mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => usePatientDetail('p-1'));

    expect(result.current.isLoading).toBe(true);
    expect(result.current.patient).toBeNull();
  });

  it('isLoading=true de novo quando o patientId TROCA', async () => {
    const spy = vi.spyOn(AdminApiService, 'getPatientById').mockResolvedValue(patientDetailFixture);
    const { result, rerender } = renderHook(({ id }) => usePatientDetail(id), {
      initialProps: { id: 'p-1' as string | undefined },
    });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    spy.mockReturnValue(new Promise(() => {}));
    rerender({ id: 'p-2' });

    expect(result.current.isLoading).toBe(true);
  });

  // ── Item 1+4 (A1): refetch pós-salvamento é SILENCIOSO ─────────────────────
  // Causa medida: PatientDetailPage.tsx troca a página inteira por <DetailSkeleton/> quando
  // isLoading===true. refetch() é chamado no onSaved de todo card de edição — se ele ligar
  // isLoading, salvar QUALQUER card do card pisca a página inteira para skeleton.

  it('🔴 refetch() NÃO liga isLoading — a tela não pisca para skeleton', async () => {
    const spy = vi.spyOn(AdminApiService, 'getPatientById')
      .mockResolvedValueOnce(patientDetailFixture)
      .mockResolvedValueOnce({ ...patientDetailFixture, firstName: 'Atualizado' });

    const { result } = renderHook(() => usePatientDetail('p-1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let refetchPromiseSettled = false;
    act(() => {
      result.current.refetch();
    });

    // Sincronamente após chamar refetch — isLoading NUNCA deve ter ido a `true`.
    expect(result.current.isLoading).toBe(false);
    // O dado ANTERIOR continua na tela enquanto a resposta não chega.
    expect(result.current.patient?.firstName).toBe('Santiago');

    await waitFor(() => {
      refetchPromiseSettled = result.current.patient?.firstName === 'Atualizado';
      expect(refetchPromiseSettled).toBe(true);
    });

    expect(result.current.isLoading).toBe(false);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('refetch() com erro mantém o `patient` anterior na tela e expõe o erro', async () => {
    vi.spyOn(AdminApiService, 'getPatientById')
      .mockResolvedValueOnce(patientDetailFixture)
      .mockRejectedValueOnce(new Error('Falha de rede'));

    const { result } = renderHook(() => usePatientDetail('p-1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.patient).toEqual(patientDetailFixture);

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.error).toBe('Falha de rede'));

    // A ficha NÃO some por causa do erro do refetch silencioso.
    expect(result.current.patient).toEqual(patientDetailFixture);
    expect(result.current.isLoading).toBe(false);
  });

  it('carregamento inicial: erro seta `error` e mantém `patient` nulo', async () => {
    vi.spyOn(AdminApiService, 'getPatientById').mockRejectedValue(new Error('Falha de rede'));

    const { result } = renderHook(() => usePatientDetail('p-1'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Falha de rede');
    expect(result.current.patient).toBeNull();
  });

  it('carregamento inicial: erro sem `message` cai no fallback', async () => {
    vi.spyOn(AdminApiService, 'getPatientById').mockRejectedValue({});

    const { result } = renderHook(() => usePatientDetail('p-1'));

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.error).toBe('Falha ao carregar paciente');
  });

  it('refetch() com erro sem `message` cai no fallback (mantendo o `patient` anterior)', async () => {
    vi.spyOn(AdminApiService, 'getPatientById')
      .mockResolvedValueOnce(patientDetailFixture)
      .mockRejectedValueOnce({});

    const { result } = renderHook(() => usePatientDetail('p-1'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.error).toBe('Falha ao carregar paciente'));
    expect(result.current.patient).toEqual(patientDetailFixture);
  });

  it('refetch() não faz nada sem patientId', () => {
    const spy = vi.spyOn(AdminApiService, 'getPatientById');
    const { result } = renderHook(() => usePatientDetail(undefined));

    act(() => {
      result.current.refetch();
    });

    expect(spy).not.toHaveBeenCalled();
  });
});
