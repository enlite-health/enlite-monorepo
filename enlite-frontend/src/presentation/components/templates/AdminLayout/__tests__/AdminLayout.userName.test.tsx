import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AdminLayout } from '../AdminLayout';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('@presentation/hooks/useAdminAuth', () => ({ useAdminAuth: () => ({ logout: vi.fn(), adminProfile: { displayName: 'Admin Enlite' } }) }));
vi.mock('@presentation/components/templates/DashboardLayout', () => ({
  AppSidebar: ({ userName }: { userName: string }) => <nav data-testid="sidebar">{userName}</nav>,
}));

describe('AdminLayout — nome na sidebar', () => {
  it('perfil sem displayName nem e-mail cai em "Admin"', () => {
    render(<MemoryRouter initialEntries={['/admin']}><Routes><Route path="/admin" element={<AdminLayout />}><Route index element={<div />} /></Route></Routes></MemoryRouter>);
    expect(screen.getByTestId('sidebar')).toHaveTextContent('Admin');
  });
});
