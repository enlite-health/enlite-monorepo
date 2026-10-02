/** useOpenPatientDocument — spec 031, FR-006: URL pedida a cada clique, aba aberta no mesmo tick, fecha sozinha, erros em es-AR. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const getUrl = vi.hoisted(() => vi.fn());
vi.mock('@infrastructure/http/AdminPatientDocumentsApiService', () => ({
  AdminPatientDocumentsApiService: { getPatientDocumentUrl: getUrl },
}));
vi.mock('react-i18next', async () => (await import('@presentation/components/features/admin/PatientDetail/documents/__tests__/documentsTestKit')).i18nMock);

import { useOpenPatientDocument } from '../useOpenPatientDocument';

const makePopup = (closed = false) => ({ opener: 'x' as unknown, closed, close: vi.fn(), location: { href: '' } });

beforeEach(() => { getUrl.mockReset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('useOpenPatientDocument', () => {
  it('abre a aba ANTES de pedir a URL, aponta para a URL assinada e fecha depois de 2 s se ainda aberta', async () => {
    const popup = makePopup();
    const order: string[] = [];
    vi.stubGlobal('open', vi.fn(() => { order.push('open'); return popup; }));
    getUrl.mockImplementation(async () => { order.push('url'); return { url: 'https://signed/x', expiresInSeconds: 300 }; });
    const { result } = renderHook(() => useOpenPatientDocument('p1'));
    await act(async () => { await result.current.openDocument('d1'); });
    expect(order).toEqual(['open', 'url']);
    expect(getUrl).toHaveBeenCalledWith('p1', 'd1');
    expect(popup.location.href).toBe('https://signed/x');
    expect(popup.opener).toBeNull();
    expect(popup.close).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(2000); });
    expect(popup.close).toHaveBeenCalledTimes(1);
    expect(result.current.viewError).toBeNull();
  });

  it('aba que o usuário já fechou não é fechada de novo', async () => {
    const popup = makePopup(true);
    vi.stubGlobal('open', vi.fn(() => popup));
    getUrl.mockResolvedValue({ url: 'https://signed/x', expiresInSeconds: 300 });
    const { result } = renderHook(() => useOpenPatientDocument('p1'));
    await act(async () => { await result.current.openDocument('d1'); });
    act(() => { vi.advanceTimersByTime(2000); });
    expect(popup.close).not.toHaveBeenCalled();
  });

  it('pop-up bloqueado → erro es-AR, sem pedir URL', async () => {
    vi.stubGlobal('open', vi.fn(() => null));
    const { result } = renderHook(() => useOpenPatientDocument('p1'));
    await act(async () => { await result.current.openDocument('d1'); });
    expect(result.current.viewError).toContain('bloqueó la ventana emergente');
    expect(getUrl).not.toHaveBeenCalled();
  });

  it('URL falha → fecha a aba em branco e mostra o erro; novo clique bem-sucedido limpa o erro', async () => {
    const popup = makePopup();
    vi.stubGlobal('open', vi.fn(() => popup));
    getUrl.mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce({ url: 'https://signed/y', expiresInSeconds: 300 });
    const { result } = renderHook(() => useOpenPatientDocument('p1'));
    await act(async () => { await result.current.openDocument('d1'); });
    expect(result.current.viewError).toBe('No pudimos abrir el documento. Probá de nuevo.');
    expect(popup.close).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.openDocument('d1'); });
    expect(result.current.viewError).toBeNull();
  });
});
