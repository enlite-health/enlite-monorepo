import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const getProfile = vi.fn();
const getMyAreas = vi.fn();
const forceRefreshToken = vi.fn();
const getCurrentUser = vi.fn();
const initWorker = vi.fn();

vi.mock('@infrastructure/http/AdminApiService', () => ({ AdminApiService: { getProfile: (...a: unknown[]) => getProfile(...a) } }));
vi.mock('@infrastructure/http/WorkerApiService', () => ({ WorkerApiService: { initWorker: (...a: unknown[]) => initWorker(...a) } }));
vi.mock('@infrastructure/http/AreasApiService', () => ({ AreasApiService: { getMyAreas: (...a: unknown[]) => getMyAreas(...a) } }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: class {
    forceRefreshToken = (...a: unknown[]) => forceRefreshToken(...a);
    getCurrentUser = (...a: unknown[]) => getCurrentUser(...a);
  },
}));

import { useAreaDestination, NO_ACCESS_ROUTE, NO_ACCESS_UNAVAILABLE_ROUTE, readLastArea } from '../useAreaDestination';

const STAFF = { area: 'backoffice', role: 'staff', entryRoute: '/admin' };
const WORKER = { area: 'care', role: 'worker', entryRoute: '/' };
const LEARNER = { area: 'learn', role: 'learner', entryRoute: null };

const resolve = (next: string | null = null) => renderHook(() => useAreaDestination()).result.current.resolveDestination(next);
const areas = (list: unknown[], tokenRefreshRequired = false) => getMyAreas.mockResolvedValue({ areas: list, tokenRefreshRequired });

