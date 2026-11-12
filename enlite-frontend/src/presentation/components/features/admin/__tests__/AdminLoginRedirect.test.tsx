import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { AdminLoginRedirect } from '../AdminLoginRedirect';
import { adminLoginPath } from '@presentation/config/adminLoginPath';

function Destino() {
  const l = useLocation();
  return <div data-testid="destino">{l.pathname + l.search}</div>;
}

function ir(inicial: string) {
  const { unmount } = render(
    <MemoryRouter initialEntries={[inicial]}>
      <Routes>
        <Route path="/admin/login" element={<AdminLoginRedirect />} />
        <Route path="/login" element={<Destino />} />
      </Routes>
    </MemoryRouter>,
  );
  const destino = screen.getByTestId('destino').textContent;
  unmount();
  return destino;
}

describe('AdminLoginRedirect (/admin/login → login único)', () => {
  it('sem next → /login?next=%2Fadmin', () => {
    expect(ir('/admin/login')).toBe('/login?next=%2Fadmin');
  });

  it('preserva o next de origem: /admin/login?next=/admin/x → /login?next=%2Fadmin%2Fx', () => {
    expect(ir('/admin/login?next=/admin/x')).toBe('/login?next=%2Fadmin%2Fx');
  });

  it('next externo ou protocol-relative é descartado → /login?next=%2Fadmin', () => {
    expect(ir('/admin/login?next=//evil.test')).toBe('/login?next=%2Fadmin');
    expect(ir('/admin/login?next=https://evil.test')).toBe('/login?next=%2Fadmin');
  });

  it('adminLoginPath codifica o destino', () => {
    expect(adminLoginPath('/admin/a?b=1')).toBe('/login?next=%2Fadmin%2Fa%3Fb%3D1');
  });
});
