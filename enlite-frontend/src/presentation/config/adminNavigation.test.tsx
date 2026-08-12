/**
 * adminNavigation.test.tsx
 *
 * Verifica que:
 *  - Admin (role===ADMIN) recebe adminItems com sectionStart no 1º item
 *  - Não-admin NÃO recebe adminItems (logo sem sectionStart)
 */

import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAdminNavItems } from './adminNavigation';
import { EnliteRole } from '@domain/entities/EnliteRole';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@presentation/hooks/useAdminAuth', () => ({
  useAdminAuth: vi.fn(),
}));

import { useAdminAuth } from '@presentation/hooks/useAdminAuth';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useAdminNavItems — sectionStart nos adminItems', () => {
  it('admin (ADMIN role) recebe sectionStart no primeiro adminItem', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.ADMIN } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    // Deve existir pelo menos 1 adminItem
    const adminItems = items.filter((item) => item.sectionStart !== undefined);
    expect(adminItems.length).toBeGreaterThan(0);

    // O primeiro adminItem deve ter sectionStart preenchido
    const firstAdminItem = adminItems[0];
    expect(firstAdminItem.sectionStart).toBeTruthy();
    // O valor deve conter "Administr" (es: "Administración" / pt-BR: "Administração")
    expect(firstAdminItem.sectionStart).toMatch(/Administr/i);
  });

  it('admin recebe Etiquetas como primeiro item admin', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.ADMIN } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    const firstWithSection = items.find((item) => item.sectionStart !== undefined);
    expect(firstWithSection).toBeDefined();
    // O item com sectionStart é "Etiquetas" (ou equivalente i18n)
    expect(firstWithSection?.href).toBe('/admin/tags');
  });

  it('não-admin (RECRUITER) NÃO recebe nenhum item com sectionStart', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.RECRUITER } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    const withSection = items.filter((item) => item.sectionStart !== undefined);
    expect(withSection).toHaveLength(0);
  });

  it('sem perfil (null) NÃO recebe nenhum item com sectionStart', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: null,
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    const withSection = items.filter((item) => item.sectionStart !== undefined);
    expect(withSection).toHaveLength(0);
  });
});

describe('useAdminNavItems — Postulaciones bloqueadas é admin-only', () => {
  const BLOCKED_HREF = '/admin/recruitment/blocked-attempts';

  it('admin vê o item dentro da seção Administración (após o primeiro sectionStart)', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.ADMIN } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    const blockedIdx = items.findIndex((item) => item.href === BLOCKED_HREF);
    const sectionIdx = items.findIndex((item) => item.sectionStart !== undefined);

    expect(blockedIdx).toBeGreaterThan(-1);
    expect(sectionIdx).toBeGreaterThan(-1);
    // O item de bloqueadas fica DENTRO da seção admin (no ou após o item que abre a seção)
    expect(blockedIdx).toBeGreaterThanOrEqual(sectionIdx);
  });

  it('não-admin (RECRUITER) NÃO vê o item de postulaciones bloqueadas', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: { role: EnliteRole.RECRUITER } as ReturnType<typeof useAdminAuth>['adminProfile'],
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    expect(items.some((item) => item.href === BLOCKED_HREF)).toBe(false);
  });

  it('sem perfil (null) NÃO vê o item de postulaciones bloqueadas', () => {
    vi.mocked(useAdminAuth).mockReturnValue({
      adminProfile: null,
    } as ReturnType<typeof useAdminAuth>);

    const { result } = renderHook(() => useAdminNavItems());
    const items = result.current;

    expect(items.some((item) => item.href === BLOCKED_HREF)).toBe(false);
  });
});
