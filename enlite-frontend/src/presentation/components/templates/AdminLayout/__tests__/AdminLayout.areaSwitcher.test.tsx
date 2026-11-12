/** F4 (T409): o `AdminLayout` monta a tira do seletor de área dentro do <main>. */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('@presentation/hooks/useAdminAuth', () => ({ useAdminAuth: () => ({ logout: vi.fn(), adminProfile: null, user: null }) }));
vi.mock('@presentation/config/adminNavigation', () => ({ useAdminNavItems: () => [] }));
vi.mock('@presentation/components/templates/DashboardLayout', () => ({ AppSidebar: () => <aside /> }));
vi.mock('@presentation/components/features/assistants/AssistantsWidget', () => ({ AssistantsWidget: () => null }));
vi.mock('@presentation/components/features/areas/AreaSwitcherSlot', () => ({
  AreaSwitcherSlot: () => <div data-testid="area-switcher-slot" />,
}));

import { AdminLayout } from '../AdminLayout';

describe('AdminLayout — seletor de área', () => {
  it('monta o encaixe do seletor dentro do <main>', () => {
    render(
      <MemoryRouter initialEntries={['/admin/x']}>
        <Routes>
          <Route element={<AdminLayout />}>
            <Route path="/admin/x" element={<div />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('area-switcher-slot').closest('main')).not.toBeNull();
  });
});
