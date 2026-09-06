/**
 * usePatientKanban — spec 012, US-B7: o board passa a ler `admissionStatus` (funil de admissão,
 * migration 313), não `status` (estado clínico v2). Colunas: SOLICITANTE / ADMISSION /
 * PENDING_ADMISSION / DONE ("Activo"). Soltar em DONE manda `ACTIVE` (a saída do funil que o
 * seed da 315 permite), sempre com `changeSource: 'kanban'` — é a coluna "origem" do Historial.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const listPatientsForKanban = vi.fn();
const updatePatientStatus = vi.fn();
vi.mock('@infrastructure/http/AdminApiService', () => ({
  AdminApiService: {
    listPatientsForKanban: (...a: unknown[]) => listPatientsForKanban(...a),
    updatePatientStatus: (...a: unknown[]) => updatePatientStatus(...a),
  },
}));

import { usePatientKanban, PATIENT_KANBAN_STATUSES } from '../usePatientKanban';

const item = (id: string, admissionStatus: string, status: string) => ({
  id, firstName: 'P', lastName: id, caseNumber: null, dependencyLevel: null, status, admissionStatus, responsibleName: null,
});

describe('usePatientKanban — admission_status', () => {
  beforeEach(() => {
    listPatientsForKanban.mockReset().mockResolvedValue([
      item('a', 'SOLICITANTE', 'SOLICITANTE'),
      item('b', 'DONE', 'ON_HOLD'),      // em espera: já passou pela admissão → coluna "Activo"
      item('c', 'DONE', 'ACTIVE'),
      item('d', 'PENDING_ADMISSION', 'PENDING_ADMISSION'),
    ]);
    updatePatientStatus.mockReset().mockResolvedValue({ id: 'x', status: 'ACTIVE' });
  });

  it('as colunas são o funil + DONE, e o agrupamento é por admissionStatus (ON_HOLD cai em DONE)', async () => {
    expect([...PATIENT_KANBAN_STATUSES]).toEqual(['SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION', 'DONE']);
    const { result } = renderHook(() => usePatientKanban('AR'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(listPatientsForKanban).toHaveBeenCalledWith('AR');
    expect(result.current.groups.SOLICITANTE.map((p) => p.id)).toEqual(['a']);
    expect(result.current.groups.DONE.map((p) => p.id)).toEqual(['b', 'c']);
    expect(result.current.groups.PENDING_ADMISSION.map((p) => p.id)).toEqual(['d']);
    expect(result.current.groups.ADMISSION).toEqual([]);
  });

  it('mover para DONE envia ACTIVE com changeSource kanban; mover dentro do funil envia o próprio alvo', async () => {
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await act(async () => { expect(await result.current.moveStatus('d', 'DONE')).toBeNull(); });
    expect(updatePatientStatus).toHaveBeenLastCalledWith('d', { status: 'ACTIVE', changeSource: 'kanban' });
    expect(result.current.groups.DONE.map((p) => p.id)).toEqual(['d', 'b', 'c']);
    expect(result.current.groups.DONE[0].admissionStatus).toBe('DONE');
    await act(async () => { await result.current.moveStatus('a', 'ADMISSION'); });
    expect(updatePatientStatus).toHaveBeenLastCalledWith('a', { status: 'ADMISSION', changeSource: 'kanban' });
  });

  it('falha no PUT restaura o agrupamento anterior e devolve a mensagem; card desconhecido não muda nada', async () => {
    updatePatientStatus.mockRejectedValueOnce(new Error('422 transição'));
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let err: string | null = null;
    await act(async () => { err = await result.current.moveStatus('a', 'DONE'); });
    expect(err).toBe('422 transição');
    expect(result.current.groups.SOLICITANTE.map((p) => p.id)).toEqual(['a']);
    await act(async () => { err = await result.current.moveStatus('nao-existe', 'DONE'); });
    expect(result.current.groups.SOLICITANTE.map((p) => p.id)).toEqual(['a']);
    updatePatientStatus.mockRejectedValueOnce('string-error');
    await act(async () => { err = await result.current.moveStatus('a', 'DONE'); });
    expect(err).toBe('Failed to move patient');
  });

  // Spec 014 (US-D5, lex D5.1): quando o backend manda `code` (enum), o hook devolve o CÓDIGO,
  // nunca o texto cru — quem traduz para o toast é a página, com i18n (nunca eco de campo do
  // paciente). `code` vem de `PatientApiError` — a classe REAL usada pelo cliente HTTP.
  it('erro com `code` (PatientApiError real) → devolve o código, não a mensagem', async () => {
    class FakePatientApiError extends Error {
      readonly code?: string;
      constructor(message: string, code?: string) {
        super(message);
        this.code = code;
      }
    }
    updatePatientStatus.mockRejectedValueOnce(
      new FakePatientApiError('No se puede activar el paciente Juan Pérez', 'PATIENT_STATUS_TRANSITION_NOT_ALLOWED'),
    );
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    let err: string | null = null;
    await act(async () => { err = await result.current.moveStatus('a', 'DONE'); });
    expect(err).toBe('PATIENT_STATUS_TRANSITION_NOT_ALLOWED');
    // nunca o texto com o nome do paciente
    expect(err).not.toContain('Juan Pérez');
  });

  it('erro ao carregar vira `error`; refetch recarrega; fetch concorrente é ignorado', async () => {
    listPatientsForKanban.mockRejectedValueOnce(new Error('boom')).mockRejectedValueOnce('x');
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.error).toBe('boom'));
    await act(async () => { await result.current.refetch(); });
    expect(result.current.error).toBe('Failed to load patients');
  });

  it('refetch concorrente é ignorado (a 2ª chamada volta antes de bater na API)', async () => {
    const { result } = renderHook(() => usePatientKanban());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    listPatientsForKanban.mockClear();
    await act(async () => { void result.current.refetch(); await result.current.refetch(); });
    expect(listPatientsForKanban).toHaveBeenCalledTimes(1);
  });
});