describe('useAreaDestination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    getProfile.mockResolvedValue({});
    getCurrentUser.mockResolvedValue({ id: 'uid-1', email: 'p@e2e.local' });
    initWorker.mockResolvedValue({ status: 'ok', worker: { id: 'w-1' } });
    forceRefreshToken.mockResolvedValue('t');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('só áreas sem tela (só-aluno) → /no-access?reason=unavailable', async () => {
    areas([LEARNER]);
    expect(await resolve()).toBe(NO_ACCESS_UNAVAILABLE_ROUTE);
    expect(NO_ACCESS_UNAVAILABLE_ROUTE).toBe('/no-access?reason=unavailable');
  });

  it('0 áreas e nada a provisionar (init falha) → /no-access, sem reason', async () => {
    areas([]);
    getProfile.mockRejectedValue(new Error('403'));
    initWorker.mockRejectedValue(new Error('HTTP 500'));
    const dest = await resolve();
    expect(dest).toBe(NO_ACCESS_ROUTE);
    expect(dest).not.toContain('reason');
  });

  describe('init de prestador só na lista VAZIA (login único: staff e aluno não ganham ficha)', () => {
    it('staff → sem init', async () => {
      areas([STAFF]);
      expect(await resolve()).toBe('/admin');
      expect(initWorker).not.toHaveBeenCalled();
    });

    it('aluno (só learn) → sem init', async () => {
      areas([LEARNER]);
      expect(await resolve()).toBe(NO_ACCESS_UNAVAILABLE_ROUTE);
      expect(initWorker).not.toHaveBeenCalled();
    });

    it('prestador já vinculado → sem init', async () => {
      areas([WORKER]);
      expect(await resolve()).toBe('/');
      expect(initWorker).not.toHaveBeenCalled();
    });

    it('vazio, não é staff (perfil 403) → init UMA vez com o uid/e-mail da sessão, relê as áreas → care', async () => {
      getProfile.mockRejectedValue(new Error('403'));
      getMyAreas
        .mockResolvedValueOnce({ areas: [], tokenRefreshRequired: false })
        .mockResolvedValueOnce({ areas: [WORKER], tokenRefreshRequired: true });
      expect(await resolve()).toBe('/');
      expect(initWorker).toHaveBeenCalledTimes(1);
      expect(initWorker).toHaveBeenCalledWith({ authUid: 'uid-1', email: 'p@e2e.local' });
      expect(getMyAreas).toHaveBeenCalledTimes(2);
      expect(forceRefreshToken).toHaveBeenCalledTimes(1); // o claim novo (`care`) da 2ª leitura
    });

    it('vazio com next fora de /admin (ex.: vaga) → init e o next vale', async () => {
      getProfile.mockRejectedValue(new Error('403'));
      getMyAreas
        .mockResolvedValueOnce({ areas: [], tokenRefreshRequired: false })
        .mockResolvedValueOnce({ areas: [WORKER], tokenRefreshRequired: false });
      expect(await resolve('/vacancies/12')).toBe('/vacancies/12');
      expect(initWorker).toHaveBeenCalledTimes(1);
    });

    it('vazio e o perfil provisiona (staff @enlite.health novo) → sem init, relê → backoffice', async () => {
      getMyAreas
        .mockResolvedValueOnce({ areas: [], tokenRefreshRequired: false })
        .mockResolvedValueOnce({ areas: [STAFF], tokenRefreshRequired: false });
      expect(await resolve()).toBe('/admin');
      expect(getProfile).toHaveBeenCalledTimes(1);
      expect(initWorker).not.toHaveBeenCalled();
    });

    it('init que falha → /no-access, sem reler', async () => {
      getProfile.mockRejectedValue(new Error('403'));
      areas([]);
      initWorker.mockRejectedValue(new Error('HTTP 500'));
      expect(await resolve()).toBe(NO_ACCESS_ROUTE);
      expect(getMyAreas).toHaveBeenCalledTimes(1);
    });

    it('sem sessão no Firebase → /no-access sem init', async () => {
      getProfile.mockRejectedValue(new Error('403'));
      areas([]);
      getCurrentUser.mockResolvedValue(null);
      expect(await resolve()).toBe(NO_ACCESS_ROUTE);
      expect(initWorker).not.toHaveBeenCalled();
    });

    it('vazio com next=/admin → /no-access sem init (quem veio ao painel não vira prestador)', async () => {
      areas([]);
      expect(await resolve('/admin')).toBe(NO_ACCESS_ROUTE);
      expect(initWorker).not.toHaveBeenCalled();
      expect(getMyAreas).toHaveBeenCalledTimes(1);
    });
  });

  it('1 área → entryRoute dela', async () => {
    areas([STAFF]);
    expect(await resolve()).toBe('/admin');
  });

  it('> 1 com última usada válida → ela', async () => {
    localStorage.setItem('enlite.lastArea.uid-1', 'care:worker');
    areas([STAFF, WORKER]);
    expect(await resolve()).toBe('/');
  });

  it('> 1 sem última usada (ou inválida) → a primeira da ordem estável', async () => {
    areas([STAFF, WORKER]);
    expect(await resolve()).toBe('/admin');
    localStorage.setItem('enlite.lastArea.uid-1', 'clinic:x');
    expect(await resolve()).toBe('/admin');
  });

  it('grava a área escolhida como última usada', async () => {
    areas([STAFF, WORKER]);
    await resolve();
    expect(readLastArea('uid-1')).toBe('backoffice:staff');
  });

  it('next sem acesso → /no-access (sem ir ao /admin e sem cair em silêncio na outra área)', async () => {
    areas([WORKER]);
    expect(await resolve('/admin/dashboard')).toBe(NO_ACCESS_ROUTE);
    expect(getProfile).toHaveBeenCalledTimes(1);
  });

  it('next sem acesso e sem nenhuma área → /no-access', async () => {
    areas([]);
    expect(await resolve('/admin')).toBe(NO_ACCESS_ROUTE);
  });

  it('next dentro da área da pessoa é respeitado', async () => {
    areas([STAFF, WORKER]);
    expect(await resolve('/admin/workers?x=1')).toBe('/admin/workers?x=1');
    expect(await resolve('/vacancies/12')).toBe('/vacancies/12');
  });

  it('next=/admin chama o perfil ANTES de ler as áreas', async () => {
    const order: string[] = [];
    getProfile.mockImplementation(async () => { order.push('profile'); });
    getMyAreas.mockImplementation(async () => { order.push('areas'); return { areas: [STAFF], tokenRefreshRequired: false }; });
    expect(await resolve('/admin')).toBe('/admin');
    expect(order).toEqual(['profile', 'areas']);
  });

  it('next fora de /admin não chama o perfil; perfil que falha não impede o destino', async () => {
    areas([WORKER]);
    await resolve('/');
    expect(getProfile).not.toHaveBeenCalled();
    getProfile.mockRejectedValue(new Error('403'));
    expect(await resolve('/admin')).toBe(NO_ACCESS_ROUTE); // o perfil falhou, as áreas decidem: prestador não abre /admin
  });

  it('next externo ou protocol-relative é ignorado', async () => {
    areas([WORKER]);
    expect(await resolve('//evil.test')).toBe('/');
    expect(await resolve('https://evil.test')).toBe('/');
  });

  it('tokenRefreshRequired força o refresh do token antes de devolver o destino', async () => {
    areas([STAFF], true);
    await resolve();
    expect(forceRefreshToken).toHaveBeenCalledTimes(1);
    areas([STAFF], false);
    await resolve();
    expect(forceRefreshToken).toHaveBeenCalledTimes(1);
  });

  it('localStorage que lança não quebra a decisão', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    areas([STAFF, WORKER]);
    expect(await resolve()).toBe('/admin');
  });

  it('erro da API de áreas propaga (nunca vira lista vazia → /no-access)', async () => {
    getMyAreas.mockRejectedValue(new Error('HTTP 500'));
    await expect(resolve()).rejects.toThrow('HTTP 500');
  });
});
