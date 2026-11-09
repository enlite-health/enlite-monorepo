import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const getProfile = vi.fn();
const getMyAreas = vi.fn();
const forceRefreshToken = vi.fn();
const getCurrentUser = vi.fn();

vi.mock('@infrastructure/http/AdminApiService', () => ({ AdminApiService: { getProfile: (...a: unknown[]) => getProfile(...a) } }));
vi.mock('@infrastructure/http/AreasApiService', () => ({ AreasApiService: { getMyAreas: (...a: unknown[]) => getMyAreas(...a) } }));
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: class {
    forceRefreshToken = (...a: unknown[]) => forceRefreshToken(...a);
    getCurrentUser = (...a: unknown[]) => getCurrentUser(...a);
  },
}));

import { useAreaDestination, NO_ACCESS_ROUTE, readLastArea } from '../useAreaDestination';

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
    getCurrentUser.mockResolvedValue({ id: 'uid-1' });
    forceRefreshToken.mockResolvedValue('t');
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('0 áreas navegáveis → /no-access (área sem tela não conta)', async () => {
    areas([LEARNER]);
    expect(await resolve()).toBe(NO_ACCESS_ROUTE);
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

  it('next sem acesso é ignorado e cai no destino por área (sem ir ao /admin)', async () => {
    areas([WORKER]);
    expect(await resolve('/admin/dashboard')).toBe('/');
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
    expect(await resolve('/admin')).toBe('/');
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
