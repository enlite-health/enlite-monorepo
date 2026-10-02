/** usePatientDocuments — spec 031: carga, ordem das mutações no estado, erro de carga e propagação de erro de mutação. */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const svc = vi.hoisted(() => ({
  listPatientDocuments: vi.fn(),
  uploadPatientDocument: vi.fn(),
  renamePatientDocument: vi.fn(),
  deletePatientDocument: vi.fn(),
}));
vi.mock('@infrastructure/http/AdminPatientDocumentsApiService', () => ({ AdminPatientDocumentsApiService: svc }));

import { usePatientDocuments } from '../usePatientDocuments';

const mk = (id: string, label = id) => ({
  id, origin: 'tab' as const, label, contentType: 'application/pdf', sizeBytes: 1,
  createdAt: '2026-10-01T00:00:00.000Z', createdByUid: 'u', createdByDisplayName: null, labelUpdatedAt: null,
});

beforeEach(() => Object.values(svc).forEach((m) => m.mockReset()));

describe('usePatientDocuments', () => {
  it('carrega a lista do paciente: loading → ok', async () => {
    svc.listPatientDocuments.mockResolvedValue([mk('a'), mk('b')]);
    const { result } = renderHook(() => usePatientDocuments('p1'));
    expect(result.current.status).toBe('loading');
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(svc.listPatientDocuments).toHaveBeenCalledWith('p1');
    expect(result.current.documents.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('falha de carga → status error e lista vazia', async () => {
    svc.listPatientDocuments.mockRejectedValue(new Error('x'));
    const { result } = renderHook(() => usePatientDocuments('p1'));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.documents).toEqual([]);
  });

  it('trocar de paciente recarrega; resposta atrasada do paciente anterior é descartada', async () => {
    let resolveOld!: (v: unknown) => void;
    svc.listPatientDocuments
      .mockReturnValueOnce(new Promise((r) => { resolveOld = r; }))
      .mockResolvedValueOnce([mk('novo')]);
    const { result, rerender } = renderHook(({ id }) => usePatientDocuments(id), { initialProps: { id: 'p1' } });
    rerender({ id: 'p2' });
    await waitFor(() => expect(result.current.documents.map((d) => d.id)).toEqual(['novo']));
    await act(async () => { resolveOld([mk('velho')]); });
    expect(result.current.documents.map((d) => d.id)).toEqual(['novo']);
  });

  it('descartar também a FALHA atrasada de um paciente que já foi trocado', async () => {
    let rejectOld!: (e: Error) => void;
    svc.listPatientDocuments
      .mockReturnValueOnce(new Promise((_r, rej) => { rejectOld = rej; }))
      .mockResolvedValueOnce([mk('novo')]);
    const { result, rerender } = renderHook(({ id }) => usePatientDocuments(id), { initialProps: { id: 'p1' } });
    rerender({ id: 'p2' });
    await waitFor(() => expect(result.current.status).toBe('ok'));
    await act(async () => { rejectOld(new Error('tarde')); });
    expect(result.current.status).toBe('ok');
  });

  it('upload entra no topo; rename troca só o item; remove tira o item', async () => {
    svc.listPatientDocuments.mockResolvedValue([mk('a'), mk('b')]);
    const { result } = renderHook(() => usePatientDocuments('p1'));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    const file = new File(['x'], 'f.pdf');

    svc.uploadPatientDocument.mockResolvedValue(mk('c'));
    await act(async () => { await result.current.upload('rótulo', file); });
    expect(svc.uploadPatientDocument).toHaveBeenCalledWith('p1', 'rótulo', file);
    expect(result.current.documents.map((d) => d.id)).toEqual(['c', 'a', 'b']);

    svc.renamePatientDocument.mockResolvedValue(mk('a', 'novo nome'));
    await act(async () => { await result.current.rename('a', 'novo nome'); });
    expect(svc.renamePatientDocument).toHaveBeenCalledWith('p1', 'a', 'novo nome');
    expect(result.current.documents.map((d) => d.label)).toEqual(['c', 'novo nome', 'b']);

    svc.deletePatientDocument.mockResolvedValue(undefined);
    await act(async () => { await result.current.remove('c'); });
    expect(svc.deletePatientDocument).toHaveBeenCalledWith('p1', 'c');
    expect(result.current.documents.map((d) => d.id)).toEqual(['a', 'b']);
  });

  it('erro de mutação PROPAGA e não mexe na lista', async () => {
    svc.listPatientDocuments.mockResolvedValue([mk('a')]);
    const { result } = renderHook(() => usePatientDocuments('p1'));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    svc.deletePatientDocument.mockRejectedValue(new Error('falhou'));
    await act(async () => { await expect(result.current.remove('a')).rejects.toThrow('falhou'); });
    expect(result.current.documents.map((d) => d.id)).toEqual(['a']);
  });
});
